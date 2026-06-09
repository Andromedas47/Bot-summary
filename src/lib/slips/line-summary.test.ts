import { describe, expect, it } from "bun:test";
import { buildSlipLineSummary } from "@/lib/slips/line-summary";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";

const walletExtraction: SlipExtraction = {
  slipType: "GWALLET",
  grossAmount: 360,
  discountAmount: 200,
  paidAmount: 160,
  transferAmount: null,
  referenceId: "f97837",
  transactionTime: "2026-06-06T08:43:00.000Z",
  senderName: null,
  receiverName: "ร้านทดสอบ",
  receiverAccountTail: null,
  confidence: 0.92,
};

describe("LINE slip summaries", () => {
  it("formats a Thai G-Wallet extraction summary", () => {
    expect(buildSlipLineSummary(walletExtraction, "EXTRACTED")).toBe([
      "🟡 อ่านข้อมูลจากรูปแล้ว",
      "",
      "ประเภท G-Wallet",
      "ยอดสินค้า 360 บาท",
      "ส่วนลด/สิทธิ 200 บาท",
      "ยอดชำระจริง 160 บาท",
      "ร้าน/ผู้รับ ร้านทดสอบ",
      "เวลา 6 มิ.ย. 2569 15:43",
      "เลขอ้างอิง f97837",
      "",
      "สถานะ อ่านข้อมูลได้จากภาพ ยังไม่ใช่การยืนยันจากธนาคาร",
    ].join("\n"));
  });

  it("formats the manual-review reply without exposing evidence details", () => {
    expect(buildSlipLineSummary(walletExtraction, "NEED_REVIEW")).toBe([
      "🔴 อ่านข้อมูลไม่ครบ",
      "",
      "ระบบไม่เห็นยอดเงิน / เวลา / เลขอ้างอิงครบถ้วน",
      "กรุณาส่งรูปใหม่ให้เห็นทั้งหน้า หรือให้แอดมินตรวจมือ",
    ].join("\n"));
  });
});
