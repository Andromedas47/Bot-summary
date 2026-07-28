import { describe, expect, test } from "bun:test";
import {
  parseExactDecimal,
  parseExactDocumentMoney,
  PURCHASE_QUANTITY_MAX_SCALE,
  PURCHASE_QUANTITY_MAX_TOTAL_DIGITS,
  PURCHASE_UNIT_RATE_MAX_SCALE,
  PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS,
} from "./index";

function quantity(raw: string) {
  return parseExactDecimal(raw, {
    maxTotalDigits: PURCHASE_QUANTITY_MAX_TOTAL_DIGITS,
    maxScale: PURCHASE_QUANTITY_MAX_SCALE,
  });
}

function unitRate(raw: string) {
  return parseExactDecimal(raw, {
    maxTotalDigits: PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS,
    maxScale: PURCHASE_UNIT_RATE_MAX_SCALE,
  });
}

function errorCodes(result: ReturnType<typeof quantity>): string[] {
  return result.errors.map((error) => error.code);
}

describe("exact purchase decimals", () => {
  test("retains exact coefficient, typed scale, digit count, raw, and canonical", () => {
    const result = quantity("0001.2300");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      raw: "0001.2300",
      canonical: "1.2300",
      coefficient: BigInt("12300"),
      scale: 4,
      totalDigits: 8,
    });
  });

  test("quantity accepts its exact maximum boundary", () => {
    const result = quantity("999999999999.999999");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.coefficient).toBe(BigInt("999999999999999999"));
    expect(result.value.totalDigits).toBe(18);
    expect(result.value.scale).toBe(6);
  });

  test("quantity rejects scale and total-digit overflow without truncating", () => {
    expect(errorCodes(quantity("1.1234567"))).toContain(
      "NUMERIC_SCALE_EXCEEDED",
    );
    expect(errorCodes(quantity("1000000000000.000000"))).toContain(
      "NUMERIC_VALUE_TOO_LARGE",
    );
  });

  test("typed zeros count toward the digit limit before bigint conversion", () => {
    expect(quantity("000000000000000000").ok).toBe(true);
    expect(errorCodes(quantity("0000000000000000000"))).toContain(
      "NUMERIC_VALUE_TOO_LARGE",
    );
  });

  test("values above IEEE-754 safe integer remain exact", () => {
    const result = quantity("9007199254740993");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.coefficient).toBe(BigInt("9007199254740993"));
    expect(result.value.canonical).toBe("9007199254740993");
  });

  test("unit rate accepts its exact maximum boundary", () => {
    const result = unitRate("99999999999999.9999");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDigits).toBe(18);
    expect(result.value.scale).toBe(4);
  });

  test("unit rate rejects a fifth fractional digit and nineteenth total digit", () => {
    expect(errorCodes(unitRate("1.00000"))).toContain(
      "NUMERIC_SCALE_EXCEEDED",
    );
    expect(errorCodes(unitRate("100000000000000.0000"))).toContain(
      "NUMERIC_VALUE_TOO_LARGE",
    );
  });

  test.each([
    "",
    ".5",
    "1.",
    "1..0",
    "+1",
    "-1",
    "−1",
    "1,000",
    "1e3",
    "1E3",
    "๑",
    "１",
    "NaN",
    "Infinity",
    "1 0",
  ])("rejects forbidden numeric form %p", (raw) => {
    expect(errorCodes(quantity(raw))).toEqual(["INVALID_NUMERIC_FORMAT"]);
  });

  test("rejects a huge numeric value before attempting bigint construction", () => {
    const result = quantity("9".repeat(10_000));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("NUMERIC_VALUE_TOO_LARGE");
  });
});

describe("exact document money", () => {
  test("accepts the exact 15-digit boundary", () => {
    const result = parseExactDocumentMoney("9999999999999.99");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.satang).toBe(BigInt("999999999999999"));
  });

  test("rejects digit and scale overflow without rounding", () => {
    expect(
      parseExactDocumentMoney("10000000000000.00").errors.map(
        (error) => error.code,
      ),
    ).toContain("NUMERIC_VALUE_TOO_LARGE");
    expect(
      parseExactDocumentMoney("1.234").errors.map((error) => error.code),
    ).toContain("NUMERIC_SCALE_EXCEEDED");
  });

  test.each([
    ["0", "0"],
    ["1", "100"],
    ["1.2", "120"],
    ["1.20", "120"],
    ["0.01", "1"],
    ["0.29", "29"],
  ])("converts %s to exactly %s satang", (raw, expected) => {
    const result = parseExactDocumentMoney(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.satang).toBe(BigInt(expected));
  });
});
