/**
 * Expected-sales computation for a Work Round.
 *
 *   expected_sales = total_borrow - total_return - total_bad_return
 *
 * Returns (คืน) include ชั่งคืนเพิ่ม append sessions via transactionBucket.
 * Reads produce_items belonging to the round's produce_sessions — by
 * work_round_id, never by seller/market text.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { transactionBucket } from "@/lib/summary/transactions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export interface RoundTotals {
  borrow:    number;
  ret:       number;
  badReturn: number;
  expected:  number;
}

export function emptyRoundTotals(): RoundTotals {
  return { borrow: 0, ret: 0, badReturn: 0, expected: 0 };
}

export async function computeRoundTotals(
  supabase:    AnyClient,
  workRoundId: string,
): Promise<RoundTotals> {
  const { data: sessions } = await supabase
    .from("produce_sessions")
    .select("id")
    .eq("work_round_id", workRoundId);

  const sessionIds = (sessions ?? []).map((s: { id: string }) => s.id);
  if (sessionIds.length === 0) return emptyRoundTotals();

  const { data: items } = await supabase
    .from("produce_items")
    .select("quantity, price_per_unit, transaction_type")
    .in("session_id", sessionIds);

  const totals = emptyRoundTotals();
  for (const it of items ?? []) {
    const qty   = Number(it.quantity ?? 0);
    const price = Number(it.price_per_unit ?? 0);
    const amount = qty * price;
    const bucket = transactionBucket(it.transaction_type as string);
    if (bucket === "เบิก")      totals.borrow    += amount;
    else if (bucket === "คืน")   totals.ret       += amount;
    else if (bucket === "คืนเสีย") totals.badReturn += amount;
  }
  totals.expected = totals.borrow - totals.ret - totals.badReturn;
  return totals;
}
