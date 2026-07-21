import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { KNOWN_TX_TYPES } from "@/lib/summary/transactions";
import type { RemainingFruitSourceRow } from "@/lib/summary/remaining-fruit";

const PAGE = 1000;

export async function fetchRemainingFruitRows(
  supabase: SupabaseClient<Database>,
  date: string,
  marketFilter?: string | null,
): Promise<RemainingFruitSourceRow[]> {
  const rows: RemainingFruitSourceRow[] = [];
  let offset = 0;

  while (true) {
    let query = supabase
      .from("produce_transactions")
      .select("market_name, product_name, quantity, unit, transaction_type")
      .eq("transaction_date", date)
      .in("transaction_type", [...KNOWN_TX_TYPES])
      .order("item_created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (marketFilter) {
      query = query.ilike("market_name", `%${marketFilter}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    rows.push(...((data ?? []) as RemainingFruitSourceRow[]));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }

  return rows;
}
