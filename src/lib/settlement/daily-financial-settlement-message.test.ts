import { describe, expect, test } from "bun:test";
import { computeDailyFinancialSettlement } from "./daily-financial-settlement";
import {
  buildDailyFinancialSettlementMessage,
  buildDailyFinancialSettlementMessages,
} from "./daily-financial-settlement-message";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";

const IDENTITY = { businessDate: "2026-08-22", marketLabelNormalized: "ตลาดกลาง" };

describe("buildDailyFinancialSettlementMessage", () => {
  test("matched day renders the closed-matched line and every required field", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, {
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9553,
    });
    const message = buildDailyFinancialSettlementMessage(result);
    expect(message).toContain("💰 สรุปผลประกอบการประจำวัน");
    expect(message).toContain("ยอดขายตามใบขาว");
    expect(message).toContain("เงินโอน");
    expect(message).toContain("เงินให้เจ้า");
    expect(message).toContain("ค่าใช้จ่าย");
    expect(message).toContain("ค่าแรง");
    expect(message).toContain("เงินสดที่ควรเหลือ");
    expect(message).toContain("เงินสดคงเหลือจริง");
    expect(message).toContain("✅ เงินปิดตรง");
  });

  test("shortage renders ขาด with the absolute amount", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, {
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9000,
    });
    const message = buildDailyFinancialSettlementMessage(result);
    expect(message).toContain("🚨 เงินปิดไม่ตรง / ขาด");
    expect(message).not.toContain("✅ เงินปิดตรง");
  });

  test("excess renders เกิน with the absolute amount", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, {
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9600,
    });
    const message = buildDailyFinancialSettlementMessage(result);
    expect(message).toContain("🚨 เงินปิดไม่ตรง / เกิน");
  });

  test("INCOMPLETE never renders the matched/shortage/overage lines", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, {
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: null,
    });
    const message = buildDailyFinancialSettlementMessage(result);
    expect(message).toContain("⚠️ ยังปิดยอดไม่ได้");
    expect(message).toContain("เงินสดคงเหลือจริง");
    expect(message).not.toContain("✅ เงินปิดตรง");
    expect(message).not.toContain("🚨 เงินปิดไม่ตรง");
  });

  test("uncertainty notes are appended, never silently dropped", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, {
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9553,
      transferUncertainty: ["มีสลิปที่ยังไม่มีเลขอ้างอิง 1 รายการ"],
    });
    const message = buildDailyFinancialSettlementMessage(result);
    expect(message).toContain("มีสลิปที่ยังไม่มีเลขอ้างอิง 1 รายการ");
  });

  test("produce cross-check appears as a separate informational section", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, {
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9553,
      produceCrossCheck: { expectedSales: 27000, warnings: [] },
    });
    const message = buildDailyFinancialSettlementMessage(result);
    expect(message).toContain("ข้อมูลอ้างอิงจากรายการชั่ง");
    expect(message).toContain("27,000.00 บาท");
  });
});

describe("buildDailyFinancialSettlementMessages", () => {
  test("stays within the LINE code-point budget", () => {
    const result = computeDailyFinancialSettlement(IDENTITY, {
      whiteSheetSales: 28632,
      transferTotal: 10389,
      ownerCash: 1500,
      expensesTotal: 3030,
      wagesTotal: 4160,
      actualCash: 9553,
    });
    const messages = buildDailyFinancialSettlementMessages(result);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
  });
});
