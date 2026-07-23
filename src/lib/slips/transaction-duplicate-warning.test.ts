import { describe, expect, it } from "bun:test";
import { buildSlipTransactionDuplicateWarning } from "./transaction-duplicate-warning";
import type { SlipDuplicateResult } from "./transaction-dedupe";

describe("buildSlipTransactionDuplicateWarning", () => {
  it("returns null for a unique result (caller falls back to the normal summary)", () => {
    const result: SlipDuplicateResult = { status: "unique", transactionId: "REF-001" };
    expect(buildSlipTransactionDuplicateWarning(result)).toBeNull();
  });

  it("builds the same-group warning with a shortened reference", () => {
    const result: SlipDuplicateResult = {
      status: "duplicate_same_source",
      transactionId: "ABCDEFGH12345",
      originalRecordId: "check-orig",
    };
    const text = buildSlipTransactionDuplicateWarning(result)!;
    expect(text).toContain("สลิปนี้ถูกส่งและตรวจสอบแล้วในกลุ่มนี้");
    expect(text).toContain("ระบบไม่นำยอดมารวมซ้ำ");
    expect(text).toContain("…H12345");
  });

  it("builds the cross-group/market warning", () => {
    const result: SlipDuplicateResult = {
      status: "duplicate_cross_source",
      transactionId: "REF-99999999",
      originalRecordId: "check-orig",
      originalMarketLabel: "ตลาดบี",
    };
    const text = buildSlipTransactionDuplicateWarning(result)!;
    expect(text).toContain("พบ Transaction ID ซ้ำกับสลิปที่ตรวจสอบแล้วในตลาดอื่น");
    expect(text).toContain("ระบบไม่นำยอดมารวม");
    expect(text).toContain("กรุณาตรวจสอบกับเสมียน");
  });

  it("builds the missing-transaction-id warning", () => {
    const result: SlipDuplicateResult = { status: "missing_transaction_id" };
    const text = buildSlipTransactionDuplicateWarning(result)!;
    expect(text).toContain("ไม่พบ Transaction ID ที่ใช้ตรวจสอบสลิปซ้ำได้");
    expect(text).toContain("รายการนี้ต้องตรวจสอบด้วยมือก่อนรวมยอด");
  });

  it("never includes a full un-shortened long reference id verbatim", () => {
    const longRef = "1234567890123456";
    const result: SlipDuplicateResult = {
      status: "duplicate_same_source",
      transactionId: longRef,
      originalRecordId: "check-orig",
    };
    const text = buildSlipTransactionDuplicateWarning(result)!;
    expect(text).not.toContain(longRef);
  });

  it("contains no account numbers, sender, or receiver identity fields", () => {
    const result: SlipDuplicateResult = {
      status: "duplicate_cross_source",
      transactionId: "REF-001",
      originalRecordId: "check-orig",
      originalMarketLabel: "ตลาดบี",
      originalBusinessDate: "2026-06-06",
    };
    const text = buildSlipTransactionDuplicateWarning(result)!;
    expect(text).not.toMatch(/บัญชี|เลขบัญชี/);
  });
});
