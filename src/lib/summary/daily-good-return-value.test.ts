import { describe, expect, test } from "bun:test";
import { buildDailyGoodReturnValueMessages, buildDailyGoodReturnValueReport } from "./daily-good-return-value";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "./line-chunking";
import type { RemainingFruitSourceRow } from "./remaining-fruit";

const base = (overrides: Partial<RemainingFruitSourceRow>): RemainingFruitSourceRow => ({ market_name: "ตลาด A", product_name: "หมอนทอง", quantity: 1, unit: "โล", transaction_type: "คืน", ...overrides });

describe("daily good-return value", () => {
  test("values each market before combining product totals", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาด A", transaction_type: "เบิก", quantity: 20, price_per_unit: 40 }),
      base({ market_name: "ตลาด A", quantity: 7 }),
      base({ market_name: "ตลาด B", transaction_type: "เบิก", quantity: 20, price_per_unit: 50 }),
      base({ market_name: "ตลาด B", quantity: 2 }),
    ]);
    expect(report.products[0]).toMatchObject({ quantity: 9, valuedQuantity: 9, unvaluedQuantity: 0, valueSatang: 38_000 });
  });

  test("fails closed for absent, conflicting, or structurally impossible withdrawal evidence", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ product_name: "A", quantity: 3 }),
      base({ product_name: "B", transaction_type: "เบิก", quantity: 5, price_per_unit: 10 }), base({ product_name: "B", transaction_type: "เบิก", quantity: 5, price_per_unit: 20 }), base({ product_name: "B", quantity: 3 }),
      base({ product_name: "C", transaction_type: "เบิก", quantity: 2, price_per_unit: 10 }), base({ product_name: "C", quantity: 3 }),
    ]);
    expect(report.products.every((row) => row.valueSatang === 0 && row.unvaluedQuantity === row.quantity)).toBe(true);
    expect(buildDailyGoodReturnValueMessages(report).join("\n")).not.toMatch(/^\d+\. .*0\.00 บาท/m);
  });

  test("caps each scheduled message at fifteen product rows with continuous numbering", () => {
    const rows = Array.from({ length: 16 }, (_, i) => [base({ product_name: `P${i}`, transaction_type: "เบิก", quantity: 2, price_per_unit: 10 }), base({ product_name: `P${i}`, quantity: 1 })]).flat();
    const messages = buildDailyGoodReturnValueMessages(buildDailyGoodReturnValueReport("2026-08-01", rows));
    expect(messages).toHaveLength(2); expect(messages[0]).toContain("รายการ 1–15"); expect(messages[1]).toContain("รายการ 16–16"); expect(messages[0]).toContain("15. "); expect(messages[1]).toContain("16. ");
  });

  test("fails closed on every invalid withdrawal price while accepting a proven zero", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ product_name: "null", transaction_type: "เบิก", quantity: 2, price_per_unit: 40 }), base({ product_name: "null", transaction_type: "เบิก", quantity: 2, price_per_unit: null }), base({ product_name: "null", quantity: 1 }),
      base({ product_name: "negative", transaction_type: "เบิก", quantity: 2, price_per_unit: -1 }), base({ product_name: "negative", quantity: 1 }),
      base({ product_name: "zero", transaction_type: "เบิก", quantity: 2, price_per_unit: 0 }), base({ product_name: "zero", transaction_type: "เบิก", quantity: 2, price_per_unit: 0 }), base({ product_name: "zero", quantity: 1 }),
      base({ product_name: "conflict", transaction_type: "เบิก", quantity: 2, price_per_unit: 0 }), base({ product_name: "conflict", transaction_type: "เบิก", quantity: 2, price_per_unit: 10 }), base({ product_name: "conflict", quantity: 1 }),
    ]);
    expect(report.products.find((row) => row.productName === "null")?.blockers).toContain("รายการเบิกไม่มีราคา");
    expect(report.products.find((row) => row.productName === "negative")?.blockers).toContain("รายการเบิกไม่มีราคา");
    expect(report.products.find((row) => row.productName === "zero")).toMatchObject({ valuedQuantity: 1, unvaluedQuantity: 0, valueSatang: 0 });
    expect(report.products.find((row) => row.productName === "conflict")?.blockers).toContain("ราคาจากรายการเบิกขัดแย้งกัน");
  });

  test("never matches unresolved markets and keeps their return visible but unvalued", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: null, transaction_type: "เบิก", quantity: 2, price_per_unit: 40 }), base({ market_name: null, quantity: 1 }),
      base({ market_name: "", transaction_type: "เบิก", quantity: 2, price_per_unit: 40 }), base({ market_name: "", quantity: 1 }),
      base({ market_name: "ตลาด A", transaction_type: "เบิก", quantity: 2, price_per_unit: 50 }), base({ market_name: "ตลาด A", quantity: 1 }),
    ]);
    expect(report.products[0]).toMatchObject({ quantity: 3, valuedQuantity: 1, unvaluedQuantity: 2, valueSatang: 5_000 });
    expect(report.products[0]?.blockers).toContain("ระบุตลาดไม่ได้");
  });

  test("keeps atomic product blocks within the LINE code-point limit", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ product_name: "ย".repeat(3_900), transaction_type: "เบิก", quantity: 2, price_per_unit: 10 }),
      base({ product_name: "ย".repeat(3_900), quantity: 1 }),
      base({ product_name: "short", transaction_type: "เบิก", quantity: 2, price_per_unit: 10 }), base({ product_name: "short", quantity: 1 }),
    ]);
    const messages = buildDailyGoodReturnValueMessages(report);
    expect(messages.every((message) => countCodePoints(message) <= LINE_MESSAGE_MAX_CODE_POINTS)).toBe(true);
    expect(messages.join("\n")).toContain("รายการยาวเกินขีดจำกัด LINE");
  });
});
