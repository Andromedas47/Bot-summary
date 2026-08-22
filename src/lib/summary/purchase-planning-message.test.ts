import { describe, expect, test } from "bun:test";
import {
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/line-chunking";
import type {
  PurchasePlanningItem,
  PurchasePlanningReport,
} from "./purchase-planning";
import {
  buildPurchasePlanningBlocks,
  buildPurchasePlanningMessages,
  formatSellThroughRate,
  PRICE_CONFLICT_NOTE,
  PURCHASE_PLANNING_EMPTY_NOTICE,
  PURCHASE_PLANNING_OVERFLOW_NOTICE,
  INCOMPLETE_STOCK_NOTE,
  PURCHASE_PLANNING_TITLE,
  STATUS_HEADINGS,
} from "./purchase-planning-message";

const DATE = "2026-08-21";

function item(overrides: Partial<PurchasePlanningItem> = {}): PurchasePlanningItem {
  return {
    productName: "แอปเปิ้ล",
    unit: "ลูก",
    withdrawnQuantity: 234,
    goodReturnQuantity: 134,
    damagedQuantity: 5,
    estimatedSoldQuantity: 95,
    sellThroughRate: (95 / 234) * 100,
    band: "medium",
    status: "surplus",
    uncertaintyReasons: [],
    houseStockQuantity: 80,
    stockAbsence: null,
    nextDayGoodStockQuantity: 214,
    nextStockToSoldRatio: 214 / 95,
    priceConflict: false,
    ...overrides,
  };
}

function report(overrides: Partial<PurchasePlanningReport> = {}): PurchasePlanningReport {
  return {
    businessDate: DATE,
    items: [item()],
    unresolvedSessionCount: 0,
    stockAbsence: null,
    unidentifiedRowCount: 0,
    ...overrides,
  };
}

const joined = (r: PurchasePlanningReport): string =>
  buildPurchasePlanningBlocks(r).join("\n\n");

describe("purchase planning message — header and shape", () => {
  test("leads with the title and the Thai business date", () => {
    const blocks = buildPurchasePlanningBlocks(report());
    expect(blocks[0]).toContain(PURCHASE_PLANNING_TITLE);
    expect(blocks[0]).toContain("ข้อมูลวันที่ 21 สิงหาคม 2569");
    expect(blocks[0]).toContain("ราคาไม่ใช้ในการจัดอันดับการขาย");
  });

  test("an empty day says so instead of rendering an empty ranking", () => {
    const text = joined(report({ items: [] }));
    expect(text).toContain(PURCHASE_PLANNING_EMPTY_NOTICE);
  });

  test("renders quantities, the rate and the house stock in the operator's units", () => {
    const text = joined(report({
      items: [item({
        productName: "มะม่วงจิ้ว",
        unit: "โล",
        withdrawnQuantity: 45.9,
        goodReturnQuantity: 35.4,
        damagedQuantity: 0,
        estimatedSoldQuantity: 10.5,
        sellThroughRate: (10.5 / 45.9) * 100,
        band: "low",
        status: "reduce",
        houseStockQuantity: 20,
        nextDayGoodStockQuantity: 55.4,
        nextStockToSoldRatio: 55.4 / 10.5,
      })],
    }));

    expect(text).toContain(STATUS_HEADINGS.reduce);
    expect(text).toContain("เบิก 45.9 กก.");
    expect(text).toContain("ขายประมาณ 10.5 กก.");
    expect(text).toContain("คืนดีจากตลาด 35.4 กก.");
    expect(text).toContain("ขายออก 22.9%");
    expect(text).toContain("เหลือในบ้านหลังเบิก 20 กก.");
    expect(text).toContain("ของดีพร้อมขายต่อประมาณ 55.4 กก.");
    expect(text).toContain("→ ขายออกน้อยและยังมีของดีเหลือมาก ควรลดการซื้อ");
    // No damage recorded, so no damage line is invented.
    expect(text).not.toContain("คืนเสีย");
  });

  test("shows the damaged return only when there is one", () => {
    expect(joined(report())).toContain("คืนเสีย 5 ลูก");
  });

  test("a price conflict is a note, never a reason to drop the product", () => {
    const text = joined(report({ items: [item({ priceConflict: true })] }));
    expect(text).toContain(PRICE_CONFLICT_NOTE);
    expect(text).toContain("ขายออก 40.6%");
    expect(text).toContain(STATUS_HEADINGS.surplus);
  });

  test("formatSellThroughRate keeps whole numbers whole", () => {
    expect(formatSellThroughRate(82)).toBe("82%");
    expect(formatSellThroughRate((95 / 234) * 100)).toBe("40.6%");
    expect(formatSellThroughRate((10.5 / 45.9) * 100)).toBe("22.9%");
  });

  test("the printed rate never crosses into a band the product is not in", () => {
    // 39.95 rounds to 40.0, which would read as MEDIUM under the 🔴 heading.
    expect(formatSellThroughRate(39.95, "low")).toBe("39.9%");
    expect(formatSellThroughRate(69.98, "medium")).toBe("69.9%");
    // Inside its own band, ordinary rounding is untouched.
    expect(formatSellThroughRate(39.94, "low")).toBe("39.9%");
    expect(formatSellThroughRate(70, "high")).toBe("70%");
    expect(formatSellThroughRate(40, "medium")).toBe("40%");
  });

  test("the rendered rate agrees with the heading it was filed under", () => {
    const text = joined(report({
      items: [item({
        withdrawnQuantity: 40,
        goodReturnQuantity: 24.02,
        damagedQuantity: 0,
        estimatedSoldQuantity: 15.98,
        sellThroughRate: 39.95,
        band: "low",
        status: "reduce",
      })],
    }));
    expect(text).toContain(STATUS_HEADINGS.reduce);
    expect(text).toContain("ขายออก 39.9%");
    expect(text).not.toContain("ขายออก 40%");
  });
});

describe("purchase planning message — recommendations", () => {
  test("🟢 names both halves of the evidence", () => {
    const text = joined(report({
      items: [item({ band: "high", status: "strong", nextStockToSoldRatio: 0.1 })],
    }));
    expect(text).toContain(STATUS_HEADINGS.strong);
    expect(text).toContain("→ ขายออกดีและของดีพร้อมขายต่อเหลือน้อย");
  });

  test("a high seller held back by house stock says why", () => {
    const text = joined(report({
      items: [item({ band: "high", status: "surplus", nextStockToSoldRatio: 3 })],
    }));
    expect(text).toContain("→ ขายดีแต่ยังมีของพร้อมขายต่ออยู่มาก ควรเช็กก่อนซื้อเพิ่ม");
  });

  test("a high seller with no comparable stock asks for a check, not a purchase", () => {
    const text = joined(report({
      items: [item({
        band: "high",
        status: "surplus",
        houseStockQuantity: null,
        stockAbsence: "no_match",
        nextDayGoodStockQuantity: null,
        nextStockToSoldRatio: null,
      })],
    }));
    expect(text).toContain("→ ขายดี แต่ยังไม่มีข้อมูลสต๊อกในบ้านที่ใช้เทียบได้");
    expect(text).toContain(INCOMPLETE_STOCK_NOTE);
    expect(text).toContain("เหลือในบ้านหลังเบิก: ไม่พบรายการที่เทียบหน่วยเดียวกันได้");
    // No house count means no complete next-day figure may be shown.
    expect(text).not.toContain("ของดีพร้อมขายต่อประมาณ");
  });

  test("the apple case renders the stock story in physical order", () => {
    // 80 left at home after dispatch, 134 came back good later → 214 ready to
    // sell tomorrow. The 5 damaged are NOT part of that figure.
    const text = joined(report());
    expect(text).toContain("คืนดีจากตลาด 134 ลูก");
    expect(text).toContain("คืนเสีย 5 ลูก");
    expect(text).toContain("เหลือในบ้านหลังเบิก 80 ลูก");
    expect(text).toContain("ของดีพร้อมขายต่อประมาณ 214 ลูก");
    expect(text).not.toContain("ของดีพร้อมขายต่อประมาณ 219 ลูก");
    expect(text).toContain("→ มีของพร้อมขายต่ออยู่มาก ควรเช็กก่อนซื้อเพิ่ม");
  });

  test("a damage-heavy 🔴 does not claim the good stock is high", () => {
    const text = joined(report({
      items: [item({
        withdrawnQuantity: 100,
        goodReturnQuantity: 0,
        damagedQuantity: 80,
        estimatedSoldQuantity: 20,
        sellThroughRate: 20,
        band: "low",
        status: "reduce",
        houseStockQuantity: 0,
        nextDayGoodStockQuantity: 0,
        nextStockToSoldRatio: 0,
      })],
    }));
    expect(text).toContain(STATUS_HEADINGS.reduce);
    expect(text).toContain("→ ขายออกน้อยและมีของเสียสูง ควรลดการซื้อ");
    expect(text).not.toContain("ของเหลือสูง");
    expect(text).not.toContain("ยังมีของดีเหลือมาก");
  });

  test("an uncertain product shows no percentage and names the reason", () => {
    const text = joined(report({
      items: [item({
        estimatedSoldQuantity: null,
        sellThroughRate: null,
        band: null,
        status: "unknown",
        uncertaintyReasons: ["product_return_absent"],
        houseStockQuantity: null,
        stockAbsence: "no_match",
        nextDayGoodStockQuantity: null,
        nextStockToSoldRatio: null,
      })],
    }));
    expect(text).toContain(STATUS_HEADINGS.unknown);
    expect(text).toContain("⚠️ ข้อมูลไม่พอประเมิน");
    expect(text).toContain("→ ยังไม่พบรายการชั่งคืนของสินค้านี้ในรอบที่เบิก");
    expect(text).not.toContain("ขายออก ");
    expect(text).not.toContain("ขายประมาณ");
  });
});

describe("purchase planning message — day-level warnings", () => {
  test("unresolved produce documents are named, with what the ranking covers", () => {
    const text = joined(report({ unresolvedSessionCount: 15 }));
    expect(text).toContain("⚠️ ข้อมูลวันนี้ยังไม่ครบ");
    expect(text).toContain("มีชุดรายการที่ยังบันทึกไม่สำเร็จ 15 ชุด");
    expect(text).toContain("อันดับนี้อ้างอิงเฉพาะข้อมูลที่บันทึกสำเร็จ");
  });

  test("a missing house snapshot is stated rather than assumed empty", () => {
    const text = joined(report({ stockAbsence: "no_snapshot" }));
    expect(text).toContain("⚠️ ยังไม่มีข้อมูลสต๊อกในบ้านของวันนี้");
  });

  test("duplicate house snapshots are reported, not silently resolved", () => {
    const text = joined(report({ stockAbsence: "snapshot_conflict" }));
    expect(text).toContain("⚠️ พบข้อมูลสต๊อกในบ้านมากกว่าหนึ่งชุดสำหรับวันนี้");
    expect(text).toContain("จึงไม่ใช้ข้อมูลสต๊อกในการประเมิน");
  });

  test("a snapshot that held nothing usable is not reported as no snapshot", () => {
    const text = joined(report({ stockAbsence: "snapshot_empty" }));
    expect(text).toContain("⚠️ มีการบันทึกสต๊อกในบ้านของวันนี้ แต่ไม่มีรายการที่ใช้เทียบได้");
    expect(text).not.toContain("⚠️ ยังไม่มีข้อมูลสต๊อกในบ้านของวันนี้");
  });

  test("rows that could not be identified are named, not silently dropped", () => {
    const text = joined(report({ items: [], unidentifiedRowCount: 4 }));
    expect(text).toContain("⚠️ มีรายการที่ระบุสินค้าหรือหน่วยไม่ได้ 4 รายการ");
    expect(text).toContain("รายการเหล่านี้ไม่ได้อยู่ในอันดับด้านบน");
  });

  test("a quiet day carries no warning block at all", () => {
    const text = joined(report());
    expect(text).not.toContain("⚠️ ข้อมูลวันนี้ยังไม่ครบ");
    expect(text).not.toContain("⚠️ ยังไม่มีข้อมูลสต๊อกในบ้าน");
  });
});

describe("purchase planning message — LINE limits", () => {
  const manyItems = (count: number): PurchasePlanningItem[] =>
    Array.from({ length: count }, (_, index) => item({
      productName: `สินค้าทดสอบหมายเลข ${index}`,
      status: index % 2 === 0 ? "reduce" : "surplus",
      band: index % 2 === 0 ? "low" : "medium",
      sellThroughRate: index % 2 === 0 ? 10 + index / 1000 : 50 + index / 1000,
    }));

  test("case 25 — a long report stays inside the LINE reply limits", () => {
    const messages = buildPurchasePlanningMessages(report({ items: manyItems(400) }));

    expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
    // The headline survives capping, and the truncation is admitted.
    expect(messages[0]).toContain(PURCHASE_PLANNING_TITLE);
    expect(messages[messages.length - 1]).toContain(PURCHASE_PLANNING_OVERFLOW_NOTICE.trim());
  });

  test("a report that fits is not truncated and splits no product block", () => {
    const items = manyItems(12);
    const messages = buildPurchasePlanningMessages(report({ items }));
    const text = messages.join("\n\n");

    expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
    expect(text).not.toContain(PURCHASE_PLANNING_OVERFLOW_NOTICE.trim());
    // Every product block landed whole inside exactly one message.
    for (const block of buildPurchasePlanningBlocks(report({ items }))) {
      expect(messages.filter((message) => message.includes(block))).toHaveLength(1);
    }
  });
});
