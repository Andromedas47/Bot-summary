/**
 * The supersession proof boundary (P1-A).
 *
 * Everything here is about what may NOT be terminalized. Acting on a wrong
 * supersession loses a real operator's unfinished document, so each test names
 * the dimension that has to stop it.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import {
  isContentSuperseded,
  provesSupersession,
  supersedeReplacedPendingGenerations,
  type SupersessionSuccessor,
} from "@/lib/produce/pending-supersession";
import type { ProduceFailureAttempt } from "@/lib/produce/failure-lifecycle";
import type { TransactionBucket } from "@/lib/summary/transactions";

const ISO_DATE = "2026-08-16";
const DATE = "16/8/2569";
const SOURCE = "C14f5c6d51f7b8ef458e18aa44461b5bd";

const DURIAN = ["1.หมอนทอง100บาท", "3.9โล", "2.หมอนทอง100บาท", "23.2โล"];
const DRY_GOODS = ["3.กระชาย20บาท", "6แพค", "4.มะนาว50บาท", "3โล"];

interface DocOptions {
  seller?: string;
  market?: string;
  date?: string;
  head?: string;
  rows?: string[];
}

function doc(options: DocOptions = {}): WeighSession {
  const head = options.head ?? "เบิก";
  return parseWeighSession(
    [
      `${options.seller ?? "มิ้น"}-${options.market ?? "ทรัพย์พัน"} ${head} ${options.date ?? DATE}`,
      ...(options.rows ?? DURIAN),
      `จบรายการ${head}`,
    ].join("\n"),
    ISO_DATE,
  );
}

function attempt(
  parsed: WeighSession,
  overrides: Partial<ProduceFailureAttempt> = {},
): ProduceFailureAttempt {
  return {
    attemptId: "attempt-1",
    origin: "pending_session",
    businessDate: parsed.date,
    sourceId: SOURCE,
    staffLabel: parsed.staff_name,
    marketLabel: parsed.session_title,
    transactionKind: "เบิก" as TransactionBucket,
    accountabilityRoundId: null,
    attemptedAtMs: 1_000,
    ...overrides,
  };
}

function successor(
  parsed: WeighSession,
  overrides: Partial<SupersessionSuccessor> = {},
): SupersessionSuccessor {
  return {
    produceSessionId: "produce-1",
    sessionKey: "group:C:user:B",
    sessionGeneration: "gen-b",
    sourceId: SOURCE,
    parsed,
    finalizedAtMs: 2_000,
    accountabilityRoundId: null,
    ...overrides,
  };
}

describe("content proof", () => {
  it("accepts an identical document", () => {
    expect(isContentSuperseded(doc(), doc())).toBe(true);
  });

  it("accepts an attempt entirely represented in the successor", () => {
    expect(isContentSuperseded(doc(), doc({ rows: [...DURIAN, ...DRY_GOODS] }))).toBe(true);
  });

  it("refuses when the successor carries different rows", () => {
    expect(isContentSuperseded(doc(), doc({ rows: DRY_GOODS }))).toBe(false);
  });

  it("refuses an attempt with no items — an empty multiset proves nothing", () => {
    const empty = parseWeighSession("มิ้น-ทรัพย์พัน เบิก 16/8/2569", ISO_DATE);
    expect(empty.items).toHaveLength(0);
    expect(isContentSuperseded(empty, doc())).toBe(false);
  });
});

describe("supersession proof", () => {
  it("CASE 1 — an exact corrected replacement supersedes", () => {
    expect(provesSupersession(attempt(doc()), doc(), successor(doc()))).toBe(true);
  });

  it("CASE 2 — a superset replacement with provable lineage supersedes", () => {
    const corrected = doc({ rows: [...DURIAN, ...DRY_GOODS] });
    expect(provesSupersession(attempt(doc()), doc(), successor(corrected))).toBe(true);
  });

  it("CASE 3 — an unrelated successful session leaves the attempt active", () => {
    const unrelated = doc({ rows: DRY_GOODS });
    expect(provesSupersession(attempt(doc()), doc(), successor(unrelated))).toBe(false);
  });

  it("CASE 4 — a different market leaves the attempt active", () => {
    const other = doc({ market: "ตลาด72" });
    expect(provesSupersession(attempt(doc()), doc(), successor(other))).toBe(false);
  });

  it("CASE 5 — a different business date leaves the attempt active", () => {
    const other = doc({ date: "15/8/2569" });
    expect(provesSupersession(attempt(doc()), doc(), successor(other))).toBe(false);
  });

  it("CASE 6 — the มิ้น sections do NOT supersede each other", () => {
    // Two plain เบิก documents of one real round: 3 durian rows, then 13 dry
    // goods. Every identity dimension matches, so only the content rule stops
    // the second from silently retiring the first.
    const durianSection = doc({ rows: DURIAN });
    const dryGoodsSection = doc({ rows: DRY_GOODS });
    expect(provesSupersession(
      attempt(durianSection),
      durianSection,
      successor(dryGoodsSection),
    )).toBe(false);
  });

  it("a reviewed market alias is the same market — พาซีโอ้ then พาซิโอ้", () => {
    // The attempt was typed under the alias spelling and the correction under
    // the canonical one. Comparing raw normalized labels made this unprovable
    // and left a resolved attempt sitting active forever.
    const attemptDoc = doc({ market: "พาซีโอ้" });
    const successorDoc = doc({ market: "พาซิโอ้" });
    expect(provesSupersession(
      attempt(attemptDoc),
      attemptDoc,
      successor(successorDoc),
    )).toBe(true);
  });

  it("the other reviewed spelling พาสิโอ้ resolves too", () => {
    const attemptDoc = doc({ market: "พาสิโอ้" });
    const successorDoc = doc({ market: "พาซิโอ้" });
    expect(provesSupersession(attempt(attemptDoc), attemptDoc, successor(successorDoc)))
      .toBe(true);
  });

  it("an UNREVIEWED near-miss is still its own market — no fuzzy matching", () => {
    const attemptDoc = doc({ market: "พาชิโอ้" });
    const successorDoc = doc({ market: "พาซิโอ้" });
    expect(provesSupersession(attempt(attemptDoc), attemptDoc, successor(successorDoc)))
      .toBe(false);
  });

  it("reviewed markets the catalog keeps apart never supersede each other", () => {
    const vegetables = doc({ market: "พาซิโอ้ผัก" });
    const fruit = doc({ market: "พาซิโอ้ผลไม้" });
    expect(provesSupersession(attempt(vegetables), vegetables, successor(fruit)))
      .toBe(false);
  });

  it("CASE 7 — a cross-user replacement with proof may supersede", () => {
    // The attempt and the successor come from different LINE accounts in the
    // same group. The sender is not an identity dimension; the source is.
    expect(provesSupersession(
      attempt(doc()),
      doc(),
      successor(doc(), { sessionKey: "group:C:user:OTHER" }),
    )).toBe(true);
  });

  it("refuses a successor from another LINE source", () => {
    expect(provesSupersession(
      attempt(doc()),
      doc(),
      successor(doc(), { sourceId: "C-other" }),
    )).toBe(false);
  });

  it("refuses a successor that landed BEFORE the attempt", () => {
    expect(provesSupersession(
      attempt(doc()),
      doc(),
      successor(doc(), { finalizedAtMs: 500 }),
    )).toBe(false);
  });

  it("refuses when the attempt declares no single transaction kind", () => {
    expect(provesSupersession(
      attempt(doc(), { transactionKind: null }),
      doc(),
      successor(doc()),
    )).toBe(false);
  });

  it("refuses a return against a withdrawal successor", () => {
    const ret = doc({ head: "ชั่งคืน" });
    expect(provesSupersession(
      attempt(ret, { transactionKind: "คืน" as TransactionBucket }),
      ret,
      successor(doc()),
    )).toBe(false);
  });

  it("refuses an ADDITIONAL successor — an append never replaces", () => {
    const append = doc({ head: "เบิกเพิ่ม" });
    expect(append.session_kind).toBe("additional");
    expect(provesSupersession(attempt(doc()), doc(), successor(append))).toBe(false);
  });

  it("a bound attempt requires the successor's exact round", () => {
    const bound = attempt(doc(), { accountabilityRoundId: "round-a" });
    expect(provesSupersession(bound, doc(), successor(doc(), {
      accountabilityRoundId: "round-b",
    }))).toBe(false);
    expect(provesSupersession(bound, doc(), successor(doc(), {
      accountabilityRoundId: "round-a",
    }))).toBe(true);
  });

  it("refuses when the attempt has no provable business identity", () => {
    for (const missing of ["sourceId", "businessDate", "marketLabel", "staffLabel"] as const) {
      expect(provesSupersession(
        attempt(doc(), { [missing]: null }),
        doc(),
        successor(doc()),
      )).toBe(false);
    }
  });
});

/**
 * Minimal client: the successor's `finalized_at` read-back, the candidate
 * SELECT, and the RPC. `finalizedAt` is what the database says, which is the
 * only thing the sweep is allowed to order by.
 */
function fakeDb(
  rows: Array<Record<string, unknown>>,
  finalizedAt: string | null = new Date(2_000).toISOString(),
) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    from(table: string) {
      const payload = table === "produce_sessions"
        ? [{ finalized_at: finalizedAt }]
        : rows;
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: () => Promise.resolve({ data: payload, error: null }),
      };
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, ...args });
      return Promise.resolve({
        data: { superseded: true, round_outcome: "cancelled" },
        error: null,
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function pendingRow(text: string, overrides: Record<string, unknown> = {}) {
  return {
    session_key: "group:C:user:A",
    session_generation: "gen-a",
    source_id: SOURCE,
    accumulated_text: text,
    updated_at: new Date(1_000).toISOString(),
    accountability_round_id: null,
    ...overrides,
  };
}

function documentText(options: DocOptions = {}): string {
  const head = options.head ?? "เบิก";
  return [
    `${options.seller ?? "มิ้น"}-${options.market ?? "ทรัพย์พัน"} ${head} ${options.date ?? DATE}`,
    ...(options.rows ?? DURIAN),
    `จบรายการ${head}`,
  ].join("\n");
}

describe("sweep", () => {
  it("CASE 8 — supersedes a proven attempt and reports the round outcome", async () => {
    const db = fakeDb([pendingRow(documentText())]);
    const outcomes = await supersedeReplacedPendingGenerations(db, successor(doc()));

    expect(outcomes).toEqual([{
      sessionKey: "group:C:user:A",
      sessionGeneration: "gen-a",
      superseded: true,
      reason: "superseded",
      roundOutcome: "cancelled",
    }]);
    expect(db.calls[0]).toMatchObject({
      name: "supersede_pending_generation",
      p_session_key: "group:C:user:A",
      p_session_generation: "gen-a",
      p_superseded_by: "produce-1",
    });
  });

  it("never touches the successor's own generation", async () => {
    const db = fakeDb([pendingRow(documentText(), { session_key: "group:C:user:B" })]);
    expect(await supersedeReplacedPendingGenerations(db, successor(doc()))).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("CASE 9 — leaves an unprovable attempt completely alone", async () => {
    const db = fakeDb([pendingRow(documentText({ rows: DRY_GOODS }))]);
    expect(await supersedeReplacedPendingGenerations(db, successor(doc()))).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("CASE 10 — an unparseable attempt stays review-required", async () => {
    const db = fakeDb([pendingRow("ข้อความที่อ่านไม่ออก")]);
    expect(await supersedeReplacedPendingGenerations(db, successor(doc()))).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });
});

/**
 * Ordering comes from the database, never from the clock.
 *
 * The sweep runs AFTER the produce write commits, so a wall-clock reading taken
 * inside the sweep is always later than the real finalization. Every case here
 * is one that a `Date.now()` boundary would get wrong, and each wrong answer
 * costs an operator a document they are still working on.
 */
describe("ordering boundary", () => {
  const FINALIZED_AT = new Date(2_000).toISOString();

  it("A — a candidate updated AFTER the successor finalized is NOT superseded", async () => {
    // Opened before the successor, edited after it. created_at would say
    // "older", which is exactly the false proof this guards against.
    const db = fakeDb(
      [pendingRow(documentText(), { updated_at: new Date(3_000).toISOString() })],
      FINALIZED_AT,
    );
    expect(await supersedeReplacedPendingGenerations(db, successor(doc()))).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("B — a candidate created and updated BEFORE the successor may be superseded", async () => {
    const db = fakeDb(
      [pendingRow(documentText(), { updated_at: new Date(1_500).toISOString() })],
      FINALIZED_AT,
    );
    const outcomes = await supersedeReplacedPendingGenerations(db, successor(doc()));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.superseded).toBe(true);
  });

  it("C — a pending opened AFTER the successor persisted is NOT superseded", async () => {
    // The race the sweep itself creates: the document lands, an operator starts
    // the identical entry, and only then does the sweep run.
    const db = fakeDb(
      [pendingRow(documentText(), {
        session_key: "group:C:user:NEW",
        session_generation: "gen-new",
        updated_at: new Date(2_500).toISOString(),
      })],
      FINALIZED_AT,
    );
    expect(await supersedeReplacedPendingGenerations(db, successor(doc()))).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("D — equal timestamps prove nothing", async () => {
    const db = fakeDb([pendingRow(documentText(), { updated_at: FINALIZED_AT })], FINALIZED_AT);
    expect(await supersedeReplacedPendingGenerations(db, successor(doc()))).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("E — no authoritative finalized_at means the sweep does nothing", async () => {
    for (const missing of [null, "", "not-a-timestamp"]) {
      const db = fakeDb([pendingRow(documentText())], missing);
      expect(await supersedeReplacedPendingGenerations(db, successor(doc()))).toEqual([]);
      expect(db.calls).toHaveLength(0);
    }
  });

  it("a caller-supplied timestamp is ignored — only the database decides", async () => {
    // The successor object still carries a `finalizedAtMs` field because the
    // pure predicate takes one. If the sweep read it instead of the database,
    // this wall-clock-shaped value would prove the supersession.
    const db = fakeDb(
      [pendingRow(documentText(), { updated_at: new Date(3_000).toISOString() })],
      FINALIZED_AT,
    );
    const outcomes = await supersedeReplacedPendingGenerations(
      db,
      successor(doc(), { finalizedAtMs: 9_999_999 }),
    );
    expect(outcomes).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("a candidate with no usable updated_at stays active", async () => {
    for (const missing of [null, "", "not-a-timestamp"]) {
      const db = fakeDb([pendingRow(documentText(), { updated_at: missing })], FINALIZED_AT);
      expect(await supersedeReplacedPendingGenerations(db, successor(doc()))).toEqual([]);
      expect(db.calls).toHaveLength(0);
    }
  });
});
