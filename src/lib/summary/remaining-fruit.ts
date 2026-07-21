import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { displayMarketName } from "@/lib/market";
import { transactionBucket, type TransactionBucket } from "@/lib/summary/transactions";

export const PRODUCT_ALIASES: Record<string, string> = {
  "\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E16\u0E31\u0E48\u0E27\u0E1E\u0E39": "\u0E16\u0E31\u0E48\u0E27\u0E1E\u0E39",
  "\u0E16\u0E31\u0E48\u0E27\u0E1E\u0E4D": "\u0E16\u0E31\u0E48\u0E27\u0E1E\u0E39",
  "\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E01\u0E30\u0E2B\u0E25\u0E48\u0E33\u0E1B\u0E35": "\u0E01\u0E30\u0E2B\u0E25\u0E48\u0E33\u0E1B\u0E35",
  "\u0E43\u0E1A\u0E21\u0E31\u0E07\u0E25\u0E35\u0E01": "\u0E43\u0E1A\u0E21\u0E31\u0E07\u0E25\u0E31\u0E01",
  "\u0E43\u0E1A\u0E15\u0E31\u0E48\u0E07\u0E42\u0E2D\u0E49": "\u0E43\u0E1A\u0E15\u0E31\u0E48\u0E07\u0E42\u0E2D\u0E49",
};

const KNOWN_PREFIX = "\u0E40\u0E1E\u0E34\u0E48\u0E21";

function baseNormalize(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function normalizeProductName(
  name: string,
  aliases: Record<string, string> = PRODUCT_ALIASES,
  knownNames?: ReadonlySet<string>,
): string {
  const n = baseNormalize(name);
  const aliased = aliases[n] ?? n;
  if (aliased !== n) return aliased;

  if (knownNames && n.startsWith(KNOWN_PREFIX)) {
    const rest = n.slice(KNOWN_PREFIX.length).trim();
    if (rest && knownNames.has(rest)) return rest;
  }
  return n;
}

export function formatQuantity(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? r.toString() : r.toFixed(3).replace(/0+$/, "");
}

export interface RemainingFruitSourceRow {
  market_name: string | null;
  product_name: string;
  quantity: number | null;
  unit: string | null;
  transaction_type: string;
}

export interface RemainingFruitItem {
  fruitName: string;
  unit: string;
  withdrawnQuantity: number;
  returnGoodQuantity: number;
  damagedQuantity: number;
  remainingForResaleQuantity: number;
  hasReturnGoodData: boolean;
  hasWithdrawnData: boolean;
  hasDamagedData: boolean;
}

export interface RemainingFruitMarketSection {
  marketName: string;
  items: RemainingFruitItem[];
}

export interface RemainingFruitOverallBreakdown {
  marketName: string;
  quantity: number;
}

export interface RemainingFruitOverallItem {
  fruitName: string;
  unit: string;
  totalRemainingForResale: number;
  marketBreakdown: RemainingFruitOverallBreakdown[];
}

export interface RemainingFruitReport {
  markets: RemainingFruitMarketSection[];
  overall: RemainingFruitOverallItem[];
}

interface AggregateCell {
  fruitName: string;
  unit: string;
  withdrawnQuantity: number;
  returnGoodQuantity: number;
  damagedQuantity: number;
  hasReturnGoodData: boolean;
  hasWithdrawnData: boolean;
  hasDamagedData: boolean;
}

export function normalizeRemainingUnit(unit: string | null | undefined): string {
  const trimmed = (unit ?? "").trim();
  if (!trimmed) return "";
  return normalizeUnitAlias(trimmed);
}

/** Display label for LINE / web — keeps grouping key separate from presentation. */
export function displayRemainingUnit(unit: string): string {
  if (unit === "โล") return "กิโล";
  return unit || "—";
}

function toItem(cell: AggregateCell): RemainingFruitItem {
  return {
    fruitName: cell.fruitName,
    unit: cell.unit,
    withdrawnQuantity: cell.withdrawnQuantity,
    returnGoodQuantity: cell.returnGoodQuantity,
    damagedQuantity: cell.damagedQuantity,
    remainingForResaleQuantity: cell.returnGoodQuantity,
    hasReturnGoodData: cell.hasReturnGoodData,
    hasWithdrawnData: cell.hasWithdrawnData,
    hasDamagedData: cell.hasDamagedData,
  };
}

function addQuantity(
  cell: AggregateCell,
  bucket: TransactionBucket,
  quantity: number,
): void {
  if (bucket === "เบิก") {
    cell.withdrawnQuantity += quantity;
    cell.hasWithdrawnData = true;
    return;
  }
  if (bucket === "คืน") {
    cell.returnGoodQuantity += quantity;
    cell.hasReturnGoodData = true;
    return;
  }
  cell.damagedQuantity += quantity;
  cell.hasDamagedData = true;
}

function emptyCell(fruitName: string, unit: string): AggregateCell {
  return {
    fruitName,
    unit,
    withdrawnQuantity: 0,
    returnGoodQuantity: 0,
    damagedQuantity: 0,
    hasReturnGoodData: false,
    hasWithdrawnData: false,
    hasDamagedData: false,
  };
}

function shouldIncludeItem(cell: AggregateCell): boolean {
  return cell.hasReturnGoodData || cell.hasWithdrawnData || cell.hasDamagedData;
}

function sortItems(a: RemainingFruitItem, b: RemainingFruitItem): number {
  return a.fruitName.localeCompare(b.fruitName, "th") || a.unit.localeCompare(b.unit, "th");
}

/**
 * Aggregate produce rows for one business date.
 * Remaining for resale is always the summed ชั่งคืน (transaction_type "คืน") quantity —
 * never derived from เบิก − ชั่งคืน − คืนเสีย.
 */
export function buildRemainingFruitReport(
  source: readonly RemainingFruitSourceRow[],
  options: {
    marketFilter?: string | null;
    aliases?: Record<string, string>;
  } = {},
): RemainingFruitReport {
  const aliases = options.aliases ?? PRODUCT_ALIASES;
  const marketFilter = options.marketFilter?.trim() || null;

  const pass1Names = new Set(
    source.map((r) => {
      const n = r.product_name.normalize("NFC").replace(/\s+/g, " ").trim();
      return aliases[n] ?? n;
    }),
  );

  const byMarket = new Map<string, Map<string, AggregateCell>>();

  for (const row of source) {
    const bucket = transactionBucket(row.transaction_type);
    if (!bucket) continue;

    const market = displayMarketName(row.market_name, "ไม่ระบุตลาด");
    if (marketFilter && !market.toLowerCase().includes(marketFilter.toLowerCase())) {
      continue;
    }

    const fruitName = normalizeProductName(row.product_name, aliases, pass1Names);
    const unit = normalizeRemainingUnit(row.unit);
    const key = `${fruitName}||${unit}`;
    const qty = row.quantity ?? 0;
    if (!Number.isFinite(qty)) continue;

    let marketMap = byMarket.get(market);
    if (!marketMap) {
      marketMap = new Map();
      byMarket.set(market, marketMap);
    }

    let cell = marketMap.get(key);
    if (!cell) {
      cell = emptyCell(fruitName, unit);
      marketMap.set(key, cell);
    }

    addQuantity(cell, bucket, qty);
  }

  const markets: RemainingFruitMarketSection[] = [...byMarket.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "th"))
    .map(([marketName, cells]) => ({
      marketName,
      items: [...cells.values()]
        .filter(shouldIncludeItem)
        .map(toItem)
        .sort(sortItems),
    }))
    .filter((section) => section.items.length > 0);

  const overallMap = new Map<string, RemainingFruitOverallItem>();

  for (const section of markets) {
    for (const item of section.items) {
      if (!item.hasReturnGoodData) continue;

      const key = `${item.fruitName}||${item.unit}`;
      let overall = overallMap.get(key);
      if (!overall) {
        overall = {
          fruitName: item.fruitName,
          unit: item.unit,
          totalRemainingForResale: 0,
          marketBreakdown: [],
        };
        overallMap.set(key, overall);
      }

      overall.totalRemainingForResale += item.remainingForResaleQuantity;
      overall.marketBreakdown.push({
        marketName: section.marketName,
        quantity: item.remainingForResaleQuantity,
      });
    }
  }

  const overall = [...overallMap.values()]
    .map((row) => ({
      ...row,
      marketBreakdown: row.marketBreakdown.sort((a, b) =>
        a.marketName.localeCompare(b.marketName, "th"),
      ),
    }))
    .sort((a, b) =>
      a.fruitName.localeCompare(b.fruitName, "th") || a.unit.localeCompare(b.unit, "th"),
    );

  return { markets, overall };
}
