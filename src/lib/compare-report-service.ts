import "server-only";

import { buildCompareReport, type CompareReport, type CompareSettlementInput, type CompareSourceRow } from "@/lib/compare-report";
import { createServiceClient } from "@/lib/supabase/server";

export interface CompareFilters {
  date: string;
  worker: string;
  market?: string;
}

export interface CompareFilterOptions {
  workers: string[];
  markets: string[];
}

export async function fetchCompareFilterOptions(date?: string): Promise<CompareFilterOptions> {
  const supabase = createServiceClient();
  let query = supabase
    .from("effective_produce_transactions")
    .select("staff_name, market_name")
    .order("staff_name")
    .limit(5000);
  if (date) query = query.eq("transaction_date", date);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return {
    workers: [...new Set((data ?? []).map((row) => row.staff_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, "th")),
    markets: [...new Set((data ?? []).map((row) => row.market_name).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, "th")),
  };
}

async function fetchRows(filters: CompareFilters): Promise<CompareSourceRow[]> {
  const supabase = createServiceClient();
  const all: CompareSourceRow[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    let query = supabase
      .from("effective_produce_transactions")
      .select("id, product_name, quantity, unit, price_per_unit, total_amount, transaction_type, base_transaction_type, is_corrected, correction_id, correction_reason_detail, original_product_name, original_quantity, original_price_amount, original_price_quantity, original_total_amount")
      .eq("transaction_date", filters.date)
      .eq("staff_name", filters.worker)
      .order("item_number", { ascending: true, nullsFirst: false })
      .range(offset, offset + pageSize - 1);
    if (filters.market) query = query.eq("market_name", filters.market);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as CompareSourceRow[]));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function fetchSettlement(filters: CompareFilters): Promise<CompareSettlementInput | null> {
  const supabase = createServiceClient();
  let query = supabase
    .from("settlement_entries")
    .select("money_transfer, money_cash, expenses, labor")
    .eq("settlement_date", filters.date)
    .eq("staff_name", filters.worker);
  if (filters.market) query = query.eq("market_name", filters.market);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  if (!data?.length) return null;
  return data.reduce<CompareSettlementInput>((sum, row) => ({
    money_transfer: sum.money_transfer + (row.money_transfer ?? 0),
    money_cash: sum.money_cash + (row.money_cash ?? 0),
    expenses: sum.expenses + (row.expenses ?? 0),
    labor: sum.labor + (row.labor ?? 0),
  }), { money_transfer: 0, money_cash: 0, expenses: 0, labor: 0 });
}

export async function fetchCompareReport(filters: CompareFilters): Promise<CompareReport> {
  const [rows, settlement] = await Promise.all([fetchRows(filters), fetchSettlement(filters)]);
  return buildCompareReport(rows, settlement);
}
