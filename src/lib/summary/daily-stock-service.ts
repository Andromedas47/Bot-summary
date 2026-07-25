import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  buildRemainingFruitReport,
  type RemainingFruitSourceRow,
  type StockSummary,
} from "@/lib/summary/remaining-fruit";
import { fetchRemainingFruitRows } from "@/lib/summary/remaining-fruit-data";

export interface DailyStockSummaryOptions {
  marketFilter?: string | null;
}

/** The single canonical stock-model boundary shared by manual and scheduled LINE delivery. */
export function createDailyStockSummary(
  rows: readonly RemainingFruitSourceRow[],
  options: DailyStockSummaryOptions = {},
): StockSummary {
  return buildRemainingFruitReport(rows, {
    marketFilter: options.marketFilter,
  });
}

export async function getDailyStockSummary(
  supabase: SupabaseClient<Database>,
  businessDate: string,
  options: DailyStockSummaryOptions = {},
): Promise<StockSummary> {
  const rows = await fetchRemainingFruitRows(
    supabase,
    businessDate,
    options.marketFilter,
  );
  return createDailyStockSummary(rows, options);
}
