import { STOCK_CATEGORY_ORDER, type StockCategory } from "@/lib/summary/stock-categories";
import type { StockCategoryGroup, StockSummary } from "@/lib/summary/stock-summary";
import {
  stockThresholdKey,
  stockThresholdTable,
  type StockThresholdTable,
} from "@/lib/summary/stock-thresholds";

/**
 * The low-stock ATTENTION view over an existing StockSummary.
 *
 * This is a projection, not a second calculation. Every quantity here is a
 * total that StockSummary already published; nothing re-reads transactions and
 * no stock arithmetic is repeated. The manual `สรุปคงเหลือ` command keeps
 * rendering the same StockSummary in full.
 *
 * Purpose: at 08:00 tell P'Krai / Je which products are running low for the
 * business date that just closed, so they can check them before buying. It is
 * an alert list, never a purchase instruction.
 *
 * FAIL-CLOSED RULES
 *   1. No configured threshold → never low stock. Unknown is not "low".
 *   2. A product whose ชั่งคืน is still missing anywhere is EXCLUDED entirely.
 *      Its total is not final yet, so calling it low would be a false alarm
 *      built on incomplete data. This preserves the existing rule that a
 *      withdrawal without a good return is incomplete, never "0 remaining".
 *      คืนเสีย alone never closes the loop, so a bad-return-only product stays
 *      incomplete and stays out of the alert list.
 *   3. The aggregate ⚠️ incomplete warning is carried through regardless, so a
 *      suppressed product is never silently forgotten.
 */

export interface LowStockItem {
  productName: string;
  unit: string;
  /** Remaining good-return stock across every market, as StockSummary totalled it. */
  quantity: number;
  /** The configured attention level this quantity fell to or below. */
  threshold: number;
}

export interface LowStockCategoryGroup {
  category: StockCategory;
  products: LowStockItem[];
}

export interface LowStockReport {
  businessDate: string;
  /** Only categories that actually contain a low-stock item. */
  categories: LowStockCategoryGroup[];
  /** Total low-stock items across all categories. */
  itemCount: number;
  /** False when no threshold is configured at all — the fail-closed signal. */
  hasThresholds: boolean;
  /** Configured product+unit thresholds. Administration stat, not for LINE. */
  thresholdCount: number;
  /** Stocked product+unit combinations with no configured threshold. */
  withoutThresholdCount: number;
  /** Product+unit combinations with a threshold, held back as incomplete. */
  suppressedIncompleteCount: number;
  /** Markets still owing a ชั่งคืน. */
  incompleteMarketCount: number;
  /** market+product+unit combinations still owing a ชั่งคืน. */
  incompleteItemCount: number;
  isComplete: boolean;
}

interface ProductTotal {
  productName: string;
  unit: string;
  quantity: number;
  category: StockCategory;
}

/**
 * Fold the already-computed category totals into one product+unit map.
 *
 * Unidentified-market stock is folded in here on purpose. StockSummary reports
 * it separately so it never pollutes the presented all-market totals, but for a
 * threshold comparison it is stock we are holding: leaving it out would
 * understate the total and manufacture low-stock alerts. Category is a pure
 * function of the canonical name, so the two sources always agree.
 */
function totalsByProduct(groups: readonly StockCategoryGroup[][]): Map<string, ProductTotal> {
  const totals = new Map<string, ProductTotal>();

  for (const groupSet of groups) {
    for (const group of groupSet) {
      for (const product of group.products) {
        const key = stockThresholdKey(product.productName, product.unit);
        const existing = totals.get(key);
        if (existing) {
          existing.quantity += product.quantity;
          continue;
        }
        totals.set(key, {
          productName: product.productName,
          unit: product.unit,
          quantity: product.quantity,
          category: group.category,
        });
      }
    }
  }

  return totals;
}

/**
 * product+unit combinations that still owe a good return anywhere. Keyed rather
 * than a plain set so a product with NO good return at all — one that never
 * reaches the category totals — can still be counted as held back.
 */
function incompleteProducts(summary: StockSummary): Map<string, { productName: string; unit: string }> {
  const blocked = new Map<string, { productName: string; unit: string }>();
  for (const entry of summary.incomplete) {
    blocked.set(stockThresholdKey(entry.productName, entry.unit), {
      productName: entry.productName,
      unit: entry.unit,
    });
  }
  return blocked;
}

export function buildLowStockReport(
  summary: StockSummary,
  thresholds: StockThresholdTable = stockThresholdTable,
): LowStockReport {
  const totals = totalsByProduct([summary.categories, summary.unidentified]);
  const blocked = incompleteProducts(summary);

  const byCategory = new Map<StockCategory, LowStockItem[]>();
  let withoutThresholdCount = 0;

  // Counted over the blocked set, not over the totals: a product whose ชั่งคืน
  // is missing everywhere has no total at all, and it is precisely the case we
  // most need to know is being held back.
  let suppressedIncompleteCount = 0;
  for (const { productName, unit } of blocked.values()) {
    if (thresholds.get(productName, unit) !== undefined) suppressedIncompleteCount += 1;
  }

  for (const [key, total] of totals) {
    const threshold = thresholds.get(total.productName, total.unit);
    if (threshold === undefined) {
      withoutThresholdCount += 1;
      continue;
    }
    if (blocked.has(key)) continue;
    if (!(total.quantity <= threshold)) continue;

    const items = byCategory.get(total.category) ?? [];
    items.push({
      productName: total.productName,
      unit: total.unit,
      quantity: total.quantity,
      threshold,
    });
    byCategory.set(total.category, items);
  }

  const categories: LowStockCategoryGroup[] = [];
  for (const category of STOCK_CATEGORY_ORDER) {
    const products = byCategory.get(category);
    if (!products || products.length === 0) continue;

    categories.push({
      category,
      // Most depleted relative to its own threshold first: that ranking is
      // comparable across products whose units and thresholds differ.
      products: products.sort(
        (a, b) =>
          a.quantity / a.threshold - b.quantity / b.threshold ||
          a.quantity - b.quantity ||
          a.productName.localeCompare(b.productName, "th") ||
          a.unit.localeCompare(b.unit, "th"),
      ),
    });
  }

  const incompleteMarkets = new Set(summary.incomplete.map((entry) => entry.marketName));

  return {
    businessDate: summary.businessDate,
    categories,
    itemCount: categories.reduce((n, group) => n + group.products.length, 0),
    hasThresholds: thresholds.size > 0,
    thresholdCount: thresholds.size,
    withoutThresholdCount,
    suppressedIncompleteCount,
    incompleteMarketCount: incompleteMarkets.size,
    incompleteItemCount: summary.incomplete.length,
    isComplete: summary.isComplete,
  };
}
