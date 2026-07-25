import { describe, expect, test } from "bun:test";
import { buildLowStockReport } from "./low-stock";
import { createStockThresholdTable, type StockThreshold } from "./stock-thresholds";
import { buildStockSummaryFromRows } from "./stock-summary";
import { buildStockSummaryBlocks } from "./stock-summary-message";
import type { RemainingFruitSourceRow } from "./remaining-fruit";

const DATE = "2026-07-25";
const TX_RETURN = "คืน";
const TX_WITHDRAW = "เบิก";
const TX_DAMAGED = "คืนเสีย";

function row(overrides: Partial<RemainingFruitSourceRow> = {}): RemainingFruitSourceRow {
  return {
    market_name: "ตลาดกี้",
    product_name: "หมอนทอง",
    quantity: 10,
    unit: "โล",
    transaction_type: TX_RETURN,
    ...overrides,
  };
}

function reportFor(rows: RemainingFruitSourceRow[], thresholds: StockThreshold[]) {
  return buildLowStockReport(
    buildStockSummaryFromRows(DATE, rows),
    createStockThresholdTable(thresholds),
  );
}

function flatItems(report: ReturnType<typeof buildLowStockReport>) {
  return report.categories.flatMap((group) =>
    group.products.map((p) => `${group.category}|${p.productName}|${p.unit}|${p.quantity}`),
  );
}

describe("low-stock threshold comparison", () => {
  test("a product below its threshold is flagged", () => {
    const report = reportFor(
      [row({ product_name: "หมอนทอง", quantity: 8, unit: "โล" })],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    expect(report.itemCount).toBe(1);
    expect(report.categories[0].category).toBe("ทุเรียน");
    expect(report.categories[0].products[0]).toEqual({
      productName: "หมอนทอง",
      unit: "โล",
      quantity: 8,
      threshold: 30,
    });
  });

  test("a product exactly ON its threshold IS flagged — the comparison is inclusive", () => {
    const report = reportFor(
      [row({ product_name: "หมอนทอง", quantity: 30, unit: "โล" })],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    expect(report.itemCount).toBe(1);
    expect(report.categories[0].products[0].quantity).toBe(30);
  });

  test("a product above its threshold is not flagged", () => {
    const report = reportFor(
      [row({ product_name: "หมอนทอง", quantity: 30.5, unit: "โล" })],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    expect(report.itemCount).toBe(0);
    expect(report.categories).toEqual([]);
  });

  test("a product with NO configured threshold is never flagged", () => {
    const report = reportFor(
      [
        row({ product_name: "หมอนทอง", quantity: 0.5, unit: "โล" }),
        row({ product_name: "แตงโม", quantity: 1, unit: "ลูก" }),
      ],
      [{ productName: "แตงโม", unit: "ลูก", threshold: 5 }],
    );

    // หมอนทอง is nearly gone but unconfigured — silence, not a guess.
    expect(flatItems(report)).toEqual(["ผลไม้|แตงโม|ลูก|1"]);
    expect(report.withoutThresholdCount).toBe(1);
  });

  test("thresholds are per unit — the same product does not share one", () => {
    const report = reportFor(
      [
        row({ product_name: "ทุเรียนกวน", quantity: 4, unit: "กระปุก" }),
        row({ product_name: "ทุเรียนกวน", quantity: 9, unit: "กล่อง" }),
      ],
      [
        { productName: "ทุเรียนกวน", unit: "กระปุก", threshold: 10 },
        { productName: "ทุเรียนกวน", unit: "กล่อง", threshold: 3 },
      ],
    );

    // 4 กระปุก ≤ 10 → flagged. 9 กล่อง > 3 → not flagged. Never summed together.
    expect(flatItems(report)).toEqual(["ทุเรียน|ทุเรียนกวน|กระปุก|4"]);
  });

  test("a unit with no threshold is not covered by the product's other unit", () => {
    const report = reportFor(
      [row({ product_name: "ทุเรียนกวน", quantity: 1, unit: "กล่อง" })],
      [{ productName: "ทุเรียนกวน", unit: "กระปุก", threshold: 10 }],
    );

    expect(report.itemCount).toBe(0);
    expect(report.withoutThresholdCount).toBe(1);
  });
});

describe("low-stock fail-closed data quality", () => {
  test("a product still awaiting ชั่งคืน is never reported as low stock", () => {
    const report = reportFor(
      [
        // ตลาดกี้ returned only part of it …
        row({ market_name: "ตลาดกี้", product_name: "หมอนทอง", quantity: 6, unit: "โล" }),
        // … and เฉลิม72 ผลไม้ has withdrawn stock with no good return yet.
        row({
          market_name: "เฉลิม72 ผลไม้",
          product_name: "หมอนทอง",
          quantity: 40,
          unit: "โล",
          transaction_type: TX_WITHDRAW,
        }),
      ],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    // 6 is far below 30, but the day is not closed: the missing ชั่งคืน could
    // add stock back. Alerting here would be a false alarm built on partial data.
    expect(report.itemCount).toBe(0);
    expect(report.suppressedIncompleteCount).toBe(1);
    expect(report.isComplete).toBe(false);
    expect(report.incompleteMarketCount).toBe(1);
    expect(report.incompleteItemCount).toBe(1);
  });

  test("a withdrawal with no return is never treated as 0 remaining", () => {
    const report = reportFor(
      [
        row({
          market_name: "ตลาดกี้",
          product_name: "มะละกอ",
          quantity: 50,
          unit: "ลูก",
          transaction_type: TX_WITHDRAW,
        }),
      ],
      [{ productName: "มะละกอ", unit: "ลูก", threshold: 20 }],
    );

    // "0 remaining" would be the most alarming possible reading of this data,
    // and it is exactly the wrong one.
    expect(report.itemCount).toBe(0);
    expect(report.isComplete).toBe(false);
    // A product missing its ชั่งคืน everywhere still counts as held back.
    expect(report.suppressedIncompleteCount).toBe(1);
  });

  test("คืนเสีย alone never completes the loop or creates a low-stock alert", () => {
    const report = reportFor(
      [
        row({
          market_name: "ตลาดกี้",
          product_name: "แตงโม",
          quantity: 20,
          unit: "ลูก",
          transaction_type: TX_WITHDRAW,
        }),
        row({
          market_name: "ตลาดกี้",
          product_name: "แตงโม",
          quantity: 20,
          unit: "ลูก",
          transaction_type: TX_DAMAGED,
        }),
      ],
      [{ productName: "แตงโม", unit: "ลูก", threshold: 5 }],
    );

    // Damage is not a good return: the product has no sellable figure at all.
    expect(report.itemCount).toBe(0);
    expect(report.isComplete).toBe(false);
    expect(report.incompleteItemCount).toBe(1);
    expect(report.suppressedIncompleteCount).toBe(1);
  });

  test("an incomplete product elsewhere does not suppress a healthy product", () => {
    const report = reportFor(
      [
        row({ market_name: "ตลาดกี้", product_name: "มะละกอ", quantity: 4, unit: "ลูก" }),
        row({
          market_name: "เฉลิม72 ผลไม้",
          product_name: "แตงโม",
          quantity: 12,
          unit: "ลูก",
          transaction_type: TX_WITHDRAW,
        }),
      ],
      [
        { productName: "มะละกอ", unit: "ลูก", threshold: 20 },
        { productName: "แตงโม", unit: "ลูก", threshold: 20 },
      ],
    );

    expect(flatItems(report)).toEqual(["ผลไม้|มะละกอ|ลูก|4"]);
    expect(report.suppressedIncompleteCount).toBe(1);
  });

  test("unresolved-market stock counts toward the total instead of faking a shortage", () => {
    const rows = [
      row({ market_name: "ตลาดกี้", product_name: "ลูกพลับ", quantity: 12, unit: "ลูก" }),
      row({ market_name: "รายการชั่งเบิก", product_name: "ลูกพลับ", quantity: 30, unit: "ลูก" }),
    ];
    const thresholds = [{ productName: "ลูกพลับ", unit: "ลูก", threshold: 20 }];

    // 12 alone would look low; the real holding is 42.
    expect(buildStockSummaryFromRows(DATE, rows).unidentified).not.toEqual([]);
    expect(reportFor(rows, thresholds).itemCount).toBe(0);
  });
});

describe("low-stock report shape", () => {
  test("an uncategorized product with an explicit threshold is still reported", () => {
    const report = reportFor(
      [row({ product_name: "ของแปลกใหม่ไม่เคยเจอ", quantity: 2, unit: "ถุง" })],
      [{ productName: "ของแปลกใหม่ไม่เคยเจอ", unit: "ถุง", threshold: 5 }],
    );

    expect(flatItems(report)).toEqual(["ไม่จัดหมวด|ของแปลกใหม่ไม่เคยเจอ|ถุง|2"]);
  });

  test("categories keep their canonical order and only appear when they have items", () => {
    const report = reportFor(
      [
        row({ product_name: "กะเพรา", quantity: 2, unit: "กำ" }),
        row({ product_name: "หมอนทอง", quantity: 5, unit: "โล" }),
        row({ product_name: "แตงโม", quantity: 900, unit: "ลูก" }),
      ],
      [
        { productName: "กะเพรา", unit: "กำ", threshold: 10 },
        { productName: "หมอนทอง", unit: "โล", threshold: 30 },
        { productName: "แตงโม", unit: "ลูก", threshold: 20 },
      ],
    );

    expect(report.categories.map((g) => g.category)).toEqual(["ทุเรียน", "ผัก"]);
  });

  test("the most depleted product relative to its own threshold comes first", () => {
    const report = reportFor(
      [
        row({ product_name: "กะเพรา", quantity: 9, unit: "กำ" }), // 90% of threshold
        row({ product_name: "ผักชี", quantity: 1, unit: "กำ" }), // 10% of threshold
        row({ product_name: "ต้นหอม", quantity: 5, unit: "กำ" }), // 50% of threshold
      ],
      [
        { productName: "กะเพรา", unit: "กำ", threshold: 10 },
        { productName: "ผักชี", unit: "กำ", threshold: 10 },
        { productName: "ต้นหอม", unit: "กำ", threshold: 10 },
      ],
    );

    expect(report.categories[0].products.map((p) => p.productName)).toEqual([
      "ผักชี",
      "ต้นหอม",
      "กะเพรา",
    ]);
  });

  test("no configured thresholds means no alerts at all — fail closed", () => {
    const report = reportFor(
      [
        row({ product_name: "หมอนทอง", quantity: 0.1, unit: "โล" }),
        row({ product_name: "แตงโม", quantity: 1, unit: "ลูก" }),
      ],
      [],
    );

    expect(report.hasThresholds).toBe(false);
    expect(report.thresholdCount).toBe(0);
    expect(report.itemCount).toBe(0);
    expect(report.categories).toEqual([]);
    expect(report.withoutThresholdCount).toBe(2);
  });

  test("the report carries the business date it was built from", () => {
    expect(reportFor([row()], []).businessDate).toBe(DATE);
  });
});

describe("the manual full-inventory report is unaffected", () => {
  test("products above their threshold still appear in the manual stock reply", () => {
    const rows = [
      row({ product_name: "หมอนทอง", quantity: 281.1, unit: "โล" }),
      row({ product_name: "แตงโม", quantity: 30, unit: "ลูก" }),
      row({ product_name: "กะเพรา", quantity: 2, unit: "กำ" }),
    ];

    const manual = buildStockSummaryBlocks(buildStockSummaryFromRows(DATE, rows)).join("\n\n");

    // The manual command is the FULL inventory — it never filters by threshold.
    expect(manual).toContain("📦 สรุปคงเหลือทุกตลาด");
    expect(manual).toContain("หมอนทอง — 281.1 กก.");
    expect(manual).toContain("แตงโม — 30 ลูก");
    expect(manual).toContain("กะเพรา — 2 กำ");
    expect(manual).not.toContain("เกณฑ์");
    expect(manual).not.toContain("🚨");
  });
});
