import { describe, expect, test } from "bun:test";
import { buildDailyGoodReturnValueMessages, buildDailyGoodReturnValueReport } from "./daily-good-return-value";
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
});
