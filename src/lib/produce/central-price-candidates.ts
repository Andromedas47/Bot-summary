/**
 * Central selling price review — what prices were actually entered, and which
 * identity still needs a human to choose one.
 *
 * The company rule is one approved central price per product + unit + business
 * date. Production 2026-08 had อะโวคาโด withdrawn at 50 and at 70 บาท/กก. on the
 * same day; the report correctly refused to value it, but said only
 * "ราคากลางขัดแย้ง" without naming the candidates, so nobody could act on it.
 *
 * This module answers the question the operator actually has: which prices were
 * seen, how often, in which markets, and what (if anything) is approved.
 *
 * It never picks a price. No majority rule, no latest-wins, no min/max — a
 * disputed identity stays disputed until an administrator sets it through the
 * existing set_central_selling_price path. It also never touches a withdrawal:
 * the raw transaction keeps the price that was entered, always.
 */

import { resolveWithdrawalUnitPriceBaht } from "@/lib/white-sheet/calculate";
import { normalizedMarketLabel } from "@/lib/market";
import {
  centralPriceKey,
  centralPriceMapKey,
  SYSTEM_WITHDRAWAL_SEED_ACTOR,
  type CentralPriceMapEntry,
} from "@/lib/white-sheet/pricing";

/** One price that really appears on the day's withdrawals. */
export interface CentralPriceCandidate {
  priceSatang: number;
  /** How many withdrawal rows carry it. */
  occurrenceCount: number;
  /** Every market it was entered in, sorted. */
  affectedMarkets: string[];
}

export type CentralPriceStatus =
  /** Several prices exist and no administrator has chosen one. */
  | "unresolved"
  /** An administrator explicitly set the price for this identity. */
  | "approved"
  /** One price only, established by the deployed first-withdrawal seed rule. */
  | "seeded"
  /** Withdrawals exist but no central price row does. */
  | "missing";

export interface CentralPriceReviewItem {
  productKey: string;
  /** The product as the operator wrote it — for display only, never identity. */
  productDisplayName: string;
  unitKey: string;
  businessDate: string;
  status: CentralPriceStatus;
  candidates: CentralPriceCandidate[];
  /** The price reports will actually use, or null when none is set. */
  approvedPriceSatang: number | null;
  /** Who set it: an admin actor id, the seed sentinel, or null. */
  approvedBy: string | null;
}

/** One withdrawal row, reduced to what pricing needs. */
export interface WithdrawalPriceRow {
  productName: string | null;
  unit: string | null;
  marketName: string | null;
  pricePerUnit: number | null;
  basisQuantity: number | null;
  baseTransactionType: string | null;
}

interface CandidateAggregate {
  productDisplayName: string;
  prices: Map<number, { count: number; markets: Set<string> }>;
}

/**
 * Group the day's withdrawal prices by the SAME canonical identity the report
 * prices with (centralPriceKey), so a candidate list can never describe an
 * identity the calculator files under a different key.
 *
 * Rows missing a product, a unit or a price contribute nothing: they are not
 * evidence of a price, and the existing entry validation already reports them.
 */
export function collectCentralPriceCandidates(
  rows: readonly WithdrawalPriceRow[],
  businessDate: string,
): Map<string, CandidateAggregate & { productKey: string; unitKey: string }> {
  const byIdentity = new Map<
    string,
    CandidateAggregate & { productKey: string; unitKey: string }
  >();

  for (const row of rows) {
    if (row.baseTransactionType?.trim() !== "เบิก") continue;
    const productName = row.productName?.trim();
    const rawUnit = row.unit?.trim();
    if (!productName || !rawUnit || row.pricePerUnit === null) continue;

    let key;
    try {
      key = centralPriceKey({ productName, unit: rawUnit, businessDate });
    } catch {
      // An identity the pricing boundary refuses cannot be reviewed here; the
      // Sales report already blocks it through invalid_identity.
      continue;
    }
    const mapKey = centralPriceMapKey(key.productKey, key.unitKey);

    const priceSatang = Math.round(
      resolveWithdrawalUnitPriceBaht({
        unit: rawUnit,
        unitPrice: Number(row.pricePerUnit),
        basisQuantity: row.basisQuantity === null ? null : Number(row.basisQuantity),
      }) * 100,
    );

    const entry = byIdentity.get(mapKey) ?? {
      productKey: key.productKey,
      unitKey: key.unitKey,
      productDisplayName: productName,
      prices: new Map<number, { count: number; markets: Set<string> }>(),
    };
    const bucket = entry.prices.get(priceSatang) ?? { count: 0, markets: new Set<string>() };
    bucket.count += 1;
    const market = normalizedMarketLabel(row.marketName);
    if (market) bucket.markets.add(market);
    entry.prices.set(priceSatang, bucket);
    byIdentity.set(mapKey, entry);
  }

  return byIdentity;
}

/**
 * The full price review for one business date.
 *
 * Status rules, matching the deployed pricing contract exactly:
 *
 *   no stored row                      → missing
 *   stored by an admin                 → approved  (BR-04: an explicit choice)
 *   stored by the seed, one candidate  → seeded    (BR-01: nothing to dispute)
 *   stored by the seed, several        → unresolved
 *
 * The last line is the same test resolveCentralPricesForDate already uses to
 * demote a sales figure, restated over the candidate set rather than row by
 * row — so the review and the report can never disagree about what is disputed.
 */
export function buildCentralPriceReview(
  rows: readonly WithdrawalPriceRow[],
  businessDate: string,
  stored: ReadonlyMap<string, CentralPriceMapEntry>,
): CentralPriceReviewItem[] {
  const grouped = collectCentralPriceCandidates(rows, businessDate);
  const items: CentralPriceReviewItem[] = [];

  for (const [mapKey, entry] of grouped) {
    const candidates: CentralPriceCandidate[] = [...entry.prices]
      .map(([priceSatang, bucket]) => ({
        priceSatang,
        occurrenceCount: bucket.count,
        affectedMarkets: [...bucket.markets].sort((a, b) => a.localeCompare(b, "th")),
      }))
      .sort((a, b) => a.priceSatang - b.priceSatang);

    const storedEntry = stored.get(mapKey);
    const adminSet = Boolean(storedEntry) && storedEntry!.setBy !== SYSTEM_WITHDRAWAL_SEED_ACTOR;

    let status: CentralPriceStatus;
    if (!storedEntry) status = "missing";
    else if (adminSet) status = "approved";
    else status = candidates.length > 1 ? "unresolved" : "seeded";

    items.push({
      productKey: entry.productKey,
      productDisplayName: entry.productDisplayName,
      unitKey: entry.unitKey,
      businessDate,
      status,
      candidates,
      approvedPriceSatang: storedEntry?.priceSatang ?? null,
      approvedBy: storedEntry?.setBy ?? null,
    });
  }

  return items.sort(
    (a, b) =>
      a.productDisplayName.localeCompare(b.productDisplayName, "th")
      || a.unitKey.localeCompare(b.unitKey, "th"),
  );
}

/** Identities an administrator still has to decide. */
export function unresolvedCentralPrices(
  items: readonly CentralPriceReviewItem[],
): CentralPriceReviewItem[] {
  return items.filter((item) => item.status === "unresolved");
}
