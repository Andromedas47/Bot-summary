import { describe, expect, test } from "bun:test";
import { buildCompareReport, canonicalProductName, type CompareSourceRow } from "@/lib/compare-report";

function tx(overrides: Partial<CompareSourceRow> = {}): CompareSourceRow {
  return {
    id: crypto.randomUUID(),
    product_name: "กะหล่ำปี",
    quantity: 1,
    unit: "หัว",
    price_per_unit: 20,
    total_amount: 20,
    transaction_type: "เบิก",
    ...overrides,
  };
}

describe("compare report product grouping", () => {
  test("explicit aliases collapse into one canonical row and preserve source names", () => {
    const report = buildCompareReport([
      tx({ product_name: "ถั่วพู" }),
      tx({ product_name: "ถั่วพํ" }),
      tx({ product_name: "เพิ่มถั่วพู" }),
    ], null);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].canonicalName).toBe("ถั่วพู");
    expect(report.rows[0].sourceNames).toEqual(["ถั่วพํ", "ถั่วพู", "เพิ่มถั่วพู"]);
  });

  test("generic เพิ่ม prefix is removed only when the base exists in the dataset", () => {
    expect(canonicalProductName("เพิ่มคะน้า", new Set(["คะน้า", "เพิ่มคะน้า"]))).toBe("คะน้า");
    expect(canonicalProductName("เพิ่มของใหม่", new Set(["เพิ่มของใหม่"]))).toBe("เพิ่มของใหม่");
  });

  test("pumpkin variants are never merged without an explicit alias", () => {
    const report = buildCompareReport([
      tx({ product_name: "ฟักทอง" }),
      tx({ product_name: "ฟักทองลูก", unit: "ลูก" }),
      tx({ product_name: "ฟักทองชิ้น", unit: "ชิ้น" }),
    ], null);
    expect(report.rows.map((row) => row.canonicalName)).toEqual(["ฟักทอง", "ฟักทองชิ้น", "ฟักทองลูก"]);
  });

  test("multiple original prices remain in one product row", () => {
    const report = buildCompareReport([
      tx({ price_per_unit: 6.66, total_amount: 6.66 }),
      tx({ price_per_unit: 6.67, total_amount: 6.67 }),
    ], null);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].prices).toEqual([6.66, 6.67]);
    expect(report.summary.issuedAmount).toBe(13.33);
  });

  test("quantities never subtract across units while amounts use stored raw totals", () => {
    const report = buildCompareReport([
      tx({ quantity: 14, unit: "หัว", total_amount: 350 }),
      tx({ quantity: 2, unit: "ลูก", total_amount: 60 }),
      tx({ quantity: 14, unit: "หัว", total_amount: 349.99, transaction_type: "คืน" }),
    ], null);
    expect(report.rows[0].remaining.quantities).toEqual({ หัว: 0, ลูก: 2 });
    expect(report.rows[0].remaining.amount).toBe(60.01);
    expect(report.summary.issuedAmount).toBe(410);
    expect(report.summary.returnedAmount).toBe(349.99);
  });
});

describe("compare report settlement status", () => {
  const rows = [
    tx({ total_amount: 16_155.55 }),
    tx({ total_amount: 10_696.54, transaction_type: "คืน" }),
    tx({ total_amount: 1_272, transaction_type: "คืนเสีย" }),
  ];

  test("missing settlement is pending and never invents zero", () => {
    const summary = buildCompareReport(rows, null).summary;
    expect(summary.expectedAmount).toBe(4_187.01);
    expect(summary.settlementAmount).toBeNull();
    expect(summary.difference).toBeNull();
    expect(summary.settlementStatus).toBe("pending");
  });

  test("recorded settlement reuses legacy shortage/overage formula", () => {
    const summary = buildCompareReport(rows, {
      money_transfer: 2_000,
      money_cash: 790,
      expenses: 0,
      labor: 0,
    }).summary;
    expect(summary.settlementAmount).toBe(2_790);
    expect(summary.difference).toBe(-1_397.01);
  });

  test("effective corrected value is shared by page and export model", () => {
    const report = buildCompareReport([
      tx({
        product_name: "หมอนทอง",
        quantity: 39.4,
        unit: "โล",
        price_per_unit: 109,
        total_amount: 4_294.6,
        is_corrected: true,
        correction_id: "correction-1",
        original_price_amount: 119,
        original_price_quantity: 1,
        original_total_amount: 4_688.6,
        correction_reason_detail: "ลงราคาเบิกผิด",
      }),
    ], null);
    expect(report.summary.issuedAmount).toBe(4_294.6);
    expect(report.corrections[0].originalAmount! - report.corrections[0].amount).toBeCloseTo(394, 2);
  });
});
