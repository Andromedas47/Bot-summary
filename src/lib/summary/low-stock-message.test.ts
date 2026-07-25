import { describe, expect, test } from "bun:test";
import { buildLowStockReport } from "./low-stock";
import {
  buildLowStockBlocks,
  buildLowStockMessages,
  LOW_STOCK_DISCLAIMER,
  LOW_STOCK_INCOMPLETE_HEADING,
  LOW_STOCK_NONE_NOTICE,
  LOW_STOCK_TITLE,
} from "./low-stock-message";
import { createStockThresholdTable, type StockThreshold } from "./stock-thresholds";
import { buildStockSummaryFromRows } from "./stock-summary";
import {
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "./line-chunking";
import type { RemainingFruitSourceRow } from "./remaining-fruit";

const DATE = "2026-07-25";
const TX_RETURN = "คืน";
const TX_WITHDRAW = "เบิก";

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

function textFor(rows: RemainingFruitSourceRow[], thresholds: StockThreshold[]): string {
  const report = buildLowStockReport(
    buildStockSummaryFromRows(DATE, rows),
    createStockThresholdTable(thresholds),
  );
  return buildLowStockMessages(report).join("\n\n");
}

describe("low-stock message", () => {
  test("renders the attention shape the business asked for", () => {
    const text = textFor(
      [
        row({ product_name: "หมอนทอง", quantity: 8, unit: "โล" }),
        row({ product_name: "มะละกอ", quantity: 4, unit: "ลูก" }),
        row({ product_name: "กะเพรา", quantity: 2, unit: "กำ" }),
      ],
      [
        { productName: "หมอนทอง", unit: "โล", threshold: 30 },
        { productName: "มะละกอ", unit: "ลูก", threshold: 20 },
        { productName: "กะเพรา", unit: "กำ", threshold: 10 },
      ],
    );

    expect(text).toContain(`${LOW_STOCK_TITLE}\nข้อมูลวันที่ 25 กรกฎาคม 2569\nรวมทุกตลาด`);
    expect(text).toContain("🥭 ทุเรียน\nหมอนทอง — 8 กก. (เกณฑ์ 30 กก.)");
    expect(text).toContain("🍉 ผลไม้\nมะละกอ — 4 ลูก (เกณฑ์ 20 ลูก)");
    expect(text).toContain("🥬 ผัก\nกะเพรา — 2 กำ (เกณฑ์ 10 กำ)");
    expect(text).toContain(LOW_STOCK_DISCLAIMER);
  });

  test("never uses purchase-instruction wording", () => {
    const text = textFor(
      [row({ product_name: "หมอนทอง", quantity: 8, unit: "โล" })],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    // No approved reorder rules exist, so the message may only ask for a check.
    // ("สั่งซื้อ" is deliberately absent from this list — it appears inside the
    // disclaimer's own negation, ไม่ใช่คำสั่งซื้ออัตโนมัติ.)
    for (const forbidden of ["ควรซื้อ", "ต้องซื้อ", "แนะนำให้ซื้อ", "ให้ซื้อ"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("ตรวจสอบก่อนซื้อ");
    expect(text).toContain("ไม่ใช่คำสั่งซื้ออัตโนมัติ");
  });

  test("carries ONLY the attention items — never the full inventory", () => {
    const text = textFor(
      [
        row({ product_name: "หมอนทอง", quantity: 8, unit: "โล" }),
        row({ product_name: "แตงโม", quantity: 300, unit: "ลูก" }),
        row({ product_name: "ลูกพลับ", quantity: 363, unit: "ลูก" }),
      ],
      [
        { productName: "หมอนทอง", unit: "โล", threshold: 30 },
        { productName: "แตงโม", unit: "ลูก", threshold: 20 },
      ],
    );

    expect(text).toContain("หมอนทอง — 8 กก.");
    // Healthy stock and unconfigured products stay in the manual report.
    expect(text).not.toContain("แตงโม");
    expect(text).not.toContain("ลูกพลับ");
    expect(text).not.toContain("📦 สรุปคงเหลือทุกตลาด");
  });

  test("carries no per-market detail", () => {
    const text = textFor(
      [
        row({ market_name: "ตลาดกี้", product_name: "หมอนทอง", quantity: 3, unit: "โล" }),
        row({ market_name: "เฉลิม72 ผลไม้", product_name: "หมอนทอง", quantity: 4, unit: "โล" }),
      ],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    expect(text).toContain("หมอนทอง — 7 กก.");
    expect(text).not.toContain("ตลาดกี้");
    expect(text).not.toContain("เฉลิม72 ผลไม้");
    expect(text).not.toContain("เหลือขายต่อ:");
    expect(text).not.toContain("เบิกทั้งหมด:");
    expect(text).not.toContain("คืนเสีย:");
  });

  test("reports the aggregate missing-ชั่งคืน warning", () => {
    const text = textFor(
      [
        row({ product_name: "หมอนทอง", quantity: 8, unit: "โล" }),
        row({
          market_name: "เฉลิม72 ผลไม้",
          product_name: "แก้วมังกร",
          quantity: 9,
          unit: "โล",
          transaction_type: TX_WITHDRAW,
        }),
        row({
          market_name: "พาซิโอ้ผลไม้",
          product_name: "แตงโม",
          quantity: 5,
          unit: "ลูก",
          transaction_type: TX_WITHDRAW,
        }),
      ],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    expect(text).toContain(
      `${LOW_STOCK_INCOMPLETE_HEADING}\n2 ตลาด / 2 รายการยังไม่มีข้อมูลชั่งคืน`,
    );
    // The warning is a count — the product names belong to the manual reply.
    expect(text).not.toContain("แก้วมังกร");
  });

  test("says so plainly when nothing is low, and still warns about missing data", () => {
    const text = textFor(
      [
        row({ product_name: "หมอนทอง", quantity: 500, unit: "โล" }),
        row({
          market_name: "เฉลิม72 ผลไม้",
          product_name: "แก้วมังกร",
          quantity: 9,
          unit: "โล",
          transaction_type: TX_WITHDRAW,
        }),
      ],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    expect(text).toContain(LOW_STOCK_NONE_NOTICE);
    expect(text).toContain(`${LOW_STOCK_INCOMPLETE_HEADING}\n1 ตลาด / 1 รายการยังไม่มีข้อมูลชั่งคืน`);
  });

  test("omits the missing-data warning when every ชั่งคืน is in", () => {
    const text = textFor(
      [
        row({ product_name: "หมอนทอง", quantity: 20, unit: "โล", transaction_type: TX_WITHDRAW }),
        row({ product_name: "หมอนทอง", quantity: 8, unit: "โล" }),
      ],
      [{ productName: "หมอนทอง", unit: "โล", threshold: 30 }],
    );

    expect(text).toContain("หมอนทอง — 8 กก.");
    expect(text).not.toContain(LOW_STOCK_INCOMPLETE_HEADING);
  });

  test("an uncategorized product with a threshold renders in its own section", () => {
    const text = textFor(
      [row({ product_name: "ของแปลกใหม่ไม่เคยเจอ", quantity: 2, unit: "ถุง" })],
      [{ productName: "ของแปลกใหม่ไม่เคยเจอ", unit: "ถุง", threshold: 5 }],
    );

    expect(text).toContain("❓ ไม่จัดหมวด\nของแปลกใหม่ไม่เคยเจอ — 2 ถุง (เกณฑ์ 5 ถุง)");
  });

  test("with no thresholds configured the report has nothing to alert on", () => {
    const report = buildLowStockReport(
      buildStockSummaryFromRows(DATE, [row({ quantity: 1, unit: "โล" })]),
      createStockThresholdTable([]),
    );

    // The route refuses to send this; rendering it is still well defined.
    expect(buildLowStockBlocks(report).join("\n\n")).toContain(LOW_STOCK_NONE_NOTICE);
  });

  test("a long attention list splits into safe LINE messages", () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      row({ product_name: `สินค้า${i}`, quantity: 1, unit: "โล" }),
    );
    const thresholds = rows.map((r) => ({
      productName: r.product_name,
      unit: "โล",
      threshold: 5,
    }));

    const messages = buildLowStockMessages(
      buildLowStockReport(
        buildStockSummaryFromRows(DATE, rows),
        createStockThresholdTable(thresholds),
      ),
    );

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
  });
});
