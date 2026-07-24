import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizedMarketLabel } from "@/lib/market";
import { loadMarketScopedAiVerifiedTransfers } from "@/lib/reconciliation";
import type { Database } from "@/types/database";
import { calculateDigitalWhiteSheet, resolveWithdrawalUnitPriceBaht } from "./calculate";
import {
  centralPriceKey,
  centralPriceMapKey,
  loadCentralPriceDetailsForDate,
  SYSTEM_WITHDRAWAL_SEED_ACTOR,
} from "./pricing";
import type {
  DigitalWhiteSheetCalculation,
  DigitalWhiteSheetSummary,
  WhiteSheetExpenses,
  WhiteSheetTransactionRow,
} from "./types";
import { pendingReferenceVerifiedTransferWarning, unattributedVerifiedTransferWarning } from "./warnings";

export { normalizedMarketLabel } from "@/lib/market";

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

export async function fetchProduceRows(
  supabase: Supabase,
  businessDate: string,
): Promise<ProduceTransactionRow[]> {
  const rows: ProduceTransactionRow[] = [];
  const seenRowIds = new Set<string>();
  let offset = 0;
  let expectedCount: number | null = null;

  while (true) {
    const { data, error, count } = await supabase
      .from("produce_transactions")
      .select(PRODUCE_TRANSACTION_SELECT, { count: "exact" })
      .eq("transaction_date", businessDate)
      .in("base_transaction_type", [...EFFECTIVE_TRANSACTION_TYPES])
      .order("item_created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new WhiteSheetDataError(`produce transaction query failed: ${error.message}`);
    }
    if (count === null) {
      throw new WhiteSheetDataError(
        "produce transaction pagination requires an exact row count",
      );
    }
    if (expectedCount === null) {
      expectedCount = count;
    } else if (count !== expectedCount) {
      throw new WhiteSheetDataError(
        "produce transaction set changed during pagination",
      );
    }

    const page = (data ?? []) as ProduceTransactionRow[];
    if (page.length === 0) {
      if (offset === expectedCount) break;
      throw new WhiteSheetDataError(
        "produce transaction pagination stopped before all rows were loaded",
      );
    }

    for (const row of page) {
      if (seenRowIds.has(row.id)) {
        throw new WhiteSheetDataError(
          "produce transaction pagination returned a duplicate persisted row",
        );
      }
      seenRowIds.add(row.id);
      rows.push(row);
    }

    offset += page.length;
    if (offset === expectedCount) break;
    if (offset > expectedCount) {
      throw new WhiteSheetDataError(
        "produce transaction pagination exceeded the exact row count",
      );
    }
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

function unresolvedMarketWarnings(
  sourceRows: readonly ProduceTransactionRow[],
): string[] {
  const unresolvedCount = sourceRows.filter(
    (row) => !normalizedMarketLabel(row.market_name),
  ).length;
  return unresolvedCount > 0
    ? [
        `Excluded ${unresolvedCount} produce row(s) because their market label could not `
          + "be normalized.",
      ]
    : [];
}

/**
 * Read-only central-price resolution for White Sheet load.
 *
 * Seeding happens on successful withdrawal persistence (see
 * seedCentralPricesFromPersistedWithdrawals) — this path never creates,
 * seeds, corrects, or mutates central_selling_prices.
 *
 * dateRows spans every market/source for the date (fetched before any
 * market/source filter) so conflict detection is global: a later withdrawal
 * whose own price disagrees with a system-auto-seeded central price marks
 * the identity disputed and calculate.ts fails closed for every market
 * touching it. Once an admin has set/corrected the price, a mismatching
 * withdrawal is informational only — the admin decision is final.
 */
async function resolveCentralPricesForDate(
  supabase: Supabase,
  businessDate: string,
  dateRows: readonly ProduceTransactionRow[],
): Promise<{ prices: Map<string, number>; conflicts: Set<string> }> {
  const details = await loadCentralPriceDetailsForDate(supabase, businessDate);
  const conflicts = new Set<string>();

  for (const row of dateRows) {
    if (row.base_transaction_type?.trim() !== "เบิก") continue;
    const productName = row.product_name?.trim();
    const rawUnit = row.unit?.trim();
    if (!productName || !rawUnit || row.price_per_unit === null) continue;

    const key = centralPriceKey({ productName, unit: rawUnit, businessDate });
    const mapKey = centralPriceMapKey(key.productKey, key.unitKey);
    const existing = details.get(mapKey);
    if (!existing) continue;

    const priceBaht = resolveWithdrawalUnitPriceBaht({
      unit: rawUnit,
      unitPrice: Number(row.price_per_unit),
      basisQuantity: row.basis_quantity === null ? null : Number(row.basis_quantity),
    });
    const priceSatang = Math.round(priceBaht * 100);

    if (existing.setBy === SYSTEM_WITHDRAWAL_SEED_ACTOR && existing.priceSatang !== priceSatang) {
      conflicts.add(mapKey);
    }
  }

  const prices = new Map<string, number>();
  for (const [mapKey, entry] of details) {
    prices.set(mapKey, entry.priceSatang);
  }
  return { prices, conflicts };
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

  const targetMarket = normalizedMarketLabel(scope.marketLabel);
  if (!targetMarket) {
    throw new WhiteSheetDataError("marketLabel does not identify a market");
  }

  const dateRows = await fetchProduceRows(supabase, scope.businessDate);
  const sourceRows = await filterRowsBySource(supabase, dateRows, scope.sourceId);
  const knownMarkets = new Set(
    sourceRows
      .map((row) => normalizedMarketLabel(row.market_name))
      .filter((label) => label.length > 0),
  );
  const rows = sourceRows.filter(
    (row) => normalizedMarketLabel(row.market_name) === targetMarket,
  );
  const transactions = rows.map((row) => adaptTransactionRow(row, scope));
  const { prices: centralPrices, conflicts: priceConflicts } = await resolveCentralPricesForDate(
    supabase,
    scope.businessDate,
    dateRows,
  );
  const verifiedTransferResult = await loadMarketScopedAiVerifiedTransfers(
    supabase,
    scope.sourceId,
    scope.businessDate,
    targetMarket,
    knownMarkets,
  );
  const verifiedTransferWarnings = [
    ...(verifiedTransferResult.unresolvedAcceptedCount > 0
      ? [
          unattributedVerifiedTransferWarning(
            verifiedTransferResult.unresolvedAcceptedCount,
            verifiedTransferResult.unresolvedAcceptedAmount,
          ),
        ]
      : []),
    ...(verifiedTransferResult.pendingReferenceCount > 0
      ? [
          pendingReferenceVerifiedTransferWarning(
            verifiedTransferResult.pendingReferenceCount,
            verifiedTransferResult.pendingReferenceAmount,
          ),
        ]
      : []),
  ];
  const calculation = calculateDigitalWhiteSheet({
    marketKey: scope.marketKey,
    marketLabel: targetMarket,
    businessDate: scope.businessDate,
    transactions,
    centralPrices,
    priceConflicts,
    verifiedTransfers: verifiedTransferResult.attributedTotal,
    expenses: cashInput.expenses,
    actualCashSubmitted: cashInput.actualCashSubmitted,
  });

  return {
    ...calculation,
    warnings: [
      ...calculation.warnings,
      ...verifiedTransferWarnings,
      ...unresolvedMarketWarnings(sourceRows),
      ...multipleSessionWarnings(rows),
    ],
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
