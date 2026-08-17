import {
  dictionaryCategoryFor,
  reportCategoryHeading,
  REPORT_CATEGORY_LABEL,
  REPORT_CATEGORY_ORDER,
  type ReportCategoryId,
} from "@/lib/produce/product-code/category";
import { roundHalfUp } from "@/lib/sales/calculate";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType, type TransactionBucket } from "@/lib/summary/transactions";

/**
 * Shared category-aware money aggregation for produce output.
 *
 * Category is presentation only, derived at output time from the approved
 * Product Code Dictionary (see product-code/category.ts) — never a second,
 * hand-maintained classification and never a change to what the operator
 * types. This module owns exactly two things: resolving a raw product name to
 * its report category the one mandatory way, and turning a set of rows into
 * exact-integer-satang totals per category per transaction bucket.
 */

/**
 * One row of produce money. Deliberately row-type-agnostic: it matches the
 * shape produce_transactions exposes (`product_name`, `transaction_type`,
 * `total_amount` as a JS float) but any equivalently-shaped computed total
 * (e.g. a parsed session item's price × quantity) works the same way.
 */
export interface ProduceCategoryRow {
  /** Raw, as-recorded product name — normalization happens inside this module. */
  product_name: string;
  /** Raw transaction type — bucketed via baseTransactionType (เบิกเพิ่ม/ชั่งคืนเพิ่ม/คืนเสียเพิ่ม fold in). */
  transaction_type: string;
  /** Baht amount for this row, as a JS float. May be null/invalid — treated as 0 satang. */
  total_amount: number | null;
}

/** One category's confirmed money within one transaction bucket. */
export interface ProduceCategoryEntry {
  id: ReportCategoryId;
  /** REPORT_CATEGORY_LABEL[id] verbatim — never a second label. */
  label: string;
  /** reportCategoryHeading(id) verbatim (emoji + label). */
  heading: string;
  totalSatang: number;
  itemCount: number;
}

/** One transaction bucket's (เบิก / คืน / คืนเสีย) category breakdown. */
export interface ProduceCategoryBucket {
  /** Ordered by REPORT_CATEGORY_ORDER. Empty categories are omitted; a
   *  populated "ไม่จัดหมวด" bucket is never special-cased away. */
  categories: ProduceCategoryEntry[];
  /** Integer sum of every category's totalSatang — the whole-bucket total. */
  totalSatang: number;
}

export interface CategoryBreakdown {
  เบิก: ProduceCategoryBucket;
  คืน: ProduceCategoryBucket;
  คืนเสีย: ProduceCategoryBucket;
  /** เบิก − คืน − คืนเสีย, in satang. */
  netSatang: number;
  /** Rows whose transaction_type baseTransactionType could not classify —
   *  excluded from every bucket above, counted here so nothing vanishes silently. */
  skipped: number;
}

/**
 * Decimal baht (a JS float, exactly as produce_transactions.total_amount is
 * exposed, or an equivalent computed total) → integer satang, rounded
 * half-up exactly once.
 *
 * Same string-parsing + BigInt technique as sales/calculate.ts's
 * quantityTimesSatang and daily-good-return-value.ts's priceSatang, so this
 * never re-derives the rounding rule: the float is read as text (never
 * multiplied as a float, which is how 0.1 + 0.2 style drift happens), split
 * into whole/fraction/exponent, and shifted to satang with a single
 * half-up BigInt division for any leftover sub-satang digit.
 */
export function satangOf(amount: number | null | undefined): number {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return 0;

  const negative = amount < 0;
  const text = Math.abs(amount).toString().toLowerCase();
  const [coefficient, exponentText] = text.split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const shift = 2 - (fraction.length - exponent);
  const satang = shift >= 0
    ? BigInt(digits) * BigInt(10) ** BigInt(shift)
    : roundHalfUp(BigInt(digits), BigInt(10) ** BigInt(-shift));
  const bounded = satang <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(satang) : Number.MAX_SAFE_INTEGER;
  return negative ? -bounded : bounded;
}

/**
 * The one mandatory category resolution path: normalize the raw name through
 * the alias map FIRST, then classify against the dictionary. Calling
 * dictionaryCategoryFor on a raw name silently drops reviewed aliases into
 * ไม่จัดหมวด — proven by the existing category tests. `knownNames` should be
 * every already-normalized name present in the same row set, so the "เพิ่ม"
 * prefix strip is authorized exactly as remaining-fruit.ts and
 * daily-good-return-value.ts already do it.
 */
export function resolveProduceCategory(
  rawProductName: string,
  knownNames?: ReadonlySet<string>,
): ReportCategoryId {
  return dictionaryCategoryFor(normalizeProductName(rawProductName, undefined, knownNames));
}

interface MutableCategoryEntry {
  id: ReportCategoryId;
  totalSatang: number;
  itemCount: number;
}

function finalizeBucket(byId: ReadonlyMap<ReportCategoryId, MutableCategoryEntry>): ProduceCategoryBucket {
  const categories = REPORT_CATEGORY_ORDER
    .map((id) => byId.get(id))
    .filter((entry): entry is MutableCategoryEntry => entry !== undefined && entry.itemCount > 0)
    .map((entry) => ({
      id: entry.id,
      label: REPORT_CATEGORY_LABEL[entry.id],
      heading: reportCategoryHeading(entry.id),
      totalSatang: entry.totalSatang,
      itemCount: entry.itemCount,
    }));
  // Integer sum of already-integer category subtotals — never re-derived
  // from the rows, so this can never drift from the categories above it.
  const totalSatang = categories.reduce((sum, category) => sum + category.totalSatang, 0);
  return { categories, totalSatang };
}

/**
 * Group produce rows into category totals per transaction bucket, with a net
 * satang figure and an explicit skipped count so an unrecognized
 * transaction_type never silently vanishes.
 *
 * `knownNames` is an EXPLICIT parameter and is never derived from `rows`.
 * Deriving it here made a row's category depend on which other rows happened
 * to be in the same call — a lone `เพิ่มหมอนทอง` classified as ไม่จัดหมวด, the
 * same row next to a `หมอนทอง` sibling classified as ทุเรียน. A caller with
 * genuine wider context (the day-wide 08:00 report) passes its own set; a
 * caller with only one message passes nothing and gets a pure function of each
 * row's own name. Any caller that also groups rows itself MUST resolve
 * categories with the same argument, or a row can be totalled under one
 * category and printed under another.
 *
 * Money invariant: every row is converted to satang exactly once (satangOf),
 * and every subtotal from there on is an integer sum of those satang values —
 * so SUM(bucket.categories[*].totalSatang) === bucket.totalSatang, and
 * SUM(all buckets' totals) === SUM(satangOf(row) for every classified row),
 * exactly, for any grouping or row order.
 */
export function produceCategoryTotals(
  rows: readonly ProduceCategoryRow[],
  knownNames?: ReadonlySet<string>,
): CategoryBreakdown {
  const byBucket: Record<TransactionBucket, Map<ReportCategoryId, MutableCategoryEntry>> = {
    เบิก: new Map(),
    คืน: new Map(),
    คืนเสีย: new Map(),
  };

  let skipped = 0;

  for (const row of rows) {
    const bucket = baseTransactionType(row.transaction_type);
    if (!bucket) {
      skipped += 1;
      continue;
    }

    const categoryId = resolveProduceCategory(row.product_name, knownNames);
    const map = byBucket[bucket];
    const entry = map.get(categoryId) ?? { id: categoryId, totalSatang: 0, itemCount: 0 };
    entry.totalSatang += satangOf(row.total_amount);
    entry.itemCount += 1;
    map.set(categoryId, entry);
  }

  const เบิก = finalizeBucket(byBucket.เบิก);
  const คืน = finalizeBucket(byBucket.คืน);
  const คืนเสีย = finalizeBucket(byBucket.คืนเสีย);

  return {
    เบิก,
    คืน,
    คืนเสีย,
    netSatang: เบิก.totalSatang - คืน.totalSatang - คืนเสีย.totalSatang,
    skipped,
  };
}
