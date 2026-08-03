import { describe, expect, test } from "bun:test";
import { buildDailyGoodReturnValueMessages, buildDailyGoodReturnValueReport } from "./daily-good-return-value";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "./line-chunking";
import type { RemainingFruitSourceRow } from "./remaining-fruit";
import type { GoodReturnValueProduct } from "./daily-good-return-value";

const base = (overrides: Partial<RemainingFruitSourceRow>): RemainingFruitSourceRow => ({ market_name: "ตลาด A", product_name: "หมอนทอง", quantity: 1, unit: "โล", transaction_type: "คืน", ...overrides });
const valued = (productName: string): GoodReturnValueProduct => ({ productName, unit: "โล", quantity: 1, valuedQuantity: 1, unvaluedQuantity: 0, valueSatang: 1_000, anomalyMarketCount: 0 });

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
    expect(report.anomalies.find((row) => row.productName === "null")?.blockers).toContain("รายการเบิกไม่มีราคา");
    expect(report.anomalies.find((row) => row.productName === "negative")?.blockers).toContain("รายการเบิกไม่มีราคา");
    expect(report.products.find((row) => row.productName === "zero")).toMatchObject({ valuedQuantity: 1, unvaluedQuantity: 0, valueSatang: 0 });
    expect(report.anomalies.find((row) => row.productName === "conflict")?.blockers).toContain("ราคาจากรายการเบิกขัดแย้งกัน");
  });

  test("never matches unresolved markets and keeps their return visible but unvalued", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: null, transaction_type: "เบิก", quantity: 2, price_per_unit: 40 }), base({ market_name: null, quantity: 1 }),
      base({ market_name: "", transaction_type: "เบิก", quantity: 2, price_per_unit: 40 }), base({ market_name: "", quantity: 1 }),
      base({ market_name: "ตลาด A", transaction_type: "เบิก", quantity: 2, price_per_unit: 50 }), base({ market_name: "ตลาด A", quantity: 1 }),
    ]);
    // Both unresolved-market rows render as "ไม่ทราบตลาด" and are indistinguishable by name,
    // so they collapse to one counted market even though both anomaly rows stay visible.
    expect(report.products[0]).toMatchObject({ productName: "หมอนทอง", unit: "โล", quantity: 3, valuedQuantity: 1, unvaluedQuantity: 2, valueSatang: 5_000, anomalyMarketCount: 1 });
    expect(report.anomalies.filter((row) => row.blockers.includes("ระบุตลาดไม่ได้"))).toHaveLength(2);
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

  test("rechecks an oversized row after flushing a short row", () => {
    const messages = buildDailyGoodReturnValueMessages({ businessDate: "2026-08-01", products: [valued("ก"), valued("ย".repeat(3_920))], anomalies: [], hasActivity: true });
    expect(messages.every((message) => countCodePoints(message) <= LINE_MESSAGE_MAX_CODE_POINTS)).toBe(true);
    expect(messages.join("\n")).toContain("2. รายการยาวเกินขีดจำกัด LINE");
    expect(messages.join("\n")).toContain("ไม่ได้แสดงสินค้าบางส่วน 1 รายการ เนื่องจากขีดจำกัด LINE");
    expect(messages.at(-1)).toContain("รวมมูลค่าของดีที่ยืนยันได้ 20.00 บาท");
  });

  test("counts each oversized fallback once without renumbering later rows", () => {
    const messages = buildDailyGoodReturnValueMessages({ businessDate: "2026-08-01", products: [valued("ย".repeat(3_920)), valued("ย".repeat(3_920)), valued("short")], anomalies: [], hasActivity: true });
    expect(messages.every((message) => countCodePoints(message) <= LINE_MESSAGE_MAX_CODE_POINTS)).toBe(true);
    expect(messages.join("\n")).toContain("1. รายการยาวเกินขีดจำกัด LINE");
    expect(messages.join("\n")).toContain("2. รายการยาวเกินขีดจำกัด LINE");
    expect(messages.join("\n")).toContain("3. short");
    expect(messages.at(-1)).toContain("ไม่ได้แสดงสินค้าบางส่วน 2 รายการ เนื่องจากขีดจำกัด LINE");
  });

  test("combines capacity and oversized display omissions in final summary only", () => {
    const products = [valued("ย".repeat(3_920)), ...Array.from({ length: 75 }, (_, index) => valued(`P${index}`))];
    const messages = buildDailyGoodReturnValueMessages({ businessDate: "2026-08-01", products, anomalies: [], hasActivity: true });
    expect(messages.length).toBeLessThanOrEqual(5);
    expect(messages.every((message) => countCodePoints(message) <= LINE_MESSAGE_MAX_CODE_POINTS)).toBe(true);
    expect(messages.at(-1)).toContain("ไม่ได้แสดงสินค้าบางส่วน 31 รายการ เนื่องจากขีดจำกัด LINE");
    expect(messages.slice(0, -1).join("\n")).not.toContain("ไม่ได้แสดงสินค้าบางส่วน");
  });

  // ── Market-level anomaly business rules ───────────────────────────────────

  test("1. a withdrawal with no good return is normal — no product row, no warning", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ transaction_type: "เบิก", quantity: 5, price_per_unit: 40 }),
    ]);
    expect(report.products).toHaveLength(0);
    expect(report.anomalies).toHaveLength(0);
    const text = buildDailyGoodReturnValueMessages(report, { latest: { status: "none" } }).join("\n");
    expect(text).not.toContain("ไม่มีข้อมูลชั่งคืน");
    expect(text).not.toContain("ไม่ครบ");
  });

  test("2. clean good return with one valid matching price produces no anomaly", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ quantity: 7 }),
    ]);
    expect(report.products[0]).toMatchObject({ quantity: 7, valuedQuantity: 7, unvaluedQuantity: 0, valueSatang: 28_000, anomalyMarketCount: 0 });
    expect(report.anomalies).toHaveLength(0);
    expect(buildDailyGoodReturnValueMessages(report).join("\n")).not.toContain("⚠️ รายละเอียดข้อมูลผิดปกติ");
  });

  test("3. good return with no matching withdrawal: quantity included, value excluded, market shown", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [base({ market_name: "ตลาดปลา", quantity: 29.7 })]);
    expect(report.products[0]).toMatchObject({ quantity: 29.7, valuedQuantity: 0, unvaluedQuantity: 29.7, valueSatang: 0 });
    expect(report.anomalies).toEqual([
      expect.objectContaining({ marketName: "ตลาดปลา", productName: "หมอนทอง", withdrawnQuantity: 0, returnedQuantity: 29.7, damagedQuantity: 0, blockers: ["ไม่พบรายการเบิกที่ตรงกัน"], unvaluedQuantity: 29.7, valueSatang: 0 }),
    ]);
  });

  test("4. good return greater than withdrawal: fail-closed with exact market and quantities", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาดปลา", quantity: 29.7 }),
    ]);
    expect(report.products[0]).toMatchObject({ quantity: 29.7, valuedQuantity: 0, unvaluedQuantity: 29.7, valueSatang: 0 });
    expect(report.anomalies).toEqual([
      expect.objectContaining({ marketName: "ตลาดปลา", withdrawnQuantity: 10, returnedQuantity: 29.7, damagedQuantity: 0, blockers: ["คืนมากกว่าเบิก"] }),
    ]);
  });

  test("5. good return plus damaged return greater than withdrawal: exact market and values shown", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาดปลา", quantity: 6 }),
      base({ market_name: "ตลาดปลา", transaction_type: "คืนเสีย", quantity: 5 }),
    ]);
    expect(report.anomalies).toEqual([
      expect.objectContaining({ marketName: "ตลาดปลา", withdrawnQuantity: 10, returnedQuantity: 6, damagedQuantity: 5, blockers: ["คืนและคืนเสียรวมมากกว่าเบิก"] }),
    ]);
  });

  test("6. withdrawal price missing: exact market shown, value excluded, no price evidence", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: 10, price_per_unit: null }),
      base({ market_name: "ตลาดปลา", quantity: 6 }),
    ]);
    expect(report.anomalies).toEqual([
      expect.objectContaining({ marketName: "ตลาดปลา", blockers: ["รายการเบิกไม่มีราคา"], priceEvidence: [] }),
    ]);
  });

  test("7. conflicting prices: exact market shown, both prices represented, value excluded", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดกี้", product_name: "แตงโม", transaction_type: "เบิก", quantity: 20, price_per_unit: 40 }),
      base({ market_name: "ตลาดกี้", product_name: "แตงโม", transaction_type: "เบิก", quantity: 20, price_per_unit: 50 }),
      base({ market_name: "ตลาดกี้", product_name: "แตงโม", quantity: 14 }),
    ]);
    expect(report.anomalies).toEqual([
      expect.objectContaining({ marketName: "ตลาดกี้", productName: "แตงโม", blockers: ["ราคาจากรายการเบิกขัดแย้งกัน"], priceEvidence: [4_000, 5_000] }),
    ]);
    const text = buildDailyGoodReturnValueMessages(report).join("\n");
    expect(text).toContain("ราคาที่พบ: 40.00 บาท, 50.00 บาท");
  });

  test("8. same product across multiple markets: clean market values, abnormal market stays traceable", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาด A", transaction_type: "เบิก", quantity: 20, price_per_unit: 40 }),
      base({ market_name: "ตลาด A", quantity: 20 }),
      base({ market_name: "ตลาด B", quantity: 5 }), // no matching withdrawal at ตลาด B
    ]);
    expect(report.products[0]).toMatchObject({ quantity: 25, valuedQuantity: 20, unvaluedQuantity: 5, valueSatang: 80_000, anomalyMarketCount: 1 });
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({ marketName: "ตลาด B", unvaluedQuantity: 5 });
  });

  test("9. same product and unit has multiple abnormal markets: all shown, affected market count correct", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาด A", quantity: 3 }),
      base({ market_name: "ตลาด B", quantity: 4 }),
    ]);
    expect(report.products[0]).toMatchObject({ anomalyMarketCount: 2 });
    expect(report.anomalies).toHaveLength(2);
    expect(new Set(report.anomalies.map((row) => row.marketName))).toEqual(new Set(["ตลาด A", "ตลาด B"]));
  });

  test("10. different units never merge", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ unit: "โล", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ unit: "โล", quantity: 5 }),
      base({ unit: "ลูก", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ unit: "ลูก", quantity: 5 }),
    ]);
    expect(report.products).toHaveLength(2);
    expect(new Set(report.products.map((row) => row.unit))).toEqual(new Set(["โล", "ลูก"]));
  });

  test("11. QA markets stay excluded", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [base({ market_name: "ทดสอบ", quantity: 999 })]);
    expect(report.products).toHaveLength(0);
    expect(report.anomalies).toHaveLength(0);
  });

  test("13. never prints a doubled unit period", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [base({ product_name: "องุ่นเขียว", quantity: 32.1 })]);
    const text = buildDailyGoodReturnValueMessages(report).join("\n");
    expect(text).not.toContain("กก..");
    expect(text).toContain("32.1 กก.");
    expect(text).toContain("⚠️ รอตรวจทั้งหมดจาก 1 ตลาด");
  });

  test("15. anomaly detail chunks never split a block, never duplicate, and count omissions", () => {
    const rows = [
      base({ transaction_type: "เบิก", quantity: 100, price_per_unit: 40 }),
      ...Array.from({ length: 20 }, (_, i) => base({ market_name: `ตลาด${i}`, quantity: 1 })),
    ];
    const report = buildDailyGoodReturnValueReport("2026-08-01", rows);
    expect(report.anomalies).toHaveLength(20);
    const messages = buildDailyGoodReturnValueMessages(report);
    const joined = messages.join("\n");
    // Every anomaly number 1..20 appears exactly once across all messages — no split, no duplication, no silent omission.
    const numbers = [...joined.matchAll(/^(\d+)\. ตลาด\d+ — /gm)].map((m) => Number(m[1]));
    expect(numbers.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(messages.every((message) => countCodePoints(message) <= LINE_MESSAGE_MAX_CODE_POINTS)).toBe(true);
  });

  test("17. total confirmed value is unchanged by message chunking", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [
      base({ product_name: `P${i}`, transaction_type: "เบิก", quantity: 2, price_per_unit: 10 }),
      base({ product_name: `P${i}`, quantity: 1 }),
    ]).flat();
    const report = buildDailyGoodReturnValueReport("2026-08-01", rows);
    const expectedTotal = report.products.reduce((sum, row) => sum + row.valueSatang, 0);
    const messages = buildDailyGoodReturnValueMessages(report);
    const totalLine = messages.join("\n").match(/รวมมูลค่าของดีที่ยืนยันได้ ([\d,]+\.\d{2}) บาท/);
    expect(totalLine).not.toBeNull();
    const totalBaht = Number(totalLine![1].replace(/,/g, ""));
    expect(Math.round(totalBaht * 100)).toBe(expectedTotal);
  });

  // ── Blocker 1: realistic LINE cap must never drop every anomaly ───────────

  test("18. 65+ products and multiple anomalies: at least one anomaly message survives the LINE cap", () => {
    const clean = Array.from({ length: 65 }, (_, i) => [
      base({ product_name: `P${i}`, transaction_type: "เบิก", quantity: 2, price_per_unit: 10 }),
      base({ product_name: `P${i}`, quantity: 1 }),
    ]).flat();
    // 20 markets, each returning the same product with no matching withdrawal there — 20 market-level anomalies.
    const anomalyRows = Array.from({ length: 20 }, (_, i) => base({ market_name: `ตลาดผิดปกติ${i}`, product_name: "ทุเรียน", quantity: 3 }));
    const report = buildDailyGoodReturnValueReport("2026-08-01", [...clean, ...anomalyRows]);
    expect(report.products.length).toBeGreaterThanOrEqual(65);
    expect(report.anomalies).toHaveLength(20);
    const expectedTotal = report.products.reduce((sum, row) => sum + row.valueSatang, 0);

    const messages = buildDailyGoodReturnValueMessages(report);
    expect(messages.length).toBeLessThanOrEqual(5);
    const joined = messages.join("\n\n");

    // Summary present.
    expect(joined).toContain("รวมมูลค่าของดีที่ยืนยันได้");
    // At least one real anomaly block with a market name is delivered.
    expect(joined).toContain("⚠️ รายละเอียดข้อมูลผิดปกติ");
    expect(joined).toMatch(/ตลาดผิดปกติ\d+ — ทุเรียน/);

    // Separate, correctly-computed omission counts.
    const omittedProductMatch = joined.match(/ไม่ได้แสดงสินค้าบางส่วน (\d+) รายการ เนื่องจากขีดจำกัด LINE/);
    const omittedAnomalyMatch = joined.match(/ไม่ได้แสดงรายละเอียดผิดปกติ (\d+) รายการ เนื่องจากขีดจำกัด LINE/);
    expect(omittedProductMatch).not.toBeNull();
    const omittedProductCount = Number(omittedProductMatch![1]);
    const omittedAnomalyCount = omittedAnomalyMatch ? Number(omittedAnomalyMatch[1]) : 0;
    expect(omittedProductCount).toBeGreaterThan(0);

    // No duplicate delivered products or anomalies.
    const productNumbers = [...joined.matchAll(/^(\d+)\. .+ — [\d.,]+ /gm)].map((m) => Number(m[1]));
    expect(new Set(productNumbers).size).toBe(productNumbers.length);
    const anomalyNumbers = [...joined.matchAll(/^(\d+)\. ตลาดผิดปกติ\d+ — /gm)].map((m) => Number(m[1]));
    expect(new Set(anomalyNumbers).size).toBe(anomalyNumbers.length);

    // Confirmed total value is exactly preserved regardless of truncation.
    const totalLine = joined.match(/รวมมูลค่าของดีที่ยืนยันได้ ([\d,]+\.\d{2}) บาท/);
    expect(totalLine).not.toBeNull();
    expect(Math.round(Number(totalLine![1].replace(/,/g, "")) * 100)).toBe(expectedTotal);

    // Reproduce omittedAnomalyCount independently: total anomalies minus how many anomaly numbers were actually delivered.
    expect(omittedAnomalyCount + anomalyNumbers.length).toBe(report.anomalies.length);
    // Reproduce omittedProductCount independently via delivered product numbering.
    expect(omittedProductCount + productNumbers.length).toBe(report.products.length);
  });

  test("19. anomalies alone (no truncation needed) still reserve their own message", () => {
    const rows = [
      base({ transaction_type: "เบิก", quantity: 100, price_per_unit: 40 }),
      base({ market_name: "ตลาดกี้", quantity: 5 }), // no matching withdrawal at ตลาดกี้
    ];
    const report = buildDailyGoodReturnValueReport("2026-08-01", rows);
    const messages = buildDailyGoodReturnValueMessages(report);
    expect(messages.some((m) => m.includes("⚠️ รายละเอียดข้อมูลผิดปกติ") && m.includes("ตลาดกี้"))).toBe(true);
  });

  // ── Blocker 2: invalid good-return quantities must never silently vanish ──

  test("20. null good-return quantity: anomaly exists, no zero-quantity product row, complete count is zero", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาดปลา", quantity: null }),
    ]);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({ marketName: "ตลาดปลา", returnedQuantity: null, blockers: ["จำนวนไม่ถูกต้อง"] });
    expect(report.products).toHaveLength(0); // no zero-quantity product row — an invalid quantity is unknown, not zero.
    const text = buildDailyGoodReturnValueMessages(report).join("\n");
    expect(text).toContain("คืนดี ไม่ถูกต้อง");
    expect(text).toContain("ปัญหา: จำนวนไม่ถูกต้อง");
    expect(text).not.toContain("— 0 กก.");
    expect(text).toContain("✅ สินค้าที่คำนวณมูลค่าได้ครบ 0 รายการ");
  });

  test("21. negative good-return quantity: same guarantees as null", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาดปลา", quantity: -5 }),
    ]);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({ marketName: "ตลาดปลา", returnedQuantity: null, blockers: ["จำนวนไม่ถูกต้อง"] });
    expect(report.products).toHaveLength(0);
    const text = buildDailyGoodReturnValueMessages(report).join("\n");
    expect(text).not.toContain("— 0 กก.");
    expect(text).toContain("✅ สินค้าที่คำนวณมูลค่าได้ครบ 0 รายการ");
  });

  test("22. invalid withdrawal quantity with a valid good return still surfaces as an anomaly", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: -1, price_per_unit: 40 }),
      base({ market_name: "ตลาดปลา", quantity: 6 }),
    ]);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({ marketName: "ตลาดปลา", withdrawnQuantity: null, returnedQuantity: 6, blockers: ["จำนวนไม่ถูกต้อง"] });
    expect(report.products[0]).toMatchObject({ quantity: 6, unvaluedQuantity: 6 });
  });

  test("23. invalid damaged-return quantity with a valid good return still surfaces as an anomaly", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาดปลา", quantity: 6 }),
      base({ market_name: "ตลาดปลา", transaction_type: "คืนเสีย", quantity: null }),
    ]);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({ marketName: "ตลาดปลา", damagedQuantity: null, returnedQuantity: 6, blockers: ["จำนวนไม่ถูกต้อง"] });
  });

  test("24. no invalid row silently disappears across every invalid-quantity scenario", () => {
    const rows = [
      base({ market_name: "A", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }), base({ market_name: "A", quantity: null }),
      base({ market_name: "B", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }), base({ market_name: "B", quantity: -2 }),
      base({ market_name: "C", transaction_type: "เบิก", quantity: -1, price_per_unit: 40 }), base({ market_name: "C", quantity: 3 }),
      base({ market_name: "D", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }), base({ market_name: "D", quantity: 3 }), base({ market_name: "D", transaction_type: "คืนเสีย", quantity: -1 }),
    ];
    const report = buildDailyGoodReturnValueReport("2026-08-01", rows);
    expect(new Set(report.anomalies.map((row) => row.marketName))).toEqual(new Set(["A", "B", "C", "D"]));
    expect(report.anomalies.every((row) => row.blockers.includes("จำนวนไม่ถูกต้อง"))).toBe(true);
  });

  // ── Blocker 3: withdrawals-only day is a normal sold-out day ──────────────

  test("25. withdrawals-only date: sold-out wording, no missing-return warning, no latest-data hint", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ transaction_type: "เบิก", quantity: 5, price_per_unit: 40 }),
    ]);
    expect(report.hasActivity).toBe(true);
    const text = buildDailyGoodReturnValueMessages(report, { latest: { status: "found", hint: { date: "2026-07-31", marketCount: 3 } } }).join("\n");
    expect(text).toContain("วันนี้ไม่มีของดีชั่งคืนจากตลาด");
    expect(text).toContain("สินค้าที่ไม่ได้คืนถือว่าขายออกแล้ว");
    expect(text).not.toContain("ยังไม่พบข้อมูลชั่งคืนประจำวันที่");
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
    expect(text).not.toContain("ไม่ครบ");
  });

  test("26. completely empty date: genuine no-data wording with latest-data hint", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", []);
    expect(report.hasActivity).toBe(false);
    const text = buildDailyGoodReturnValueMessages(report, { latest: { status: "found", hint: { date: "2026-07-31", marketCount: 3 } } }).join("\n");
    expect(text).toContain("ยังไม่พบข้อมูลชั่งคืนประจำวันที่");
    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 31 กรกฎาคม 2569");
    expect(text).not.toContain("วันนี้ไม่มีของดีชั่งคืนจากตลาด");
  });

  // ── Final blocker: invalid-only good-return evidence must not become a zero-quantity product ──

  test("27. anomaly-only report (products=[], anomalies>0): neither sold-out nor no-data wording, anomaly and summary shown", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาดปลา", quantity: null }),
    ]);
    expect(report.products).toHaveLength(0);
    expect(report.anomalies).toHaveLength(1);
    const text = buildDailyGoodReturnValueMessages(report, { latest: { status: "none" } }).join("\n");
    expect(text).not.toContain("วันนี้ไม่มีของดีชั่งคืนจากตลาด"); // not the sold-out wording
    expect(text).not.toContain("ยังไม่พบข้อมูลชั่งคืนประจำวันที่"); // not the genuine no-data wording
    expect(text).toContain("⚠️ รายละเอียดข้อมูลผิดปกติ");
    expect(text).toContain("ตลาดปลา — หมอนทอง — กก.");
    expect(text).toContain("รวมมูลค่าของดีที่ยืนยันได้ 0.00 บาท");
    expect(text).toContain("✅ สินค้าที่คำนวณมูลค่าได้ครบ 0 รายการ");
    expect(text).toContain("⚠️ พบข้อมูลผิดปกติ 1 รายการ จาก 1 ตลาด");
  });

  test("28. valid return from one market plus invalid return from another: aggregate keeps only the valid quantity", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาด A", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาด A", quantity: 5 }),
      base({ market_name: "ตลาด B", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาด B", quantity: null }),
    ]);
    expect(report.products).toHaveLength(1);
    // Aggregate physical quantity is 5 (ตลาด A only) — ตลาด B's invalid row never joins the total.
    expect(report.products[0]).toMatchObject({ quantity: 5, valuedQuantity: 5, valueSatang: 20_000, unvaluedQuantity: 0, anomalyMarketCount: 1 });
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({ marketName: "ตลาด B", returnedQuantity: null, blockers: ["จำนวนไม่ถูกต้อง"] });

    const text = buildDailyGoodReturnValueMessages(report).join("\n");
    // Product row stays visible, shows the confirmed value, and flags the untraceable market — never silently "complete".
    expect(text).toContain("หมอนทอง — 5 กก. • 200.00 บาท");
    expect(text).toContain("มีข้อมูลผิดปกติจาก 1 ตลาด (จำนวนไม่ทราบ)");
    expect(text).toContain("ตลาด B — หมอนทอง — กก.");
    expect(text).toContain("รวมมูลค่าของดีที่ยืนยันได้ 200.00 บาท");
    // Not counted as fully calculated: anomalyMarketCount > 0 keeps it out of the complete count.
    expect(text).toContain("✅ สินค้าที่คำนวณมูลค่าได้ครบ 0 รายการ");
  });

  test("29. no 0 กก. physical product row is ever emitted for invalid-only evidence", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-01", [
      base({ market_name: "ตลาดปลา", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาดปลา", quantity: null }),
      base({ market_name: "ตลาดกุ้ง", product_name: "ทุเรียน", transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: "ตลาดกุ้ง", product_name: "ทุเรียน", quantity: -3 }),
    ]);
    expect(report.products).toHaveLength(0);
    const text = buildDailyGoodReturnValueMessages(report).join("\n");
    expect(text).not.toMatch(/— 0(\.0)? กก\./);
  });

  test("30. every message for an anomaly-only report stays within LINE limits", () => {
    const rows = Array.from({ length: 20 }, (_, i) => [
      base({ market_name: `ตลาด${i}`, transaction_type: "เบิก", quantity: 10, price_per_unit: 40 }),
      base({ market_name: `ตลาด${i}`, quantity: null }),
    ]).flat();
    const report = buildDailyGoodReturnValueReport("2026-08-01", rows);
    expect(report.products).toHaveLength(0);
    expect(report.anomalies).toHaveLength(20);
    const messages = buildDailyGoodReturnValueMessages(report);
    expect(messages.every((message) => countCodePoints(message) <= LINE_MESSAGE_MAX_CODE_POINTS)).toBe(true);
    expect(messages.length).toBeLessThanOrEqual(5);
  });
});
