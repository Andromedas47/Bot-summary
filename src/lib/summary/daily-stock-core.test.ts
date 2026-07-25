import { describe, expect, test } from "bun:test";
import {
  buildRemainingFruitReport,
  classifyProductCategory,
  normalizeProductName,
  type RemainingFruitSourceRow,
} from "@/lib/summary/remaining-fruit";
import {
  buildRemainingFruitMessages,
  buildRemainingFruitMessagesFromRows,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/remaining-fruit-message";
import { createDailyStockSummary } from "@/lib/summary/daily-stock-service";
import { parseRemainingFruitCommand } from "@/lib/summary/remaining-fruit-command";
import { prepareAutomaticStockReport } from "@/lib/line/daily-stock-delivery";

const MARKET_A = "ตลาดเฉลิม72";
const MARKET_B = "พาซิโอ้ผลไม้";
const RETURN = "คืน";
const WITHDRAW = "เบิก";
const DAMAGED = "คืนเสีย";

function row(
  product_name: string,
  quantity: number,
  transaction_type = RETURN,
  overrides: Partial<RemainingFruitSourceRow> = {},
): RemainingFruitSourceRow {
  return {
    market_name: MARKET_A,
    product_name,
    quantity,
    unit: "โล",
    transaction_type,
    ...overrides,
  };
}

describe("Daily Stock Core canonical model", () => {
  test("all-market good returns aggregate while bad returns stay out of sellable stock", () => {
    const summary = createDailyStockSummary([
      row("แตงโม", 12, RETURN, { market_name: MARKET_A }),
      row("แตงโม", 8, RETURN, { market_name: MARKET_B }),
      row("แตงโม", 5, DAMAGED, { market_name: MARKET_A }),
    ]);

    expect(summary.overall).toHaveLength(1);
    expect(summary.overall[0].totalRemainingForResale).toBe(20);
    expect(summary.markets.find((market) => market.marketName === MARKET_A)?.items[0].damagedQuantity)
      .toBe(5);
  });

  test("withdrawn product without a good return is incomplete, never a zero balance", () => {
    const summary = createDailyStockSummary([
      row("แก้วมังกร", 50, WITHDRAW),
      row("แก้วมังกร", 2, DAMAGED),
    ]);

    expect(summary.overall).toHaveLength(0);
    expect(summary.incomplete).toEqual([
      expect.objectContaining({ marketName: MARKET_A, fruitName: "แก้วมังกร" }),
    ]);
  });

  test("canonical aliases aggregate while preserving raw source evidence", () => {
    const summary = createDailyStockSummary([
      row("โชคอนัน", 4),
      row("โชคอนันต์", 6),
      row("โชคิอนันต์", 2),
    ]);

    expect(summary.overall).toHaveLength(1);
    expect(summary.overall[0]).toEqual(expect.objectContaining({
      fruitName: "โชคอนันต์",
      totalRemainingForResale: 12,
      rawProductNames: ["โชคอนัน", "โชคอนันต์", "โชคิอนันต์"],
    }));
  });

  test("incompatible units never aggregate", () => {
    const summary = createDailyStockSummary([
      row("แตงโม", 10, RETURN, { unit: "ลูก" }),
      row("แตงโม", 4, RETURN, { unit: "โล" }),
    ]);

    expect(summary.overall).toHaveLength(2);
    expect(summary.overall.map((item) => item.unit).sort()).toEqual(["ลูก", "โล"]);
  });

  test("unknown products remain visible in the unknown category", () => {
    const summary = createDailyStockSummary([row("สินค้าทดลองชัดเจน", 3)]);

    expect(summary.categories).toEqual([
      expect.objectContaining({
        category: "unknown",
        items: [expect.objectContaining({ fruitName: "สินค้าทดลองชัดเจน" })],
      }),
    ]);
  });

  test("fruit, vegetable, and durian categories are explicit", () => {
    expect(classifyProductCategory("แตงโม")).toBe("fruit");
    expect(classifyProductCategory("กระชาย")).toBe("vegetable");
    expect(classifyProductCategory("หมอนทอง")).toBe("durian");
    expect(classifyProductCategory("ทุเรียนกล่อง")).toBe("durian");
  });
});

describe("introduced product alias regressions", () => {
  test.each([
    ["หมอน", "หมอนทอง"],
    ["โชคอนัน", "โชคอนันต์"],
    ["โชคิอนันต์", "โชคอนันต์"],
    ["สัปรด", "สับปะรด"],
    ["สัปปรถ", "สับปะรด"],
    ["สัปแรถ", "สับปะรด"],
    ["สีปปะรด", "สับปะรด"],
    ["อะโวอาโด้", "อโวคาโด้"],
    ["อินทผารัม", "อินทผาลัม"],
    ["ทุเนียนกล่อง", "ทุเรียนกล่อง"],
  ])("%s canonicalizes to %s", (raw, canonical) => {
    expect(normalizeProductName(raw)).toBe(canonical);
  });
});

describe("manual and automatic stock output", () => {
  const rows = [
    row("แตงโม", 20, RETURN),
    row("กระชาย", 4, RETURN, { unit: "แพค" }),
    row("หมอน", 50, WITHDRAW, { market_name: MARKET_B }),
  ];

  test("manual all-market and market-specific command syntax remains supported", () => {
    expect(parseRemainingFruitCommand("สรุปคงเหลือ 25/7/2569")).toEqual({
      businessDate: "2026-07-25",
      marketFilter: null,
    });
    expect(parseRemainingFruitCommand("เฉลิม72 สรุปคงเหลือ 25/7/2569")).toEqual({
      businessDate: "2026-07-25",
      marketFilter: "เฉลิม72",
    });
  });

  test("categorized LINE summary includes incomplete warnings", () => {
    const text = buildRemainingFruitMessagesFromRows("2026-07-25", rows).join("\n\n");

    expect(text).toContain("🍉 ผลไม้");
    expect(text).toContain("🥬 ผัก");
    expect(text).toContain("⚠️ ข้อมูลชั่งคืนยังไม่ครบ");
    expect(text).toContain(`${MARKET_B}: หมอนทอง`);
    expect(text).not.toMatch(/หมอนทอง\s+—\s+0/);
  });

  test("automatic delivery consumes the exact same StockSummary object as manual formatting", () => {
    const summary = createDailyStockSummary(rows);
    const manualMessages = buildRemainingFruitMessages("2026-07-25", summary, {
      includeOverall: true,
      includeDetails: false,
    });
    const automatic = prepareAutomaticStockReport("2026-07-25", summary);

    expect(automatic.summary).toBe(summary);
    expect(automatic.messages).toEqual(manualMessages);
  });

  test("long automatic result stays within LINE limits", () => {
    const longRows = Array.from({ length: 500 }, (_, index) =>
      row(`ไม่ทราบหมวด${index.toString().padStart(3, "0")}`, index + 1));
    const messages = prepareAutomaticStockReport(
      "2026-07-25",
      buildRemainingFruitReport(longRows),
    ).messages;

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
    expect(messages.every((message) => [...message].length <= LINE_MESSAGE_MAX_CODE_POINTS)).toBe(true);
  });
});
