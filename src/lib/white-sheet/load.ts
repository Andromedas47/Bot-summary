import type { SupabaseClient } from "@supabase/supabase-js";
import { displayMarketName } from "@/lib/market";
import { loadAiVerifiedTransferTotal } from "@/lib/reconciliation";
import type { Database } from "@/types/database";
import { calculateDigitalWhiteSheet } from "./calculate";
import type {
  DigitalWhiteSheetCalculation,
  DigitalWhiteSheetSummary,
  WhiteSheetExpenses,
  WhiteSheetTransactionRow,
} from "./types";

type Supabase = SupabaseClient<Database>;
type ProduceTransactionRow =
  Database["public"]["Views"]["produce_transactions"]["Row"];

const PAGE_SIZE = 1000;
const SOURCE_LOOKUP_CHUNK_SIZE = 500;
const EFFECTIVE_TRANSACTION_TYPES = ["เบิก", "คืน", "คืนเสีย"] as const;
const PRODUCE_TRANSACTION_SELECT =
  "id, product_name, quantity, unit, price_per_unit, transaction_type, base_transaction_type, item_created_at, session_id, transaction_date, market_name, raw_message_id, basis_quantity, basis_price, session_kind" as const;

export interface DigitalWhiteSheetScope {
  sourceId: string;
  marketKey: string;
  marketLabel: string;
  businessDate: string;
}

/**
 * Validated request-time values until itemized expense/cash persistence is
 * approved. This boundary never writes them to settlement_entries.
 */
export interface DigitalWhiteSheetCashInput {
  expenses: Readonly<WhiteSheetExpenses>;
  actualCashSubmitted: number;
}

export class WhiteSheetDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhiteSheetDataError";
  }
}

function requireScopeValue(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new WhiteSheetDataError(`${field} must not be empty`);
  return normalized;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

async function fetchProduceRows(
  supabase: Supabase,
  businessDate: string,
): Promise<ProduceTransactionRow[]> {
  const rows: ProduceTransactionRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("produce_transactions")
      .select(PRODUCE_TRANSACTION_SELECT)
      .eq("transaction_date", businessDate)
      .in("base_transaction_type", [...EFFECTIVE_TRANSACTION_TYPES])
      .order("item_created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new WhiteSheetDataError(`produce transaction query failed: ${error.message}`);
    }

    const page = (data ?? []) as ProduceTransactionRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return rows;
}

async function filterRowsBySource(
  supabase: Supabase,
  rows: readonly ProduceTransactionRow[],
  sourceId: string,
): Promise<ProduceTransactionRow[]> {
  const rawMessageIds = [...new Set(rows.map((row) => row.raw_message_id))];
  if (rawMessageIds.length === 0) return [];

  const matchingIds = new Set<string>();
  for (const idChunk of chunks(rawMessageIds, SOURCE_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, source_id")
      .in("id", idChunk);

    if (error) {
      throw new WhiteSheetDataError(`market/source mapping query failed: ${error.message}`);
    }

    for (const row of data ?? []) {
      if (row.source_id === sourceId) matchingIds.add(row.id);
    }
  }

  return rows.filter((row) => matchingIds.has(row.raw_message_id));
}

function adaptTransactionRow(
  row: ProduceTransactionRow,
  scope: Pick<DigitalWhiteSheetScope, "marketKey" | "businessDate">,
): WhiteSheetTransactionRow {
  if (!row.product_name.trim()) {
    throw new WhiteSheetDataError(`produce transaction ${row.id} has no product name`);
  }
  if (!row.unit?.trim()) {
    throw new WhiteSheetDataError(`produce transaction ${row.id} has no unit`);
  }
  if (row.quantity === null || !Number.isFinite(Number(row.quantity))) {
    throw new WhiteSheetDataError(`produce transaction ${row.id} has no valid quantity`);
  }

  const transactionType = row.base_transaction_type?.trim();
  if (!EFFECTIVE_TRANSACTION_TYPES.includes(
    transactionType as (typeof EFFECTIVE_TRANSACTION_TYPES)[number],
  )) {
    throw new WhiteSheetDataError(
      `produce transaction ${row.id} has unsupported type ${transactionType || "(empty)"}`,
    );
  }

  if (transactionType === "เบิก" && row.price_per_unit === null) {
    throw new WhiteSheetDataError(
      `withdrawal transaction ${row.id} has no persisted price_per_unit`,
    );
  }

  const hasBasisQuantity = row.basis_quantity !== null;
  const hasBasisPrice = row.basis_price !== null;
  if (hasBasisQuantity !== hasBasisPrice) {
    throw new WhiteSheetDataError(
      `produce transaction ${row.id} has an incomplete persisted basis price`,
    );
  }

  return {
    marketKey: scope.marketKey,
    businessDate: scope.businessDate,
    productName: row.product_name,
    unit: row.unit,
    quantity: Number(row.quantity),
    transactionType,
    unitPrice: row.price_per_unit === null ? null : Number(row.price_per_unit),
    basisQuantity: row.basis_quantity === null ? null : Number(row.basis_quantity),
    basisPrice: row.basis_price === null ? null : Number(row.basis_price),
  };
}

function multipleSessionWarnings(rows: readonly ProduceTransactionRow[]): string[] {
  const mainSessionIds = new Set(
    rows
      .filter((row) => row.session_kind !== "additional")
      .map((row) => row.session_id),
  );

  return mainSessionIds.size > 1
    ? [
        `Multiple completed main produce sessions (${mainSessionIds.size}) exist for this `
          + "market and business date; current schema has no void/supersede marker, so "
          + "duplicate business data may still be included.",
      ]
    : [];
}

export function toDigitalWhiteSheetSummary(
  calculation: DigitalWhiteSheetCalculation,
): DigitalWhiteSheetSummary {
  return {
    marketKey: calculation.marketKey,
    marketLabel: calculation.marketLabel,
    businessDate: calculation.businessDate,
    expectedSales: calculation.expectedSales,
    verifiedTransfers: calculation.verifiedTransfers,
    expenses: calculation.expenses,
    expenseTotal: calculation.expenseTotal,
    expectedCash: calculation.expectedCash,
    actualCashSubmitted: calculation.actualCashSubmitted,
    difference: calculation.difference,
    status: calculation.status,
    warnings: calculation.warnings,
  };
}

/**
 * Read-only calculation boundary. produce_transactions contains only persisted
 * produce_items joined to produce_sessions. The required base has no
 * void/supersede status on those rows, so this loader does not invent one.
 */
export async function loadDigitalWhiteSheetCalculation(
  supabase: Supabase,
  rawScope: DigitalWhiteSheetScope,
  cashInput: DigitalWhiteSheetCashInput,
): Promise<DigitalWhiteSheetCalculation> {
  const scope: DigitalWhiteSheetScope = {
    sourceId: requireScopeValue(rawScope.sourceId, "sourceId"),
    marketKey: requireScopeValue(rawScope.marketKey, "marketKey"),
    marketLabel: requireScopeValue(rawScope.marketLabel, "marketLabel"),
    businessDate: requireScopeValue(rawScope.businessDate, "businessDate"),
  };

  const targetMarket = displayMarketName(scope.marketLabel, "").normalize("NFC").trim();
  if (!targetMarket) {
    throw new WhiteSheetDataError("marketLabel does not identify a market");
  }

  const dateRows = await fetchProduceRows(supabase, scope.businessDate);
  const marketRows = dateRows.filter(
    (row) =>
      displayMarketName(row.market_name, "").normalize("NFC").trim() === targetMarket,
  );
  const rows = await filterRowsBySource(supabase, marketRows, scope.sourceId);
  const transactions = rows.map((row) => adaptTransactionRow(row, scope));
  const verifiedTransfers = await loadAiVerifiedTransferTotal(
    supabase,
    scope.sourceId,
    scope.businessDate,
  );
  const calculation = calculateDigitalWhiteSheet({
    marketKey: scope.marketKey,
    marketLabel: targetMarket,
    businessDate: scope.businessDate,
    transactions,
    verifiedTransfers,
    expenses: cashInput.expenses,
    actualCashSubmitted: cashInput.actualCashSubmitted,
  });

  return {
    ...calculation,
    warnings: [...calculation.warnings, ...multipleSessionWarnings(rows)],
  };
}

export async function loadDigitalWhiteSheetSummary(
  supabase: Supabase,
  scope: DigitalWhiteSheetScope,
  cashInput: DigitalWhiteSheetCashInput,
): Promise<DigitalWhiteSheetSummary> {
  return toDigitalWhiteSheetSummary(
    await loadDigitalWhiteSheetCalculation(supabase, scope, cashInput),
  );
}
