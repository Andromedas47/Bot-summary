import { describe, expect, it } from "bun:test";
import {
  buildWhiteSheetSummaryMessage,
  buildWhiteSheetSummaryMessages,
  buildWhiteSheetSummaryMessagesFromPageModel,
  buildWhiteSheetHardStopReplyMessages,
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
import { WhiteSheetHardStopError, WhiteSheetNotSubmittedError } from "@/lib/white-sheet/compose";
import { PENDING_REFERENCE_VERIFIED_TRANSFER_WARNING } from "@/lib/white-sheet/warnings";

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

    expect(result).toContain("สรุปปิดยอด — ตลาดกี้");
    expect(result).toContain(formatThaiDate("2026-06-15"));
    expect(result).toContain("ยอดขายที่ควรได้ 9,800.00 บาท");
    expect(result).toContain("ยอดโอนที่ตรวจแล้ว 6,100.00 บาท");
    expect(result).toContain("ค่าแรง 900.00 บาท");
    expect(result).toContain("ค่าที่ 400.00 บาท");
    expect(result).toContain("ค่าถุง 60.00 บาท");
    expect(result).toContain("ค่าขนม 30.00 บาท");
    expect(result).toContain("ค่าอื่น 150.00 บาท — ค่าน้ำแข็ง");
    expect(result).toContain("รวมค่าใช้จ่าย 1,540.00 บาท");
    expect(result).toContain("เงินสดที่ควรส่ง 2,160.00 บาท");
    expect(result).toContain("เงินสดที่ส่งจริง 1,850.00 บาท");
    expect(result).toContain("เงินขาด 310.00 บาท");
    expect(result).toContain("— คำเตือน —");
    expect(result).toContain("พบสลิปโอนซ้ำในช่วงเวลาเดียวกัน");
  });

  it("formats matched closing summary without warnings section", () => {
    const result = buildWhiteSheetSummaryMessage(matchedWhiteSheetFixture);

    expect(result).toContain("✅ ยอดตรง");
    expect(result).not.toContain("— คำเตือน —");
  });

  it("formats overage closing summary", () => {
    const result = buildWhiteSheetSummaryMessage(overageWhiteSheetFixture);

    expect(result).toContain("เงินเกิน 150.00 บาท");
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

describe("buildWhiteSheetHardStopReplyMessages", () => {
  it("confirms save and refuses matched/shortage/overage claims", () => {
    const messages = buildWhiteSheetHardStopReplyMessages([
      PENDING_REFERENCE_VERIFIED_TRANSFER_WARNING,
    ]);
    const text = messages.join("\n");
    expect(text).toContain("บันทึกข้อมูลปิดยอดแล้ว ✅");
    expect(text).toContain("ยังไม่สามารถสรุปยอดตรง/ขาด/เกินได้");
    expect(text).toContain(PENDING_REFERENCE_VERIFIED_TRANSFER_WARNING);
    expect(text).not.toContain("✅ ยอดตรง");
    expect(text).not.toContain("เงินขาด");
    expect(text).not.toContain("เงินเกิน");
    assertWithinLineLimits(messages);
  });
});

describe("buildWhiteSheetSummaryMessagesFromPageModel", () => {
  it("builds messages for a submitted, trustworthy page model", () => {
    const messages = buildWhiteSheetSummaryMessagesFromPageModel({
      entryStatus: "submitted",
      summary: matchedWhiteSheetFixture,
      finalizedAt: null,
      finalizedBy: null,
    });
    assertWithinLineLimits(messages);
    expect(messages[0]).toContain("สรุปปิดยอด — วัดทุ่งลานนา");
  });

  it("refuses to build messages for a not-submitted entry", () => {
    expect(() =>
      buildWhiteSheetSummaryMessagesFromPageModel({
        entryStatus: "not_submitted",
        summary: matchedWhiteSheetFixture,
        finalizedAt: null,
        finalizedBy: null,
      }),
    ).toThrow(WhiteSheetNotSubmittedError);
  });

  it("refuses to build messages when the HARD STOP warning is present", () => {
    const hardStopSummary = {
      ...matchedWhiteSheetFixture,
      warnings: [
        "Multiple completed main produce sessions (2) exist for this market and business "
          + "date with the same transaction type (เบิก); multiple ACTIVE main sessions of "
          + "the same type must be reviewed or voided before trusting the summary.",
      ],
    };
    expect(() =>
      buildWhiteSheetSummaryMessagesFromPageModel({
        entryStatus: "submitted",
        summary: hardStopSummary,
        finalizedAt: null,
        finalizedBy: null,
      }),
    ).toThrow(WhiteSheetHardStopError);
  });
});
