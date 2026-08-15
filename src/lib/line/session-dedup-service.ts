import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { weighSessionBusinessFingerprint } from "@/lib/produce/business-fingerprint";

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

/** Both identities of one document — new first, then the legacy fallback. */
export function sessionHashCandidates(parsed: WeighSession): string[] {
  return [...new Set([computeSessionHash(parsed), computeLegacySessionHash(parsed)])];
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

  private payload(parsed: WeighSession, rawText?: string) {
    const sortedTxTypes = [...new Set(parsed.items.map((i) => i.transaction_type))].sort().join(",");

    return {
      session_hash:     computeSessionHash(parsed),
      transaction_date: parsed.date ?? null,
      staff_name:       parsed.staff_name,
      market_name:      parsed.session_title ?? "",
      transaction_type: sortedTxTypes,
      raw_text:         rawText ?? null,
    };
  }

  async isDuplicate(parsed: WeighSession): Promise<boolean> {
    // Both identities: a session imported before the canonical fingerprint
    // shipped is still a duplicate of the same document resent today.
    const { data, error } = await this.supabase
      .from("imported_sessions")
      .select("id")
      .in("session_hash", sessionHashCandidates(parsed))
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`imported_sessions lookup failed: ${error.message}`);
    return !!data;
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

  async release(parsed: WeighSession): Promise<void> {
    const { error } = await this.supabase
      .from("imported_sessions")
      .delete()
      .in("session_hash", sessionHashCandidates(parsed));

    if (error) throw new Error(`imported_sessions release failed: ${error.message}`);
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
