/**
 * Exact money for Produce line totals, matching PostgreSQL NUMERIC bit for bit.
 *
 * THE AUTHORITY
 * -------------
 * public.produce_transactions (0033_produce_basis_pricing.sql) computes
 * total_amount as:
 *
 *   basis row:  ROUND(quantity * basis_price / basis_quantity, 2)
 *   unit row:   quantity * price_per_unit          -- NOT rounded
 *
 * Both operands are NUMERIC, so PostgreSQL is exact: quantity is numeric(10,3)
 * and both prices are numeric(10,2). A unit row's total therefore carries up to
 * FIVE decimal places and PostgreSQL keeps every one of them; only the basis
 * branch rounds, and it rounds at the row.
 *
 * WHY THE OLD LINE TOTAL DIVERGED
 * -------------------------------
 * reply.ts computed the same thing in IEEE-754 doubles and rounded the unit
 * branch nowhere and the basis branch with a float round2. Two independent
 * errors followed:
 *
 *   1. binary representation — 0.1 * 3 is 0.30000000000000004, so a total could
 *      differ from the database in the last satang;
 *   2. premature/absent rounding — summing floats accumulates error, and
 *      rounding each unit row (which the database does NOT do) changes the
 *      total whenever the sub-satang parts of several rows would have carried.
 *
 * THE MODEL
 * ---------
 * Every quantity and price is read as a scaled BigInt, never as a float:
 *
 *   quantity        scale 1e3   (numeric(10,3))
 *   price           scale 1e2   (numeric(10,2))
 *   LINE TOTAL      scale 1e5   -- exactly 1e3 * 1e2, so a unit row is exact
 *
 * A basis row is rounded half-up to 2dp at the row, exactly where the database
 * rounds, then widened to scale 1e5. A unit row keeps all five places. Sums are
 * BigInt additions, so they are exact, and rounding to satang happens once, at
 * the end, for display only.
 */

import { roundHalfUp } from "@/lib/sales/calculate";

/** Decimal places the line-total scale carries: 1e3 (quantity) * 1e2 (price). */
export const LINE_TOTAL_SCALE_DIGITS = 5;
const LINE_TOTAL_SCALE = BigInt(10) ** BigInt(LINE_TOTAL_SCALE_DIGITS);
const SATANG_SCALE = BigInt(100);
/** Widens a satang-scaled (1e2) value to the line-total scale (1e5). */
const SATANG_TO_LINE_TOTAL = LINE_TOTAL_SCALE / SATANG_SCALE;

/**
 * Read a decimal as a BigInt scaled by 10^digits, exactly.
 *
 * Accepts a string (the exact text) or a number (what the parser hands us
 * today). A number is stringified first — `String(2.01)` is "2.01", so the
 * decimal the operator typed is recovered rather than the binary value being
 * multiplied. Returns null for anything that is not a finite, in-range decimal
 * with at most `digits` decimal places, so a malformed or over-precise input
 * fails closed instead of silently truncating.
 */
export function toScaledDecimal(
  value: number | string | null | undefined,
  digits: number,
): bigint | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number"
    ? (Number.isFinite(value) ? String(value) : "")
    : value.trim();

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;

  const [, sign, whole, fraction = ""] = match;
  // More precision than the column can hold is a real disagreement with the
  // database, not something to round away silently.
  if (fraction.length > digits) return null;

  const padded = fraction.padEnd(digits, "0");
  const magnitude = BigInt(`${whole}${padded}`);
  return sign === "-" ? -magnitude : magnitude;
}

export interface ExactLineTotalInput {
  quantity: number | string | null | undefined;
  pricePerUnit: number | string | null | undefined;
  basisQuantity: number | string | null | undefined;
  basisPrice: number | string | null | undefined;
}

/**
 * One line total, scaled by 1e5, or null when the row has no computable total —
 * the same rows for which the database's CASE yields NULL.
 */
export function exactLineTotalScaled(item: ExactLineTotalInput): bigint | null {
  const quantity = toScaledDecimal(item.quantity, 3);
  const basisQuantity = toScaledDecimal(item.basisQuantity, 3);
  const basisPrice = toScaledDecimal(item.basisPrice, 2);

  // Basis branch, exactly the database's condition.
  if (
    basisQuantity !== null && basisQuantity !== BigInt(0)
    && basisPrice !== null
    && quantity !== null
  ) {
    // ROUND(quantity * basis_price / basis_quantity, 2).
    //   quantity/1e3 * basisPrice/1e2 / (basisQuantity/1e3)
    // scaled to 1e2 is exactly quantity * basisPrice / basisQuantity.
    const numerator = quantity * basisPrice;
    const satang = numerator < BigInt(0)
      // roundHalfUp is unsigned; mirror PostgreSQL's round-half-away-from-zero
      // by rounding the magnitude and restoring the sign.
      ? -roundHalfUp(-numerator, basisQuantity < BigInt(0) ? -basisQuantity : basisQuantity)
      : roundHalfUp(numerator, basisQuantity < BigInt(0) ? -basisQuantity : basisQuantity);
    return satang * SATANG_TO_LINE_TOTAL;
  }

  const pricePerUnit = toScaledDecimal(item.pricePerUnit, 2);
  if (quantity !== null && pricePerUnit !== null) {
    // Unit branch: NOT rounded. 1e3 * 1e2 = 1e5, so this is already exact at
    // the line-total scale and every sub-satang place survives into the sum.
    return quantity * pricePerUnit;
  }

  return null;
}

/** Exact sum of line totals, scaled by 1e5. Missing totals contribute nothing. */
export function sumExactLineTotalsScaled(items: readonly ExactLineTotalInput[]): bigint {
  let total = BigInt(0);
  for (const item of items) {
    total += exactLineTotalScaled(item) ?? BigInt(0);
  }
  return total;
}

/**
 * Round a line-total-scaled value to satang, half-up away from zero — the same
 * rule PostgreSQL's ROUND(numeric, 2) applies. Display only: never round before
 * aggregating, or unit rows lose the sub-satang parts the database keeps.
 */
export function scaledToSatang(scaled: bigint): bigint {
  const divisor = SATANG_TO_LINE_TOTAL;
  return scaled < BigInt(0)
    ? -roundHalfUp(-scaled, divisor)
    : roundHalfUp(scaled, divisor);
}

/**
 * The baht value for display. Exact through the BigInt arithmetic above; the
 * final Number is a satang-precision value, well inside the safe range for any
 * plausible session total.
 */
export function scaledToBaht(scaled: bigint): number {
  return Number(scaledToSatang(scaled)) / 100;
}
