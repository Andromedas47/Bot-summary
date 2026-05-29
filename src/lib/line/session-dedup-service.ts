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

export function computeSessionHash(parsed: WeighSession): string {
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

  /**
   * Atomically check + record.
   * Returns true if this session was already imported (duplicate).
   * Returns false if it is new (and records it in imported_sessions).
   */
  async checkAndRecord(parsed: WeighSession, rawText?: string): Promise<boolean> {
    const hash           = computeSessionHash(parsed);
    const sortedTxTypes  = [...new Set(parsed.items.map((i) => i.transaction_type))].sort().join(",");

    const { error } = await this.supabase.from("imported_sessions").insert({
      session_hash:     hash,
      transaction_date: parsed.date ?? null,
      staff_name:       parsed.staff_name,
      market_name:      parsed.session_title ?? "",
      transaction_type: sortedTxTypes,
      raw_text:         rawText ?? null,
    });

    if (error?.code === "23505") return true;   // unique violation → duplicate
    if (error) throw new Error(`imported_sessions insert failed: ${error.message}`);
    return false;
  }
}
