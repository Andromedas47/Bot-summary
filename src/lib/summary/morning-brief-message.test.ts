import { describe, expect, test } from "bun:test";
import type { MorningBriefReport } from "./morning-brief";
import { countCodePoints, LINE_MESSAGE_MAX_CODE_POINTS } from "./line-chunking";
import { buildMorningBriefMessage, buildMorningBriefMessages } from "./morning-brief-message";

const BUSINESS_DATE = "2026-08-27";

function names(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
}

function report(overrides: Partial<MorningBriefReport> = {}): MorningBriefReport {
  return {
    businessDate: BUSINESS_DATE,
    purchasePlanning: {
      strong: { count: 9, productNames: names("ซื้อ", 9) },
      surplus: { count: 7, productNames: names("รอ", 7) },
      reduce: { count: 5, productNames: names("ลด", 5) },
      unknown: { count: 88, productNames: names("ห้ามแสดง", 88) },
    },
    sales: {
      confirmedSalesSatang: 2_174_074,
      valueAuthoritative: false,
      trustedCount: 77,
      unresolvedCount: 107,
      soldOutCount: 50,
      priceConflictCount: 11,
      priceConflictMarketCount: 4,
    },
    houseStock: { status: "available", groupCount: 2, totalValueSatang: 312_000 },
    ...overrides,
  };
}

describe("Morning Decision Brief", () => {
  test("renders actionable names, unknown count only, and exact sales headlines", () => {
    const message = buildMorningBriefMessage(report());

    expect(message).toContain("🌅 สรุปเช้า");
    expect(message).toContain("🟢 ควรซื้อเพิ่ม — 9 รายการ\nซื้อ1, ซื้อ2");
    expect(message).toContain("🟠 ยังไม่ควรซื้อเพิ่ม — 7 รายการ\nรอ1, รอ2");
    expect(message).toContain("🔴 ควรลดการซื้อ — 5 รายการ\nลด1, ลด2");
    expect(message).toContain("⚠️ ยังประเมินไม่ได้ 88 รายการ");
    expect(message).not.toContain("ห้ามแสดง1");
    expect(message).toContain("⚠️ ยอดที่ยืนยันแล้ว 21,740.74 บาท");
    expect(message).toContain("✅ ยืนยันได้ 77 รายการ • ⚠️ รอตรวจ 107 รายการ");
    expect(message).toContain("✅ ถือว่าขายหมดเพราะไม่มีรายการคืน — 50 รายการ");
  });

  test("compacts more than 10 actionable names", () => {
    const message = buildMorningBriefMessage(report({
      purchasePlanning: {
        strong: { count: 14, productNames: names("สินค้า", 10) },
        surplus: { count: 0, productNames: [] },
        reduce: { count: 0, productNames: [] },
        unknown: { count: 0, productNames: [] },
      },
    }));

    expect(message).toContain("สินค้า10 ... +อีก 4 รายการ");
    expect(message).not.toContain("สินค้า11");
  });

  test("partial sales is never labeled as total sales", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).not.toContain("ยอดขายรวม 21,740.74 บาท");
  });

  test("authoritative sales may use the total-sales label", () => {
    const message = buildMorningBriefMessage(report({
      sales: { ...report().sales, valueAuthoritative: true },
    }));
    expect(message).toContain("ยอดขายรวม 21,740.74 บาท");
  });

  test("price conflict is count-only with no product, market, or reason detail", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).toContain("ราคากลางขัดแย้ง 11 จุด / 4 ตลาด");
    expect(message).not.toContain("central_price_conflict");
    expect(message).not.toContain("ตลาดเอ");
  });

  test("valid House Stock shows group count and value only", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).toContain("🏠 ของในบ้าน\n2 รายการ • มูลค่า 3,120.00 บาท");
  });

  test("missing and unavailable House Stock degrade only their section", () => {
    const missing = buildMorningBriefMessage(report({ houseStock: { status: "missing" } }));
    const unavailable = buildMorningBriefMessage(report({ houseStock: { status: "unavailable" } }));

    expect(missing).toContain("ยังไม่มีข้อมูลสต๊อกบ้าน");
    expect(unavailable).toContain("⚠️ ยังตรวจสต๊อกบ้านไม่ได้");
    for (const message of [missing, unavailable]) {
      expect(message).toContain("🛒 แผนซื้อของ");
      expect(message).toContain("💰 ยอดขาย");
    }
  });

  test("busy day stays one LINE message and contains no per-market sales blocks", () => {
    const messages = buildMorningBriefMessages(report());
    expect(messages).toHaveLength(1);
    expect(countCodePoints(messages[0]!)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    expect(messages[0]).not.toContain("ผลประกอบการ");
    expect(messages[0]).not.toContain("เงินสดคงเหลือจริง");
  });

  test("pathological product names remain bounded without losing numeric headlines", () => {
    const longName = "ย".repeat(10_000);
    const messages = buildMorningBriefMessages(report({
      purchasePlanning: {
        strong: { count: 100, productNames: Array(10).fill(longName) },
        surplus: { count: 100, productNames: Array(10).fill(longName) },
        reduce: { count: 100, productNames: Array(10).fill(longName) },
        unknown: { count: 88, productNames: [] },
      },
    }));

    expect(messages).toHaveLength(1);
    expect(countCodePoints(messages[0]!)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    expect(messages[0]).toContain("⚠️ ยอดที่ยืนยันแล้ว 21,740.74 บาท");
    expect(messages[0]).toContain("2 รายการ • มูลค่า 3,120.00 บาท");
  });
});
