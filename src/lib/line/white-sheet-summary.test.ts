import { describe, expect, it } from "bun:test";
import {
  buildWhiteSheetSummaryMessage,
  buildWhiteSheetSummaryMessages,
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "./white-sheet-summary";
import {
  matchedWhiteSheetFixture,
  overageWhiteSheetFixture,
  shortageWhiteSheetFixture,
  uncategorizedWarningFixture,
} from "@/components/white-sheet/white-sheet-fixtures";
import { formatThaiDate } from "@/lib/date";

function assertWithinLineLimits(messages: string[]) {
  expect(messages.length).toBeGreaterThanOrEqual(1);
  expect(messages.length).toBeLessThanOrEqual(LINE_REPLY_MAX_MESSAGES);
  for (const message of messages) {
    expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
  }
}

describe("buildWhiteSheetSummaryMessage", () => {
  it("formats shortage closing summary", () => {
    const result = buildWhiteSheetSummaryMessage(shortageWhiteSheetFixture);

    expect(result).toContain("สรุปปิดยอด ตลาดกี้");
    expect(result).toContain(`วันที่ ${formatThaiDate("2026-06-15")}`);
    expect(result).toContain("ยอดขายที่ควรได้: 9,800.00 บาท");
    expect(result).toContain("เงินโอนที่ตรวจแล้ว: 6,100.00 บาท");
    expect(result).toContain("- ค่าแรง: 900.00 บาท");
    expect(result).toContain("- ค่าที่: 400.00 บาท");
    expect(result).toContain("- ค่าถุง: 60.00 บาท");
    expect(result).toContain("- ค่าขนม: 30.00 บาท");
    expect(result).toContain("- ค่าใช้จ่ายอื่น: 150.00 บาท");
    expect(result).toContain("(ค่าน้ำแข็ง)");
    expect(result).toContain("รวมค่าใช้จ่าย: 1,540.00 บาท");
    expect(result).toContain("เงินสดที่ควรส่ง: 2,160.00 บาท");
    expect(result).toContain("เงินสดส่งจริง: 1,850.00 บาท");
    expect(result).toContain("ผลต่าง: เงินขาด 310.00 บาท");
    expect(result).toContain("— คำเตือน —");
    expect(result).toContain("พบสลิปโอนซ้ำในช่วงเวลาเดียวกัน");
  });

  it("formats matched closing summary without warnings section", () => {
    const result = buildWhiteSheetSummaryMessage(matchedWhiteSheetFixture);

    expect(result).toContain("ผลต่าง: ยอดตรง 0.00 บาท");
    expect(result).not.toContain("— คำเตือน —");
  });

  it("formats overage closing summary", () => {
    const result = buildWhiteSheetSummaryMessage(overageWhiteSheetFixture);

    expect(result).toContain("ผลต่าง: เงินเกิน 150.00 บาท");
  });

  it("includes uncategorized warning in separated section", () => {
    const result = buildWhiteSheetSummaryMessage(uncategorizedWarningFixture);

    expect(result).toContain("— คำเตือน —");
    expect(result).toContain("มีรายการที่ยังไม่ได้จัดหมวด");
  });

  it("does not mutate the supplied view model", () => {
    const fixture = structuredClone(shortageWhiteSheetFixture);
    buildWhiteSheetSummaryMessage(fixture);
    expect(fixture).toEqual(shortageWhiteSheetFixture);
  });

  it("stays within LINE message length limits", () => {
    const messages = buildWhiteSheetSummaryMessages(shortageWhiteSheetFixture);
    assertWithinLineLimits(messages);
  });

  it("splits only when message exceeds LINE limit", () => {
    const longWarningFixture = {
      ...shortageWhiteSheetFixture,
      warnings: Array.from(
        { length: 250 },
        (_, i) => `คำเตือนทดสอบหมายเลข ${i + 1} — รายละเอียดเพิ่มเติมสำหรับการตรวจสอบความยาวข้อความ LINE`,
      ),
    };

    const full = buildWhiteSheetSummaryMessage(longWarningFixture);
    expect(countCodePoints(full)).toBeGreaterThan(LINE_MESSAGE_MAX_CODE_POINTS);

    const messages = buildWhiteSheetSummaryMessages(longWarningFixture);
    assertWithinLineLimits(messages);
    expect(messages.length).toBeGreaterThan(1);
  });
});
