import { describe, expect, test } from "bun:test";
import { buildStockSummaryFromRows } from "./stock-summary";
import {
  buildStockSummaryBlocks,
  buildStockSummaryMessages,
  STOCK_COMPLETE_NOTICE,
  STOCK_EMPTY_NOTICE,
  STOCK_INCOMPLETE_HEADING,
  STOCK_REPORT_TITLE,
  STOCK_UNIDENTIFIED_HEADING,
} from "./stock-summary-message";
import {
  chunkBlocks,
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
  OVERFLOW_NOTICE,
} from "./line-chunking";
import type { RemainingFruitSourceRow } from "./remaining-fruit";

const DATE = "2026-07-25";
const TX_RETURN = "คืน";
const TX_WITHDRAW = "เบิก";

function row(overrides: Partial<RemainingFruitSourceRow> = {}): RemainingFruitSourceRow {
  return {
    market_name: "ตลาดกี้",
    product_name: "แตงโม",
    quantity: 10,
    unit: "ลูก",
    transaction_type: TX_RETURN,
    ...overrides,
  };
}

function messagesFor(rows: RemainingFruitSourceRow[]): string[] {
  return buildStockSummaryMessages(buildStockSummaryFromRows(DATE, rows));
}

describe("stock summary message", () => {
  test("renders the requested executive shape", () => {
    const text = messagesFor([
      row({ product_name: "หมอนทอง", quantity: 281.1, unit: "โล" }),
      row({ product_name: "ก้านยาว", quantity: 12.7, unit: "โล" }),
      row({ product_name: "ทุเรียนกล่อง", quantity: 6, unit: "กล่อง" }),
      row({ product_name: "มหาชนก", quantity: 120.2, unit: "โล" }),
      row({ product_name: "แตงโม", quantity: 30, unit: "ลูก" }),
      row({ product_name: "กระชาย", quantity: 4, unit: "แพค" }),
      row({ product_name: "กะเพรา", quantity: 10, unit: "กำ" }),
    ]).join("\n\n");

    expect(text).toContain(`${STOCK_REPORT_TITLE}\nวันที่ 25 กรกฎาคม 2569`);
    expect(text).toContain("🥭 ทุเรียน\nหมอนทอง — 281.1 กก.\nก้านยาว — 12.7 กก.\nทุเรียนกล่อง — 6 กล่อง");
    expect(text).toContain("🍉 ผลไม้\nมหาชนก — 120.2 กก.\nแตงโม — 30 ลูก");
    expect(text).toContain("🥬 ผัก\nกะเพรา — 10 กำ\nกระชาย — 4 แพค");
  });

  test("weight is shown as กก. in the executive block", () => {
    const text = messagesFor([row({ product_name: "กระท้อน", quantity: 82.2, unit: "โล" })]).join("\n");
    expect(text).toContain("กระท้อน — 82.2 กก.");
    expect(text).not.toContain("กิโล");
  });

  test("lists missing returns per market", () => {
    const text = messagesFor([
      row({ market_name: "เฉลิม72 ผลไม้", product_name: "แก้วมังกร", quantity: 8, unit: "โล", transaction_type: TX_WITHDRAW }),
      row({ market_name: "เฉลิม72 ผลไม้", product_name: "แตงโม", quantity: 5, unit: "ลูก", transaction_type: TX_WITHDRAW }),
      row({ market_name: "พาซิโอ้ผลไม้", product_name: "แตงโม", quantity: 4, unit: "ลูก", transaction_type: TX_WITHDRAW }),
    ]).join("\n\n");

    expect(text).toContain(STOCK_INCOMPLETE_HEADING);
    expect(text).toContain("- เฉลิม72 ผลไม้: แก้วมังกร (กก.), แตงโม (ลูก)");
    expect(text).toContain("- พาซิโอ้ผลไม้: แตงโม (ลูก)");
    expect(text).not.toContain(STOCK_COMPLETE_NOTICE);
  });

  test("states completeness when every return is in", () => {
    const text = messagesFor([row({ quantity: 12, transaction_type: TX_WITHDRAW }), row({ quantity: 5 })]).join("\n\n");
    expect(text).toContain(STOCK_COMPLETE_NOTICE);
    expect(text).not.toContain(STOCK_INCOMPLETE_HEADING);
  });

  test("surfaces unresolved-market stock in its own section", () => {
    const text = messagesFor([
      row({ market_name: "ตลาดกี้", quantity: 20 }),
      row({ market_name: "รายการชั่งเบิก", product_name: "ลูกพลับ", quantity: 363, unit: "ลูก" }),
    ]).join("\n\n");

    expect(text).toContain(STOCK_UNIDENTIFIED_HEADING);
    expect(text).toContain("ลูกพลับ — 363 ลูก");
  });

  test("reports an empty day explicitly", () => {
    const text = messagesFor([]).join("\n\n");
    expect(text).toContain(STOCK_REPORT_TITLE);
    expect(text).toContain(STOCK_EMPTY_NOTICE);
  });

  test("uncategorized products are never dropped from the message", () => {
    const text = messagesFor([row({ product_name: "ของแปลกใหม่ไม่เคยเจอ", quantity: 3, unit: "ถุง" })]).join("\n\n");
    expect(text).toContain("❓ ไม่จัดหมวด");
    expect(text).toContain("ของแปลกใหม่ไม่เคยเจอ — 3 ถุง");
  });
});

describe("LINE splitting", () => {
  test("a very large stock report splits into safe messages", () => {
    const rows = Array.from({ length: 900 }, (_, i) =>
      row({ product_name: `สินค้า${i}`, quantity: 1 + (i % 9), unit: i % 2 === 0 ? "โล" : "ลูก" }),
    );

    const messages = messagesFor(rows);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
    expect(messages[messages.length - 1]).toContain(OVERFLOW_NOTICE);
  });

  test("a category heading repeats when its section is split", () => {
    const rows = Array.from({ length: 400 }, (_, i) =>
      row({ product_name: `ทุเรียนพันธุ์${i}`, quantity: 1, unit: "โล" }),
    );

    const blocks = buildStockSummaryBlocks(buildStockSummaryFromRows(DATE, rows));
    const durianBlocks = blocks.filter((b) => b.startsWith("🥭 ทุเรียน"));

    expect(durianBlocks.length).toBeGreaterThan(1);
    for (const block of durianBlocks) {
      expect(countCodePoints(block)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
  });

  test("a single oversized block without blank lines still terminates", () => {
    const giant = Array.from({ length: 5000 }, (_, i) => `บรรทัด${i}`).join("\n");
    const messages = chunkBlocks([giant], 500);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(500);
    }
    expect(messages.join("\n")).toContain("บรรทัด4999");
  });

  test("a single unbroken oversized line is hard split rather than looping", () => {
    const messages = chunkBlocks(["ก".repeat(2500)], 400);

    expect(messages).toHaveLength(7);
    expect(messages.join("")).toBe("ก".repeat(2500));
  });
});
