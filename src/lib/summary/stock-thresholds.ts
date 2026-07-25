/**
 * Low-stock attention thresholds for the automatic 08:00 report.
 *
 * WHAT A THRESHOLD MEANS
 *   "แจ้งเตือนเมื่อคงเหลือไม่เกิน N <หน่วย>" — a request to LOOK at the product
 *   before buying that morning. It is NOT a reorder quantity, not a purchase
 *   instruction, and it does not compute how much to buy. The report wording
 *   stays at "คงเหลือน้อย / ตรวจสอบก่อนซื้อ" for exactly that reason.
 *
 * DESIGN RULES (deliberate — do not relax without a business decision)
 *   1. A threshold is keyed by canonical product name + canonical unit. The
 *      unit is part of the identity: 5 กล่อง and 5 กก. of the same product are
 *      unrelated quantities and must never share a threshold.
 *   2. Matching is EXACT on the canonical name produced by normalizeProductName.
 *      No fuzzy matching, no category-level defaults, no per-unit guessing.
 *   3. A product with NO configured threshold is NEVER low stock. Silence is
 *      the safe answer: we would rather miss an alert than invent one.
 *   4. There are no built-in values. STOCK_THRESHOLDS below is empty until
 *      P'Krai approves real numbers, and while it is empty the scheduled
 *      delivery fails closed and sends nothing (see the cron route).
 *
 * WHY A TYPED MODULE RATHER THAN ENV OR A TABLE
 *   This mirrors stock-categories.ts, the pattern the project already uses for
 *   curated business data: it is reviewed in a diff, typed, unit-tested, and
 *   cannot be half-applied. An env var would put business numbers in an
 *   unreviewed string, and a DB table would need a migration plus an admin UI
 *   for a list that changes a few times a season. Revisit if thresholds ever
 *   need to change without a deploy.
 */

export interface StockThreshold {
  /** Canonical product name, exactly as normalizeProductName produces it. */
  productName: string;
  /** Canonical unit as stored on the transaction ("โล", "ลูก", "แพค", …). */
  unit: string;
  /**
   * Attention level. A product is flagged when its remaining good-return stock
   * is LESS THAN OR EQUAL TO this number — see LOW_STOCK_COMPARISON.
   */
  threshold: number;
}

/**
 * The comparison is inclusive: remaining <= threshold is low stock.
 *
 * Stated explicitly because "ไม่เกิน N" is how the business phrases it, and
 * because an off-by-one here decides whether a product on exactly the line is
 * shown. Inclusive errs toward showing the product, which is the harmless
 * direction for a "please check" message.
 */
export const LOW_STOCK_COMPARISON = "remaining <= threshold" as const;

/**
 * APPROVED THRESHOLDS — INTENTIONALLY EMPTY.
 *
 * Populate only with values P'Krai has confirmed, one line per product+unit:
 *
 *   { productName: "หมอนทอง", unit: "โล",  threshold: 30 },
 *   { productName: "มะละกอ",  unit: "ลูก", threshold: 20 },
 *
 * Nothing else needs to change to activate — the report picks them up.
 */
export const STOCK_THRESHOLDS: readonly StockThreshold[] = [];

export function stockThresholdKey(productName: string, unit: string): string {
  return `${productName.normalize("NFC").trim()}||${unit.normalize("NFC").trim()}`;
}

export interface StockThresholdTable {
  /** How many product+unit thresholds are configured. */
  readonly size: number;
  /** Configured threshold for this exact product+unit, or undefined. */
  get(productName: string, unit: string): number | undefined;
  entries(): StockThreshold[];
}

/**
 * Build a lookup table. Entries that are not usable numbers are dropped rather
 * than trusted — a malformed threshold must not silently become 0 (which would
 * quietly stop alerting) or NaN (which would compare false forever).
 *
 * First writer wins on a duplicate key, so an accidental second line can never
 * silently override an approved value. The test suite asserts there are none.
 */
export function createStockThresholdTable(
  entries: readonly StockThreshold[],
): StockThresholdTable {
  const map = new Map<string, StockThreshold>();

  for (const entry of entries) {
    const productName = entry.productName.normalize("NFC").trim();
    const unit = entry.unit.normalize("NFC").trim();
    if (!productName || !unit) continue;
    if (!Number.isFinite(entry.threshold) || entry.threshold < 0) continue;

    const key = stockThresholdKey(productName, unit);
    if (!map.has(key)) map.set(key, { productName, unit, threshold: entry.threshold });
  }

  return {
    size: map.size,
    get(productName: string, unit: string): number | undefined {
      return map.get(stockThresholdKey(productName, unit))?.threshold;
    },
    entries(): StockThreshold[] {
      return [...map.values()];
    },
  };
}

/** The configured table used by the scheduled report. */
export const stockThresholdTable: StockThresholdTable =
  createStockThresholdTable(STOCK_THRESHOLDS);
