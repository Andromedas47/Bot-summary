import type { SlipDuplicateResult } from "@/lib/slips/transaction-dedupe";

/**
 * Shortens a transaction reference for display: keeps enough to be useful
 * for a clerk to cross-check without printing the full raw value.
 */
function shortenReference(transactionId: string): string {
  if (transactionId.length <= 8) return transactionId;
  return `…${transactionId.slice(-6)}`;
}

/**
 * Builds the LINE warning text for a duplicate-transaction-id result.
 * Returns null for "unique" — callers should fall back to the normal
 * slip summary in that case.
 */
export function buildSlipTransactionDuplicateWarning(result: SlipDuplicateResult): string | null {
  if (result.status === "duplicate_same_source") {
    return [
      "🔴 สลิปนี้ถูกส่งและตรวจสอบแล้วในกลุ่มนี้",
      "ระบบไม่นำยอดมารวมซ้ำ",
      `รหัสรายการ: ${shortenReference(result.transactionId)}`,
    ].join("\n");
  }

  if (result.status === "duplicate_cross_source") {
    return [
      "🔴 พบ Transaction ID ซ้ำกับสลิปที่ตรวจสอบแล้วในตลาดอื่น",
      "ระบบไม่นำยอดมารวม",
      "กรุณาตรวจสอบกับเสมียน",
      `รหัสรายการ: ${shortenReference(result.transactionId)}`,
    ].join("\n");
  }

  if (result.status === "missing_transaction_id") {
    return [
      "🟡 ไม่พบ Transaction ID ที่ใช้ตรวจสอบสลิปซ้ำได้",
      "รายการนี้ต้องตรวจสอบด้วยมือก่อนรวมยอด",
    ].join("\n");
  }

  return null;
}
