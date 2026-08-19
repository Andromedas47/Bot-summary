import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import {
  weighSessionBusinessFingerprint,
  weighSessionCompatibilityFingerprints,
} from "@/lib/produce/business-fingerprint";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

function canonicalItem(item: WeighSessionItem): string {
  return [
    item.item_number,
    item.product_name,
    item.price_per_unit,
    item.quantity ?? "",
    item.unit     ?? "",
    item.transaction_type,
  ].join("|");
}

/**
 * The pre-2026-08-15 session hash: raw parsed strings, ordered by item number.
 *
 * It is no longer written. It is still READ, because every imported_sessions
 * row created before the canonical fingerprint shipped carries one, and the
 * lost-produce reconciliation proves a historical raw message was imported by
 * matching its hash. Removing it would turn every such row into a false
 * "produce never landed" report. Nothing new is ever recorded under it.
 */
export function computeLegacySessionHash(parsed: WeighSession): string {
  const sortedTxTypes = [...new Set(parsed.items.map((i) => i.transaction_type))].sort().join(",");

  const itemLines = [...parsed.items]
    .sort((a, b) => (a.item_number ?? 0) - (b.item_number ?? 0))
    .map(canonicalItem)
    .join("\n");

  const canonical = [
    parsed.date         ?? "",
    parsed.staff_name,
    parsed.session_title ?? "",
    sortedTxTypes,
    itemLines,
  ].join("||");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The duplicate identity of a produce document: canonical business content
 * only, with no LINE source, event or user in it. See business-fingerprint.ts.
 *
 * imported_sessions.session_hash is UNIQUE, so this is also the concurrency
 * primitive — the INSERT ... ON CONFLICT DO NOTHING inside
 * try_finalize_pending_generation is what makes two simultaneous identical
 * submissions collapse to one persisted withdrawal.
 */
export function computeSessionHash(parsed: WeighSession): string {
  return weighSessionBusinessFingerprint(parsed);
}

/**
 * The hashes this attempt RESERVES: the V2 identity first, then the V1
 * fingerprints of the same document under the market's other reviewed
 * spellings.
 *
 * Reserving the V1 class — not merely reading it — is what makes the rollout
 * safe. During a rolling deploy the previous build is still writing V1 hashes;
 * if the new build only read them, two concurrent submissions of one document
 * could each find nothing and both persist. Reserving puts both builds on the
 * same UNIQUE index, so exactly one wins. See business-fingerprint.ts for the
 * V0/V1/V2 definitions.
 *
 * V0 is deliberately absent: it is never written any more, and deleting a
 * historical V0 row on a failed attempt would erase another session's proof.
 */
export function sessionHashReservations(parsed: WeighSession): string[] {
  return [
    ...new Set([
      computeSessionHash(parsed),
      ...weighSessionCompatibilityFingerprints(parsed),
    ]),
  ];
}

/**
 * The same document as the pre-2026-08-19 parser would have priced it, or null
 * if no subunit conversion touched it.
 *
 * Until that fix, a quantity line in ขีด/กรัม/มิลลิลิตร also divided
 * price_per_unit by the conversion factor, so a "120บาท / 0.7ขีด" withdrawal
 * was recorded as 1200. Every fingerprint generation folds price_per_unit in,
 * which means those already-imported documents are reserved under the old
 * price. This rebuilds that historical identity — for LOOKUP only — from the
 * evidence the parser carries on each converted item.
 */
export function legacySubunitPricedSession(parsed: WeighSession): WeighSession | null {
  if (!parsed.items.some((item) => item.legacy_subunit_price_per_unit !== undefined)) return null;

  return {
    ...parsed,
    items: parsed.items.map((item) =>
      item.legacy_subunit_price_per_unit === undefined
        ? item
        : { ...item, price_per_unit: item.legacy_subunit_price_per_unit }),
  };
}

/**
 * Every identity this document could already be recorded under — the
 * reservations, the pre-PR #51 legacy hash, and, for a document a subunit
 * conversion touched, all three of those computed under the pre-fix price.
 * Read-only; never written. The pre-fix price is deliberately absent from
 * sessionHashReservations: a new document must never claim a hash derived from
 * arithmetic this codebase no longer believes.
 */
export function sessionHashCandidates(parsed: WeighSession): string[] {
  const legacyPriced = legacySubunitPricedSession(parsed);

  return [...new Set([
    ...sessionHashReservations(parsed),
    computeLegacySessionHash(parsed),
    ...(legacyPriced
      ? [
          computeSessionHash(legacyPriced),
          ...weighSessionCompatibilityFingerprints(legacyPriced),
          computeLegacySessionHash(legacyPriced),
        ]
      : []),
  ])];
}

/** Which algorithm wrote a hash. See business-fingerprint.ts. */
export type FingerprintGeneration = "V0" | "V1" | "V2";

/**
 * Which generation a matched hash belongs to, for this document.
 *
 * V2 is the document's own identity, V0 the pre-PR #51 legacy hash, and
 * anything else in the reserved set is a V1 compatibility fingerprint.
 */
export function fingerprintGenerationOf(
  parsed: WeighSession,
  hash: string,
): FingerprintGeneration {
  if (hash === computeSessionHash(parsed)) return "V2";
  if (hash === computeLegacySessionHash(parsed)) return "V0";
  return "V1";
}

/**
 * A reservation this document collided with, and whether the current attempt
 * is allowed to take it back.
 */
export interface DuplicateMatch {
  matchedHash: string;
  fingerprintGeneration: FingerprintGeneration;
  /** The pending generation that reserved it; null for historical rows. */
  reservedByGeneration: string | null;
  /**
   * True only when the reservation is provably this attempt's own. A NULL
   * provenance is historical evidence — never releasable, whatever the
   * generation of the hash that matched.
   */
  releasableByCurrentAttempt: boolean;
}

export function computeItemHash(
  parsed:         WeighSession,
  item:           WeighSessionItem,
): string {
  const canonical = [
    parsed.date         ?? "",
    parsed.staff_name,
    parsed.session_title ?? "",
    item.transaction_type,
    item.product_name,
    item.price_per_unit,
    item.quantity ?? "",
    item.unit     ?? "",
    (item.price_per_unit ?? 0) * (item.quantity ?? 0),
  ].join("|");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class SessionDedupService {
  constructor(private readonly supabase: AnyClient) {}

  /** One ledger row per reserved hash. Same evidence on each — see reservations. */
  private payload(parsed: WeighSession, rawText?: string) {
    const sortedTxTypes = [...new Set(parsed.items.map((i) => i.transaction_type))].sort().join(",");

    return sessionHashReservations(parsed).map((hash) => ({
      session_hash:     hash,
      transaction_date: parsed.date ?? null,
      staff_name:       parsed.staff_name,
      market_name:      parsed.session_title ?? "",
      transaction_type: sortedTxTypes,
      raw_text:         rawText ?? null,
    }));
  }

  /**
   * The reservation this document collides with, with enough provenance for
   * the caller to know whether it may be taken back.
   *
   * All three generations are searched — a session imported before the
   * canonical fingerprint shipped is still a duplicate of the same document
   * resent today — but a match is evidence, not permission. Ownership is
   * decided by `reserved_by_generation`, never by re-deriving item hashes:
   * `computeItemHash` folds the market label in, so a historical session
   * persisted under an alias spelling can never be recognised from a resend
   * under the canonical one.
   */
  async findDuplicate(
    parsed: WeighSession,
    currentGeneration?: string | null,
  ): Promise<DuplicateMatch | null> {
    const { data, error } = await this.supabase
      .from("imported_sessions")
      .select("session_hash, reserved_by_generation")
      .in("session_hash", sessionHashCandidates(parsed))
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`imported_sessions lookup failed: ${error.message}`);
    if (!data) return null;

    const row = data as { session_hash: string; reserved_by_generation?: string | null };
    const reservedByGeneration = row.reserved_by_generation ?? null;
    return {
      matchedHash: row.session_hash,
      fingerprintGeneration: fingerprintGenerationOf(parsed, row.session_hash),
      reservedByGeneration,
      releasableByCurrentAttempt:
        reservedByGeneration !== null
        && !!currentGeneration
        && reservedByGeneration === currentGeneration,
    };
  }

  async isDuplicate(parsed: WeighSession): Promise<boolean> {
    return (await this.findDuplicate(parsed)) !== null;
  }

  async hasPersistedItems(parsed: WeighSession): Promise<boolean> {
    const hashes = parsed.items.map((item) => computeItemHash(parsed, item));
    if (hashes.length === 0) return false;

    const { data, error } = await this.supabase
      .from("produce_items")
      .select("id")
      .in("item_hash", hashes)
      .limit(1);

    if (error) throw new Error(`produce_items dedup lookup failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  /**
   * Give back what THIS attempt provably reserved, and only that.
   *
   * Ownership is required, not assumed. Without a generation to match, nothing
   * is deleted at all: a hash collision proves a document was seen before, it
   * does not prove the row belongs to the caller. Historical reservations —
   * every row written before provenance existed, and every row belonging to
   * another attempt — carry NULL and are unreachable from here by construction.
   *
   * Never the V0 legacy hash either: this code has never written one, so a row
   * under it belongs to a session imported before PR #51 and deleting it would
   * make that session look like it never landed.
   */
  async release(parsed: WeighSession, generation: string | null | undefined): Promise<number> {
    if (!generation) return 0;

    const { data, error } = await this.supabase
      .from("imported_sessions")
      .delete()
      .in("session_hash", sessionHashReservations(parsed))
      .eq("reserved_by_generation", generation)
      .select("id");

    if (error) throw new Error(`imported_sessions release failed: ${error.message}`);
    return (data ?? []).length;
  }

  async record(parsed: WeighSession, rawText?: string): Promise<boolean> {
    const { error } = await this.supabase
      .from("imported_sessions")
      .insert(this.payload(parsed, rawText));

    if (error?.code === "23505") return true;
    if (error) throw new Error(`imported_sessions insert failed: ${error.message}`);
    return false;
  }

  /**
   * Atomically check + record.
   * Returns true if this session was already imported (duplicate).
   * Returns false if it is new (and records it in imported_sessions).
   *
   * Prefer `isDuplicate` + successful persistence + `record` for new flows so a
   * failed item insert cannot reserve a dedup hash permanently.
   */
  async checkAndRecord(parsed: WeighSession, rawText?: string): Promise<boolean> {
    return this.record(parsed, rawText);
  }
}
