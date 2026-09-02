/**
 * Exact money for Produce line totals.
 *
 * The authority is public.produce_transactions (0033_produce_basis_pricing.sql):
 *
 *   basis row:  ROUND(quantity * basis_price / basis_quantity, 2)
 *   unit row:   quantity * price_per_unit          -- NOT rounded
 *
 * PostgreSQL evaluates both in NUMERIC, so it is exact. These tests pin the
 * TypeScript side to the same arithmetic. The end-to-end parity against a real
 * server is in exact-line-total.pg.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  exactLineTotalScaled,
  scaledToBaht,
  scaledToSatang,
  sumExactLineTotalsScaled,
  toScaledDecimal,
} from "./exact-line-total";

const unit = (quantity: number | string, pricePerUnit: number | string) =>
  ({ quantity, pricePerUnit, basisQuantity: null, basisPrice: null });

const basis = (
  quantity: number | string,
  basisPrice: number | string,
  basisQuantity: number | string,
) => ({ quantity, pricePerUnit: null, basisQuantity, basisPrice });

describe("toScaledDecimal reads the decimal, never the binary value", () => {
  it("scales the classic float offenders exactly", () => {
    expect(toScaledDecimal("2.01", 2)).toBe(BigInt(201));
    expect(toScaledDecimal("10.05", 2)).toBe(BigInt(1005));
    expect(toScaledDecimal("1.10", 2)).toBe(BigInt(110));
    expect(toScaledDecimal("0.1", 2)).toBe(BigInt(10));
    expect(toScaledDecimal("0.2", 2)).toBe(BigInt(20));
    expect(toScaledDecimal("0.3", 2)).toBe(BigInt(30));
    expect(toScaledDecimal("8.29", 2)).toBe(BigInt(829));
    expect(toScaledDecimal("1.15", 2)).toBe(BigInt(115));
  });

  it("reads a number through its decimal text, so 2.01 is 201 satang", () => {
    // Number(2.01) * 100 is 200.99999999999997. This must not be.
    expect(toScaledDecimal(2.01, 2)).toBe(BigInt(201));
    expect(toScaledDecimal(10.05, 2)).toBe(BigInt(1005));
    expect(toScaledDecimal(1.1, 2)).toBe(BigInt(110));
  });

  it("pads to the column scale", () => {
    expect(toScaledDecimal("5", 3)).toBe(BigInt(5000));
    expect(toScaledDecimal("5.5", 3)).toBe(BigInt(5500));
    expect(toScaledDecimal("0", 2)).toBe(BigInt(0));
  });

  it("fails closed on excessive precision rather than truncating", () => {
    expect(toScaledDecimal("1.234", 2)).toBeNull();
    expect(toScaledDecimal("1.0001", 3)).toBeNull();
  });

  it("fails closed on invalid and non-finite input", () => {
    expect(toScaledDecimal("", 2)).toBeNull();
    expect(toScaledDecimal("abc", 2)).toBeNull();
    expect(toScaledDecimal("1.2.3", 2)).toBeNull();
    expect(toScaledDecimal("1e5", 2)).toBeNull();
    expect(toScaledDecimal(Number.NaN, 2)).toBeNull();
    expect(toScaledDecimal(Number.POSITIVE_INFINITY, 2)).toBeNull();
    expect(toScaledDecimal(null, 2)).toBeNull();
    expect(toScaledDecimal(undefined, 2)).toBeNull();
  });

  it("keeps a sign rather than silently dropping it", () => {
    expect(toScaledDecimal("-1.50", 2)).toBe(-BigInt(150));
  });
});

describe("unit rows are exact and NOT rounded, exactly like the database", () => {
  it("computes the float offenders correctly", () => {
    // 3 × 2.01 = 6.03 exactly. In floats 3 * 2.01 is 6.029999999999999.
    expect(scaledToBaht(exactLineTotalScaled(unit(3, "2.01"))!)).toBe(6.03);
    expect(scaledToBaht(exactLineTotalScaled(unit(3, "0.1"))!)).toBe(0.3);
    expect(scaledToBaht(exactLineTotalScaled(unit(1, "10.05"))!)).toBe(10.05);
  });

  it("keeps sub-satang precision in the scaled value", () => {
    // 0.001 โล × 0.01 บาท = 0.00001 บาท. The database keeps this; so must we.
    expect(exactLineTotalScaled(unit("0.001", "0.01"))).toBe(BigInt(1));
    expect(scaledToSatang(exactLineTotalScaled(unit("0.001", "0.01"))!)).toBe(BigInt(0));
  });

  it("scales 1e3 × 1e2 into 1e5 without loss", () => {
    expect(exactLineTotalScaled(unit("1.234", "5.67"))).toBe(BigInt(1234) * BigInt(567));
  });
});

describe("basis rows round half-up at the row, exactly like the database", () => {
  it("matches the documented 32 หัว × 20 บาท / 3 หัว = 213.33", () => {
    expect(scaledToBaht(exactLineTotalScaled(basis(32, 20, 3))!)).toBe(213.33);
  });

  it("rounds half-up away from zero at the boundary", () => {
    // 1 × 0.05 / 2 = 0.025 -> 0.03
    expect(scaledToBaht(exactLineTotalScaled(basis(1, "0.05", 2))!)).toBe(0.03);
    // 1 × 0.15 / 2 = 0.075 -> 0.08
    expect(scaledToBaht(exactLineTotalScaled(basis(1, "0.15", 2))!)).toBe(0.08);
  });

  it("stays just below and just above a rounding boundary", () => {
    // 0.024999 -> 0.02 ; 0.025001 -> 0.03
    expect(scaledToBaht(exactLineTotalScaled(basis("0.999", "0.05", 2))!)).toBe(0.02);
    expect(scaledToBaht(exactLineTotalScaled(basis("1.001", "0.05", 2))!)).toBe(0.03);
  });

  it("returns null exactly where the database CASE yields NULL", () => {
    expect(exactLineTotalScaled(basis(1, 10, 0))).toBeNull();
    expect(exactLineTotalScaled({
      quantity: null, pricePerUnit: null, basisQuantity: null, basisPrice: null,
    })).toBeNull();
    expect(exactLineTotalScaled({
      quantity: 5, pricePerUnit: null, basisQuantity: null, basisPrice: null,
    })).toBeNull();
  });
});

describe("aggregation rounds once, at the end", () => {
  it("does NOT round each unit row before summing", () => {
    // Ten rows of 0.005 บาท. Rounding each to satang gives 10 × 0.01 = 0.10;
    // the database sums the unrounded values to exactly 0.05.
    const rows = Array.from({ length: 10 }, () => unit("0.5", "0.01"));
    expect(scaledToBaht(sumExactLineTotalsScaled(rows))).toBe(0.05);
  });

  it("carries sub-satang parts across rows the way NUMERIC does", () => {
    // 3 × 0.333 โล at 0.01 บาท = 0.00999 บาท -> 0.01 once, not 0.00 three times.
    const rows = Array.from({ length: 3 }, () => unit("0.333", "0.01"));
    expect(sumExactLineTotalsScaled(rows)).toBe(BigInt(999));
    expect(scaledToBaht(sumExactLineTotalsScaled(rows))).toBe(0.01);
  });

  it("mixes basis and unit rows without drift", () => {
    const rows = [basis(32, 20, 3), unit(3, "2.01"), unit("0.001", "0.01")];
    // 213.33 + 6.03 + 0.00001 = 219.36001 -> 219.36
    expect(sumExactLineTotalsScaled(rows)).toBe(BigInt(21333000) + BigInt(603000) + BigInt(1));
    expect(scaledToBaht(sumExactLineTotalsScaled(rows))).toBe(219.36);
  });

  it("sums a long run of float-hostile values exactly", () => {
    // 0.1 + 0.2 repeatedly. In floats this drifts; here it cannot.
    const rows = [
      ...Array.from({ length: 50 }, () => unit(1, "0.1")),
      ...Array.from({ length: 50 }, () => unit(1, "0.2")),
    ];
    expect(scaledToBaht(sumExactLineTotalsScaled(rows))).toBe(15);
  });

  it("treats a row with no computable total as zero, never NaN", () => {
    const rows = [unit(2, "1.50"), {
      quantity: null, pricePerUnit: null, basisQuantity: null, basisPrice: null,
    }];
    expect(scaledToBaht(sumExactLineTotalsScaled(rows))).toBe(3);
  });
});

describe("large but valid values stay exact", () => {
  it("handles the top of numeric(10,3) × numeric(10,2)", () => {
    // 9,999,999.999 โล × 9,999,999.99 บาท is far past Number.MAX_SAFE_INTEGER
    // in satang, so BigInt is doing the work.
    const scaled = exactLineTotalScaled(unit("9999999.999", "9999999.99"))!;
    expect(scaled).toBe(BigInt(9999999999) * BigInt(999999999));
    expect(scaled > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe("no floating point is used as monetary authority", () => {
  it("the module never multiplies a money value by 100 in floating point", async () => {
    const source = await Bun.file(
      new URL("./exact-line-total.ts", import.meta.url),
    ).text();
    // The exact bug this replaces.
    expect(source).not.toMatch(/Number\([^)]*\)\s*\*\s*100/);
    expect(source).toContain("BigInt");
  });
});
