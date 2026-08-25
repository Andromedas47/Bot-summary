import { describe, expect, test } from "bun:test";
import type { DailyFinancialSettlementResult } from "@/lib/settlement/daily-financial-settlement";
import type { MorningBriefReport } from "./morning-brief";
import { countCodePoints, LINE_MESSAGE_MAX_CODE_POINTS } from "./line-chunking";
import {
  buildMorningBriefMessage,
  buildMorningBriefMessages,
  MORNING_BRIEF_NO_FINANCIAL_NOTICE,
} from "./morning-brief-message";

const BUSINESS_DATE = "2026-08-22";
const MARKET = "ตลาดกลาง";

/** Same fixture as daily-financial-settlement-loader.test.ts's "22 Aug closes exactly matched". */
function matchedResult(overrides: Partial<DailyFinancialSettlementResult> = {}): DailyFinancialSettlementResult {
  return {
    status: "CLOSED_MATCHED",
    businessDate: BUSINESS_DATE,
    marketLabelNormalized: MARKET,
    whiteSheetSales: 28632,
    transferTotal: 10389,
    ownerCash: 1500,
    expensesTotal: 3030,
    wagesTotal: 4160,
    actualCash: 9553,
    expectedCash: 9553,
    difference: 0,
    missingInputs: [],
    uncertainty: [],
    ...overrides,
  };
}

function report(overrides: Partial<MorningBriefReport> = {}): MorningBriefReport {
  return {
    businessDate: BUSINESS_DATE,
    purchaseCounts: { strong: 3, surplus: 2, reduce: 1, unknown: 0 },
    financial: [{ marketLabelNormalized: MARKET, result: matchedResult() }],
    issues: { critical: 0, actionRequired: 0 },
    ...overrides,
  };
}

describe("buildMorningBriefMessage — a complete normal day", () => {
  test("renders the exact target shape's numbers and status", () => {
    const message = buildMorningBriefMessage(report());

    expect(message).toContain("🌅 สรุปประจำวัน");
    expect(message).toContain("📦 แผนซื้อ");
    expect(message).toContain("🟢 3 • 🟠 2 • 🔴 1 • ⚠️ 0");
    expect(message).toContain("💰 ผลประกอบการ");
    expect(message).toContain("ยอดขายตามใบขาว 28,632.00 บาท");
    expect(message).toContain("เงินโอน 10,389.00 บาท");
    expect(message).toContain("เงินสดที่ควรเหลือ 9,553.00 บาท");
    expect(message).toContain("เงินสดคงเหลือจริง 9,553.00 บาท");
    expect(message).toContain("✅ เงินปิดตรง");
  });

  test("no issues means no ต้องตรวจ line at all", () => {
    const message = buildMorningBriefMessage(report({ issues: { critical: 0, actionRequired: 0 } }));
    expect(message).not.toContain("ต้องตรวจ");
  });

  test("a single market never prints its own label — the counts line is enough context", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).not.toContain(MARKET);
  });
});

describe("buildMorningBriefMessage — financial mismatch", () => {
  test("a shortage renders 🚨 with the ขาด label and magnitude, never ✅", () => {
    const message = buildMorningBriefMessage(
      report({
        financial: [
          {
            marketLabelNormalized: MARKET,
            result: matchedResult({ status: "CLOSED_DIFFERENCE", actualCash: 9000, difference: -553 }),
          },
        ],
      }),
    );
    expect(message).toContain("🚨 เงินปิดไม่ตรง / ขาด 553.00 บาท");
    expect(message).not.toContain("✅ เงินปิดตรง");
  });

  test("an excess renders 🚨 with the เกิน label", () => {
    const message = buildMorningBriefMessage(
      report({
        financial: [
          {
            marketLabelNormalized: MARKET,
            result: matchedResult({ status: "CLOSED_DIFFERENCE", actualCash: 10000, difference: 447 }),
          },
        ],
      }),
    );
    expect(message).toContain("🚨 เงินปิดไม่ตรง / เกิน 447.00 บาท");
  });
});

describe("buildMorningBriefMessage — INCOMPLETE financial input", () => {
  test("never renders เงินปิดตรง when a required input is missing", () => {
    const incomplete: DailyFinancialSettlementResult = {
      status: "INCOMPLETE",
      businessDate: BUSINESS_DATE,
      marketLabelNormalized: MARKET,
      whiteSheetSales: null,
      transferTotal: 0,
      ownerCash: null,
      expensesTotal: null,
      wagesTotal: null,
      actualCash: null,
      expectedCash: null,
      difference: null,
      missingInputs: ["white_sheet_sales", "owner_cash", "expenses", "wages", "actual_cash"],
      uncertainty: [],
    };
    const message = buildMorningBriefMessage(report({ financial: [{ marketLabelNormalized: MARKET, result: incomplete }] }));

    expect(message).not.toContain("เงินปิดตรง");
    expect(message).toContain("⚠️ ยังปิดยอดไม่ได้");
    expect(message).toContain("ยอดขายตามใบขาว -");
    expect(message).toContain("เงินสดที่ควรเหลือ -");
  });
});

describe("buildMorningBriefMessage — purchase planning unknowns", () => {
  test("unknown count surfaces in the compact counts line", () => {
    const message = buildMorningBriefMessage(
      report({ purchaseCounts: { strong: 0, surplus: 0, reduce: 0, unknown: 7 } }),
    );
    expect(message).toContain("🟢 0 • 🟠 0 • 🔴 0 • ⚠️ 7");
  });
});

describe("buildMorningBriefMessage — actionable issues", () => {
  test("a critical issue renders the urgent line", () => {
    const message = buildMorningBriefMessage(report({ issues: { critical: 2, actionRequired: 0 } }));
    expect(message).toContain("🚨 ต้องตรวจด่วน 2 เรื่อง");
  });

  test("action-required issues render the ต้องตรวจ line from the target shape", () => {
    const message = buildMorningBriefMessage(report({ issues: { critical: 0, actionRequired: 2 } }));
    expect(message).toContain("⚠️ ต้องตรวจ 2 เรื่อง");
  });

  test("a long issue count still renders as one short line, never itemized", () => {
    const message = buildMorningBriefMessage(report({ issues: { critical: 41, actionRequired: 118 } }));
    expect(message).toContain("🚨 ต้องตรวจด่วน 41 เรื่อง");
    expect(message).toContain("⚠️ ต้องตรวจ 118 เรื่อง");
    // Concise regardless of how large the underlying counts are — no per-issue detail.
    expect(countCodePoints(message)).toBeLessThan(600);
  });
});

describe("buildMorningBriefMessage — no financial data", () => {
  test("renders the waiting notice rather than a blank or fabricated 💰 block", () => {
    const message = buildMorningBriefMessage(report({ financial: [] }));
    expect(message).toContain(MORNING_BRIEF_NO_FINANCIAL_NOTICE);
  });
});

describe("buildMorningBriefMessage — multiple markets", () => {
  test("each market's block is labeled when more than one is present", () => {
    const message = buildMorningBriefMessage(
      report({
        financial: [
          { marketLabelNormalized: "ตลาดเอ", result: matchedResult({ marketLabelNormalized: "ตลาดเอ" }) },
          {
            marketLabelNormalized: "ตลาดบี",
            result: matchedResult({
              marketLabelNormalized: "ตลาดบี",
              status: "CLOSED_DIFFERENCE",
              actualCash: 9000,
              difference: -553,
            }),
          },
        ],
      }),
    );
    expect(message).toContain("ตลาดเอ");
    expect(message).toContain("ตลาดบี");
    expect((message.match(/💰 ผลประกอบการ/g) ?? []).length).toBe(2);
  });
});

describe("buildMorningBriefMessages — LINE limits", () => {
  test("a normal brief is exactly one message, well under the code-point limit", () => {
    const messages = buildMorningBriefMessages(report());
    expect(messages).toHaveLength(1);
    expect(countCodePoints(messages[0]!)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
  });

  test("many markets still respect the LINE code-point limit per message", () => {
    const financial = Array.from({ length: 60 }, (_, i) => ({
      marketLabelNormalized: `ตลาด${i}`,
      result: matchedResult({ marketLabelNormalized: `ตลาด${i}` }),
    }));
    const messages = buildMorningBriefMessages(report({ financial }));
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
  });
});

describe("buildMorningBriefMessage — business date", () => {
  test("renders the given business date, not today's date", () => {
    const message = buildMorningBriefMessage(report({ businessDate: "2026-01-05" }));
    expect(message).toContain("ข้อมูลวันที่");
    expect(message).not.toContain("2026-08-22");
  });
});
