import { describe, expect, test } from "bun:test";
import { cleanMarketName, isIdentifiedMarket } from "./market";

describe("cleanMarketName", () => {
  test("extracts ตลาดกี้ from staff-prefixed session header", () => {
    expect(cleanMarketName("\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569")).toBe(
      "\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49",
    );
  });

  test("extracts ตลาด72 from dash and post-tx headers", () => {
    expect(cleanMarketName("\u0E01\u0E35\u0E49-\u0E15\u0E25\u0E32\u0E1472 \u0E40\u0E1A\u0E34\u0E01 1/6/2569")).toBe(
      "\u0E15\u0E25\u0E32\u0E1472",
    );
    expect(cleanMarketName("\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01\u0E44\u0E1B\u0E15\u0E25\u0E32\u0E1472")).toBe(
      "\u0E15\u0E25\u0E32\u0E1472",
    );
  });

  test("keeps named markets without ตลาด prefix", () => {
    expect(cleanMarketName("\u0E15\u0E49\u0E2D\u0E21-\u0E1E\u0E32\u0E0B\u0E34\u0E42\u0E2D\u0E49\u0E1C\u0E31\u0E01 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 30/06/2569")).toBe(
      "\u0E1E\u0E32\u0E0B\u0E34\u0E42\u0E2D\u0E49\u0E1C\u0E31\u0E01",
    );
    expect(cleanMarketName("\u0E15\u0E25\u0E32\u0E1480")).toBe("\u0E15\u0E25\u0E32\u0E1480");
  });

  test("returns null for transaction-only session titles", () => {
    expect(cleanMarketName("\u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19")).toBeNull();
    expect(cleanMarketName("\u0E0A\u0E48\u0E32\u0E07\u0E04\u0E37\u0E19\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48 23 \u0E21\u0E34\u0E16\u0E38\u0E19\u0E32 2569")).toBeNull();
    expect(cleanMarketName("\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01")).toBeNull();
    expect(cleanMarketName("\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E40\u0E1A\u0E34\u0E01\u0E1C\u0E31\u0E01")).toBeNull();
    expect(cleanMarketName("\u0E40\u0E1A\u0E34\u0E01")).toBeNull();
    expect(cleanMarketName("\u0E04\u0E37\u0E1923/6/69")).toBeNull();
    expect(cleanMarketName("\u0E04\u0E37\u0E19\u0E1C\u0E31\u0E01")).toBeNull();
    expect(cleanMarketName("\u0E04\u0E37\u0E19\u0E1C\u0E31\u0E0123/6/69")).toBeNull();
  });
});

describe("isIdentifiedMarket", () => {
  test("matches cleanMarketName nullability", () => {
    expect(isIdentifiedMarket("\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569")).toBe(true);
    expect(isIdentifiedMarket("\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01")).toBe(false);
  });
});
