/**
 * Ghost-reservation release, across the three fingerprint generations.
 *
 * Widening duplicate lookup to V0/V1/V2 made the old recovery path dangerous.
 * It asked "is this a duplicate?" and then "are its items persisted?", and
 * deleted the reservation when the second answer was no. But `computeItemHash`
 * folds `session_title` — the market label — into every item hash, so a session
 * persisted under `พาซีโอ้` can never be recognised from a resend under the
 * reviewed canonical `พาซิโอ้`. The old code read that as a ghost and deleted
 * real evidence, letting the duplicate withdrawal persist a second time.
 *
 * Release is therefore ownership-based now. Each case below fixes one half of
 * that: historical evidence survives, and a genuine current-generation ghost is
 * still recoverable.
 */
import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import {
  SessionDedupService,
  computeItemHash,
  computeLegacySessionHash,
  computeSessionHash,
  sessionHashReservations,
} from "./session-dedup-service";
import { weighSessionLegacyMarketFingerprint } from "@/lib/produce/business-fingerprint";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_GENERATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Reservation {
  id: string;
  session_hash: string;
  reserved_by_generation: string | null;
}

/**
 * imported_sessions and produce_items, with the two operations the service
 * uses: `in`-filtered select, and `in` + `eq`-filtered delete.
 */
class FakeDb {
  reservations: Reservation[] = [];
  itemHashes: string[] = [];
  private seq = 0;

  reserve(hash: string, generation: string | null): Reservation {
    this.seq += 1;
    const row = { id: `res-${this.seq}`, session_hash: hash, reserved_by_generation: generation };
    this.reservations.push(row);
    return row;
  }

  client(): AnyClient {
    return { from: (table: string) => this.from(table) } as unknown as AnyClient;
  }

  private from(table: string) {
    if (table === "produce_items") {
      let wanted: string[] = [];
      const builder = {
        select: () => builder,
        in: (_c: string, values: string[]) => { wanted = values; return builder; },
        limit: () => Promise.resolve({
          data: this.itemHashes.filter((h) => wanted.includes(h)).map((h) => ({ id: h })),
          error: null,
        }),
      };
      return builder;
    }

    if (table === "imported_sessions") {
      let wanted: string[] = [];
      let generation: string | null | undefined;
      let mode: "select" | "delete" = "select";
      const matched = () => this.reservations.filter(
        (row) => wanted.includes(row.session_hash)
          && (generation === undefined || row.reserved_by_generation === generation),
      );
      const builder = {
        select: () => {
          if (mode === "delete") {
            const removed = matched();
            this.reservations = this.reservations.filter((r) => !removed.includes(r));
            return Promise.resolve({ data: removed.map((r) => ({ id: r.id })), error: null });
          }
          return builder;
        },
        delete: () => { mode = "delete"; return builder; },
        in: (_c: string, values: string[]) => { wanted = values; return builder; },
        eq: (_c: string, value: string) => { generation = value; return builder; },
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
      };
      return builder;
    }

    throw new Error(`unexpected table ${table}`);
  }
}

function item(overrides: Partial<WeighSessionItem> & { product_name: string }): WeighSessionItem {
  return {
    item_number: 1,
    price_per_unit: 100,
    quantity: 3,
    unit: "โล",
    section: "main",
    transaction_type: "เบิก",
    pricing_mode: "unit",
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
    ...overrides,
  };
}

/** The same business document, told under one market spelling or another. */
function document(marketLabel: string, staff = "ต้อม"): WeighSession {
  return {
    date: "2026-08-15",
    staff_name: staff,
    sender_name: null,
    transaction_time: "06:00",
    session_title: marketLabel,
    session_kind: "main",
    declared_transaction_type: "เบิก",
    items: [item({ product_name: "อะโวคาโด" })],
    parse_errors: [],
  };
}

/**
 * A completed historical session: its V1 reservation (written by the previous
 * release, so no provenance) plus the item hashes it actually persisted, which
 * carry the historical market spelling.
 */
function persistHistorically(db: FakeDb, historical: WeighSession): string {
  const v1 = weighSessionLegacyMarketFingerprint(historical);
  db.reserve(v1, null);
  for (const entry of historical.items) db.itemHashes.push(computeItemHash(historical, entry));
  return v1;
}

/** The recovery path exactly as webhook-service runs it. */
async function ghostRecovery(
  dedup: SessionDedupService,
  parsed: WeighSession,
  currentGeneration: string | null,
) {
  const match = await dedup.findDuplicate(parsed, currentGeneration);
  let isDuplicate = match !== null;
  let released = 0;
  if (match?.releasableByCurrentAttempt && !(await dedup.hasPersistedItems(parsed))) {
    released = await dedup.release(parsed, match.reservedByGeneration);
    isDuplicate = false;
  }
  return { match, isDuplicate, released };
}

// ── CASES 1–3: historical evidence under a reviewed alias ────────────────────

const ALIAS_FAMILIES: Array<{ label: string; historical: string; canonical: string; staff: string }> = [
  { label: "CASE 1 — ต้อม / พาซีโอ้", historical: "พาซีโอ้", canonical: "พาซิโอ้", staff: "ต้อม" },
  { label: "CASE 2 — แทน / ราชพฤก", historical: "ราชพฤก", canonical: "ราชพฤกษ์", staff: "แทน" },
  { label: "CASE 3 — วุฒิ / เลียบทางด่วน", historical: "เลียบทางด่วน", canonical: "เลียบด่วน", staff: "วุฒิ" },
];

describe("historical V1 evidence survives a canonical resend", () => {
  for (const family of ALIAS_FAMILIES) {
    it(`${family.label} → ${family.canonical}`, async () => {
      const db = new FakeDb();
      const historical = document(family.historical, family.staff);
      const v1 = persistHistorically(db, historical);

      const incoming = document(family.canonical, family.staff);
      // The premise: the resend's own reservation set contains that V1 hash...
      expect(sessionHashReservations(incoming)).toContain(v1);
      // ...and its item hashes genuinely cannot see the historical rows.
      expect(await new SessionDedupService(db.client()).hasPersistedItems(incoming)).toBe(false);

      const dedup = new SessionDedupService(db.client());
      const result = await ghostRecovery(dedup, incoming, GENERATION);

      expect(result.isDuplicate).toBe(true);
      expect(result.released).toBe(0);
      expect(result.match).toMatchObject({
        matchedHash: v1,
        fingerprintGeneration: "V1",
        reservedByGeneration: null,
        releasableByCurrentAttempt: false,
      });
      // The historical reservation is still there.
      expect(db.reservations.map((r) => r.session_hash)).toEqual([v1]);
    });
  }
});

// ── CASE 4: a genuine current-generation ghost ───────────────────────────────

describe("CASE 4 — current-generation ghost recovery still works", () => {
  it("releases a reservation this attempt owns when nothing persisted", async () => {
    const db = new FakeDb();
    const parsed = document("พาซิโอ้");
    db.reserve(computeSessionHash(parsed), GENERATION);

    const result = await ghostRecovery(new SessionDedupService(db.client()), parsed, GENERATION);

    expect(result.match).toMatchObject({
      fingerprintGeneration: "V2",
      reservedByGeneration: GENERATION,
      releasableByCurrentAttempt: true,
    });
    expect(result.isDuplicate).toBe(false);
    expect(result.released).toBeGreaterThan(0);
    expect(db.reservations).toHaveLength(0);
  });

  it("refuses to release a reservation owned by a DIFFERENT generation", async () => {
    const db = new FakeDb();
    const parsed = document("พาซิโอ้");
    db.reserve(computeSessionHash(parsed), OTHER_GENERATION);

    const result = await ghostRecovery(new SessionDedupService(db.client()), parsed, GENERATION);

    expect(result.match?.releasableByCurrentAttempt).toBe(false);
    expect(result.isDuplicate).toBe(true);
    expect(db.reservations).toHaveLength(1);
  });

  it("keeps its own reservation when the items DID persist", async () => {
    const db = new FakeDb();
    const parsed = document("พาซิโอ้");
    db.reserve(computeSessionHash(parsed), GENERATION);
    for (const entry of parsed.items) db.itemHashes.push(computeItemHash(parsed, entry));

    const result = await ghostRecovery(new SessionDedupService(db.client()), parsed, GENERATION);

    expect(result.isDuplicate).toBe(true);
    expect(db.reservations).toHaveLength(1);
  });
});

// ── CASE 5: V0 ───────────────────────────────────────────────────────────────

describe("CASE 5 — a V0 legacy match is read-only history", () => {
  it("is detected, reported as V0, and never deleted", async () => {
    const db = new FakeDb();
    const parsed = document("พาซิโอ้");
    const v0 = computeLegacySessionHash(parsed);
    db.reserve(v0, null);

    const result = await ghostRecovery(new SessionDedupService(db.client()), parsed, GENERATION);

    expect(result.match).toMatchObject({
      matchedHash: v0,
      fingerprintGeneration: "V0",
      releasableByCurrentAttempt: false,
    });
    expect(result.isDuplicate).toBe(true);
    expect(db.reservations).toHaveLength(1);
  });

  it("is never in the reservation set, so release cannot reach it even when owned", async () => {
    const db = new FakeDb();
    const parsed = document("พาซิโอ้");
    const v0 = computeLegacySessionHash(parsed);
    // Even mis-stamped with the current generation, V0 is not releasable:
    // release only ever targets what this code writes.
    db.reserve(v0, GENERATION);

    expect(sessionHashReservations(parsed)).not.toContain(v0);
    await new SessionDedupService(db.client()).release(parsed, GENERATION);
    expect(db.reservations).toHaveLength(1);
  });
});

// ── CASE 6: ordinary V2 ──────────────────────────────────────────────────────

describe("CASE 6 — ordinary V2 duplicate behaviour is unchanged", () => {
  it("a historical V2 reservation blocks the resend and survives", async () => {
    const db = new FakeDb();
    const parsed = document("พาซิโอ้");
    db.reserve(computeSessionHash(parsed), null);

    const result = await ghostRecovery(new SessionDedupService(db.client()), parsed, GENERATION);

    expect(result.match?.fingerprintGeneration).toBe("V2");
    expect(result.isDuplicate).toBe(true);
    expect(db.reservations).toHaveLength(1);
  });

  it("a document nobody has sent is not a duplicate", async () => {
    const db = new FakeDb();
    const result = await ghostRecovery(
      new SessionDedupService(db.client()),
      document("พาซิโอ้"),
      GENERATION,
    );
    expect(result.match).toBeNull();
    expect(result.isDuplicate).toBe(false);
  });
});

// ── The rule itself ──────────────────────────────────────────────────────────

describe("release requires provable ownership", () => {
  it("deletes nothing at all without a generation", async () => {
    const db = new FakeDb();
    const parsed = document("พาซิโอ้");
    db.reserve(computeSessionHash(parsed), null);
    db.reserve(weighSessionLegacyMarketFingerprint(document("พาซีโอ้")), null);

    expect(await new SessionDedupService(db.client()).release(parsed, null)).toBe(0);
    expect(await new SessionDedupService(db.client()).release(parsed, undefined)).toBe(0);
    expect(db.reservations).toHaveLength(2);
  });

  it("never deletes an unstamped row even when a generation is supplied", async () => {
    const db = new FakeDb();
    const parsed = document("พาซิโอ้");
    db.reserve(computeSessionHash(parsed), null);

    expect(await new SessionDedupService(db.client()).release(parsed, GENERATION)).toBe(0);
    expect(db.reservations).toHaveLength(1);
  });
});
