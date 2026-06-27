import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";

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

export function computeSessionHash(parsed: WeighSession, workRoundId?: string): string {
  const sortedTxTypes = [...new Set(parsed.items.map((i) => i.transaction_type))].sort().join(",");

  const itemLines = [...parsed.items]
    .sort((a, b) => (a.item_number ?? 0) - (b.item_number ?? 0))
    .map(canonicalItem)
    .join("\n");

  const canonical = [
    parsed.date         ?? "",
    parsed.staff_name,
    parsed.session_title ?? "",
    workRoundId          ?? "",
    sortedTxTypes,
    itemLines,
  ].join("||");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
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

  private payload(parsed: WeighSession, rawText?: string, workRoundId?: string) {
    const sortedTxTypes = [...new Set(parsed.items.map((i) => i.transaction_type))].sort().join(",");

    return {
      session_hash:     computeSessionHash(parsed, workRoundId),
      transaction_date: parsed.date ?? null,
      staff_name:       parsed.staff_name,
      market_name:      parsed.session_title ?? "",
      transaction_type: sortedTxTypes,
      raw_text:         rawText ?? null,
    };
  }

  async isDuplicate(parsed: WeighSession, workRoundId?: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("imported_sessions")
      .select("id")
      .eq("session_hash", computeSessionHash(parsed, workRoundId))
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

  async release(parsed: WeighSession, workRoundId?: string): Promise<void> {
    const { error } = await this.supabase
      .from("imported_sessions")
      .delete()
      .eq("session_hash", computeSessionHash(parsed, workRoundId));

    if (error) throw new Error(`imported_sessions release failed: ${error.message}`);
  }

  async record(parsed: WeighSession, rawText?: string, workRoundId?: string): Promise<boolean> {
    const { error } = await this.supabase
      .from("imported_sessions")
      .insert(this.payload(parsed, rawText, workRoundId));

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
  async checkAndRecord(parsed: WeighSession, rawText?: string, workRoundId?: string): Promise<boolean> {
    return this.record(parsed, rawText, workRoundId);
  }
}
