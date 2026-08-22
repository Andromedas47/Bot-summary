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
  EMPTY_GREEN_NOTICE,
  formatSellThroughRate,
  PRICE_CONFLICT_FOOTER,
  PURCHASE_PLANNING_EMPTY_NOTICE,
  PURCHASE_PLANNING_OVERFLOW_NOTICE,
  PURCHASE_PLANNING_TITLE,
  STATUS_HEADINGS,
  WAITING_HOUSE_STOCK,
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

const AUDIT_LEAKS = [
  "เบิก ",
  "ขายประมาณ",
  "คืนดีจากตลาด",
  "คืนเสีย",
  "เหลือในบ้านหลังเบิก",
  "ของดีพร้อมขายต่อประมาณ",
  "→ ",
  "⚠️ ราคาขัดแย้ง แต่จำนวนใช้ประเมินได้",
  "ไม่พบรายการที่เทียบหน่วยเดียวกันได้",
];

describe("purchase planning message — compact operator UX", () => {
  test("leads with the short title and Thai business date, no method prose", () => {
    const header = buildPurchasePlanningBlocks(report())[0]!;
    expect(header).toBe(`${PURCHASE_PLANNING_TITLE}\nข้อมูลวันที่ 21 สิงหาคม 2569`);
    expect(header).not.toContain("วิเคราะห์จากยอดเบิก");
    expect(header).not.toContain("ราคาไม่ใช้ในการจัดอันดับ");
  });

  test("an empty green section is still visible", () => {
    const text = joined(report({
      items: [item({ status: "surplus", band: "medium" })],
    }));
    expect(text).toContain(STATUS_HEADINGS.strong);
    expect(text).toContain(EMPTY_GREEN_NOTICE);
  });

  test("an empty day still answers the buy question, then says there is no data", () => {
    const text = joined(report({ items: [] }));
    expect(text).toContain(STATUS_HEADINGS.strong);
    expect(text).toContain(EMPTY_GREEN_NOTICE);
    expect(text).toContain(PURCHASE_PLANNING_EMPTY_NOTICE);
  });

  test("a confirmed green item is one line with sell-through and next-day stock", () => {
    const text = joined(report({
      items: [item({
        productName: "สับปะรด",
        unit: "ถุง",
        sellThroughRate: 82,
        band: "high",
        status: "strong",
        nextDayGoodStockQuantity: 4,
        nextStockToSoldRatio: 0.1,
      })],
    }));
    expect(text).toContain(STATUS_HEADINGS.strong);
    expect(text).toContain("สับปะรด — ขายออก 82% • เหลือขายต่อ ~4 ถุง");
    expect(text).not.toContain(EMPTY_GREEN_NOTICE);
    for (const leak of AUDIT_LEAKS) expect(text).not.toContain(leak);
  });

  test("HIGH with missing stock stays 🟠 and asks to wait for house stock", () => {
    const text = joined(report({
      items: [item({
        productName: "สับปะรด",
        unit: "ถุง",
        withdrawnQuantity: 34,
        goodReturnQuantity: 10,
        damagedQuantity: 0,
        estimatedSoldQuantity: 24,
        sellThroughRate: 70.6,
        band: "high",
        status: "surplus",
        houseStockQuantity: null,
        stockAbsence: "no_match",
        nextDayGoodStockQuantity: null,
        nextStockToSoldRatio: null,
      })],
    }));
    expect(text).toContain(STATUS_HEADINGS.surplus);
    expect(text).toContain(`สับปะรด — ขายออก 70.6% • ${WAITING_HOUSE_STOCK}`);
    expect(text).not.toContain(STATUS_HEADINGS.strong + "\n\nสับปะรด");
    expect(text).toContain(EMPTY_GREEN_NOTICE);
    expect(text).not.toContain("ไม่พบรายการที่เทียบหน่วยเดียวกันได้");
    expect(text).not.toContain("เหลือในบ้านหลังเบิก");
  });

  test("MEDIUM is a concise orange line without a return breakdown", () => {
    const text = joined(report({
      items: [item({
        houseStockQuantity: null,
        stockAbsence: "no_match",
        nextDayGoodStockQuantity: null,
        nextStockToSoldRatio: null,
      })],
    }));
    expect(text).toContain(STATUS_HEADINGS.surplus);
    expect(text).toContain("แอปเปิ้ล — ขายออก 40.6%");
    expect(text).not.toContain("เหลือขายต่อ");
    expect(text).not.toContain(WAITING_HOUSE_STOCK);
    for (const leak of ["เบิก ", "คืนดีจากตลาด", "คืนเสีย", "→ "]) {
      expect(text).not.toContain(leak);
    }
  });

  test("LOW with known next-day stock is a concise red leftover line", () => {
    const text = joined(report({
      items: [item({
        productName: "ลูกพลับ",
        sellThroughRate: 18.7,
        band: "low",
        status: "reduce",
        nextDayGoodStockQuantity: 447,
      })],
    }));
    expect(text).toContain(STATUS_HEADINGS.reduce);
    expect(text).toContain("ลูกพลับ — ขายออก 18.7% • เหลือขายต่อ ~447 ลูก");
    expect(text).not.toContain("เบิก ");
    expect(text).not.toContain("→ ");
  });

  test("LOW without a house match does not repeat the long missing-stock message", () => {
    const text = joined(report({
      items: [item({
        productName: "สาลี่",
        sellThroughRate: 29,
        band: "low",
        status: "reduce",
        houseStockQuantity: null,
        stockAbsence: "no_match",
        nextDayGoodStockQuantity: null,
        nextStockToSoldRatio: null,
      })],
    }));
    expect(text).toContain("สาลี่ — ขายออก 29%");
    expect(text).not.toContain("เหลือขายต่อ");
    expect(text).not.toContain("ไม่พบรายการที่เทียบหน่วยเดียวกันได้");
    expect(text).not.toContain("เหลือในบ้านหลังเบิก");
  });

  test("unknown products are named under ⚠️ with no percentage", () => {
    const text = joined(report({
      items: [
        item({
          productName: "ไซมัส",
          unit: "โล",
          estimatedSoldQuantity: null,
          sellThroughRate: null,
          band: null,
          status: "unknown",
          uncertaintyReasons: ["product_return_absent"],
          houseStockQuantity: null,
          nextDayGoodStockQuantity: null,
          nextStockToSoldRatio: null,
        }),
        item({
          productName: "แตงไทย",
          unit: "โล",
          estimatedSoldQuantity: null,
          sellThroughRate: null,
          band: null,
          status: "unknown",
          uncertaintyReasons: ["return_missing"],
          houseStockQuantity: null,
          nextDayGoodStockQuantity: null,
          nextStockToSoldRatio: null,
        }),
      ],
    }));
    expect(text).toContain(`${STATUS_HEADINGS.unknown} 2 รายการ`);
    expect(text).toContain("ไซมัส, แตงไทย");
    expect(text).not.toContain("ขายออก ");
    expect(text).not.toContain("ขายประมาณ");
    expect(text).not.toContain("ยังไม่พบรายการชั่งคืน");
  });

  test("the 21/08/2569 production-shaped day reads as a buy decision, not an audit", () => {
    const text = joined(report({
      unresolvedSessionCount: 15,
      items: [
        item({
          productName: "สับปะรด",
          unit: "ถุง",
          withdrawnQuantity: 34,
          goodReturnQuantity: 10,
          damagedQuantity: 0,
          estimatedSoldQuantity: 24,
          sellThroughRate: 70.588,
          band: "high",
          status: "surplus",
          houseStockQuantity: null,
          stockAbsence: "no_match",
          nextDayGoodStockQuantity: null,
          nextStockToSoldRatio: null,
        }),
        item({
          productName: "อะโวคาโด",
          unit: "โล",
          sellThroughRate: 46.5,
          band: "medium",
          status: "surplus",
          houseStockQuantity: null,
          nextDayGoodStockQuantity: null,
          nextStockToSoldRatio: null,
        }),
        item({
          productName: "ลองกอง",
          unit: "โล",
          sellThroughRate: 44.5,
          band: "medium",
          status: "surplus",
          houseStockQuantity: null,
          nextDayGoodStockQuantity: null,
          nextStockToSoldRatio: null,
        }),
        item({
          sellThroughRate: 40.598,
          band: "medium",
          status: "surplus",
          houseStockQuantity: null,
          nextDayGoodStockQuantity: null,
          nextStockToSoldRatio: null,
        }),
        item({
          productName: "ลูกพลับ",
          sellThroughRate: 18.7,
          band: "low",
          status: "reduce",
          nextDayGoodStockQuantity: 447,
        }),
        item({
          productName: "สาลี่",
          sellThroughRate: 29,
          band: "low",
          status: "reduce",
          nextDayGoodStockQuantity: 581,
        }),
        item({
          productName: "มังคุด",
          unit: "โล",
          sellThroughRate: 29.9,
          band: "low",
          status: "reduce",
          nextDayGoodStockQuantity: 172.4,
        }),
        item({
          productName: "ลูกไหนดำ",
          unit: "โล",
          sellThroughRate: 24.3,
          band: "low",
          status: "reduce",
          nextDayGoodStockQuantity: 61.3,
        }),
        item({
          productName: "ไซมัส",
          unit: "โล",
          estimatedSoldQuantity: null,
          sellThroughRate: null,
          band: null,
          status: "unknown",
          houseStockQuantity: null,
          nextDayGoodStockQuantity: null,
          nextStockToSoldRatio: null,
        }),
        item({
          productName: "แตงไทย",
          unit: "โล",
          estimatedSoldQuantity: null,
          sellThroughRate: null,
          band: null,
          status: "unknown",
          houseStockQuantity: null,
          nextDayGoodStockQuantity: null,
          nextStockToSoldRatio: null,
        }),
      ],
    }));

    expect(text).toContain(`${STATUS_HEADINGS.strong}\n\n${EMPTY_GREEN_NOTICE}`);
    expect(text).toContain(`สับปะรด — ขายออก 70.6% • ${WAITING_HOUSE_STOCK}`);
    expect(text).toContain("แอปเปิ้ล — ขายออก 40.6%");
    expect(text).toContain("ลูกพลับ — ขายออก 18.7% • เหลือขายต่อ ~447 ลูก");
    expect(text).toContain("สาลี่ — ขายออก 29% • เหลือขายต่อ ~581 ลูก");
    expect(text).toContain("มังคุด — ขายออก 29.9% • เหลือขายต่อ ~172.4 กก.");
    expect(text).toContain("ลูกไหนดำ — ขายออก 24.3% • เหลือขายต่อ ~61.3 กก.");
    expect(text).toContain(`${STATUS_HEADINGS.unknown} 2 รายการ`);
    expect(text).toContain("ไซมัส, แตงไทย");
    expect(text.indexOf("สับปะรด")).toBeLessThan(text.indexOf("อะโวคาโด"));
    expect(text.indexOf("อะโวคาโด")).toBeLessThan(text.indexOf("ลองกอง"));
    expect(text).toContain("⚠️ ข้อมูลไม่สมบูรณ์ 15 ชุด");
    expect(text).toContain("รายการ ⚠️ ด้านบนจึงยังไม่ถูกใช้ตัดสินใจซื้อ");
    expect(text).not.toContain("เบิก ");
    expect(text).not.toContain("ขายประมาณ");
    expect(text).not.toContain("คืนดีจากตลาด");
  });
});

describe("purchase planning message — rate printing", () => {
  test("formatSellThroughRate keeps whole numbers whole", () => {
    expect(formatSellThroughRate(82)).toBe("82%");
    expect(formatSellThroughRate((95 / 234) * 100)).toBe("40.6%");
    expect(formatSellThroughRate((10.5 / 45.9) * 100)).toBe("22.9%");
  });

  test("the printed rate never crosses into a band the product is not in", () => {
    expect(formatSellThroughRate(39.95, "low")).toBe("39.9%");
    expect(formatSellThroughRate(69.98, "medium")).toBe("69.9%");
    expect(formatSellThroughRate(39.94, "low")).toBe("39.9%");
    expect(formatSellThroughRate(70, "high")).toBe("70%");
    expect(formatSellThroughRate(40, "medium")).toBe("40%");
  });

  test("the rendered rate agrees with the heading it was filed under", () => {
    const text = joined(report({
      items: [item({
        sellThroughRate: 39.95,
        band: "low",
        status: "reduce",
        nextDayGoodStockQuantity: null,
      })],
    }));
    expect(text).toContain(STATUS_HEADINGS.reduce);
    expect(text).toContain("ขายออก 39.9%");
    expect(text).not.toContain("ขายออก 40%");
  });
});

describe("purchase planning message — day-level warnings", () => {
  test("unresolved produce documents are named once in the footer", () => {
    const text = joined(report({
      unresolvedSessionCount: 15,
      items: [item({
        productName: "ไซมัส",
        estimatedSoldQuantity: null,
        sellThroughRate: null,
        band: null,
        status: "unknown",
        nextDayGoodStockQuantity: null,
      })],
    }));
    expect(text).toContain("⚠️ ข้อมูลไม่สมบูรณ์ 15 ชุด");
    expect(text).toContain("รายการ ⚠️ ด้านบนจึงยังไม่ถูกใช้ตัดสินใจซื้อ");
    expect(text).not.toContain("ข้อมูลวันนี้ยังไม่ครบ");
    expect(text.match(/ข้อมูลไม่สมบูรณ์ 15 ชุด/g)?.length).toBe(1);
  });

  test("a missing house snapshot is stated rather than assumed empty", () => {
    const text = joined(report({ stockAbsence: "no_snapshot" }));
    expect(text).toContain("⚠️ ยังไม่มีข้อมูลสต๊อกในบ้านของวันนี้");
  });

  test("duplicate house snapshots are reported, not silently resolved", () => {
    const text = joined(report({ stockAbsence: "snapshot_conflict" }));
    expect(text).toContain("⚠️ พบข้อมูลสต๊อกในบ้านมากกว่าหนึ่งชุด จึงไม่ใช้เทียบ");
  });

  test("a snapshot that held nothing usable is not reported as no snapshot", () => {
    const text = joined(report({ stockAbsence: "snapshot_empty" }));
    expect(text).toContain("⚠️ มีการบันทึกสต๊อกในบ้าน แต่ไม่มีรายการที่ใช้เทียบได้");
    expect(text).not.toContain("⚠️ ยังไม่มีข้อมูลสต๊อกในบ้านของวันนี้");
  });

  test("rows that could not be identified are named once, not silently dropped", () => {
    const text = joined(report({ items: [], unidentifiedRowCount: 4 }));
    expect(text).toContain("⚠️ มีรายการที่ระบุสินค้าหรือหน่วยไม่ได้ 4 รายการ");
  });

  test("a price conflict does not spam the item line", () => {
    const text = joined(report({ items: [item({ priceConflict: true })] }));
    expect(text).toContain(STATUS_HEADINGS.surplus);
    expect(text).toContain("แอปเปิ้ล — ขายออก 40.6%");
    expect(text).toContain(PRICE_CONFLICT_FOOTER);
    expect(text).not.toContain("⚠️ ราคาขัดแย้ง แต่จำนวนใช้ประเมินได้");
    expect(text.match(/ราคาขัดแย้ง/g)?.length).toBe(1);
  });

  test("a quiet day carries no warning block at all", () => {
    const text = joined(report());
    expect(text).not.toContain("⚠️ ข้อมูลไม่สมบูรณ์");
    expect(text).not.toContain("⚠️ ยังไม่มีข้อมูลสต๊อกในบ้าน");
    expect(text).not.toContain("ราคาขัดแย้ง");
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

  test("a long report stays inside the LINE reply limits", () => {
    const messages = buildPurchasePlanningMessages(report({ items: manyItems(400) }));

    expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
    expect(messages[0]).toContain(PURCHASE_PLANNING_TITLE);
    expect(messages[messages.length - 1]).toContain(PURCHASE_PLANNING_OVERFLOW_NOTICE.trim());
  });

  test("a report that fits is not truncated and splits no product block", () => {
    const items = manyItems(12);
    const messages = buildPurchasePlanningMessages(report({ items }));
    const text = messages.join("\n\n");

    expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
    expect(text).not.toContain(PURCHASE_PLANNING_OVERFLOW_NOTICE.trim());
    for (const block of buildPurchasePlanningBlocks(report({ items }))) {
      expect(messages.filter((message) => message.includes(block))).toHaveLength(1);
    }
  });
});
