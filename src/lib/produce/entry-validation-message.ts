/**
 * P4A — operator-facing Thai text for the produce entry validation gate.
 *
 * Exceptions only. A round with fifty good lines and one bad one gets one
 * problem back, not fifty confirmations, and the list is capped so a pathological
 * session can never approach the LINE message limit.
 */

import { formatQuantity } from "@/lib/summary/remaining-fruit";
import type { ProduceValidationException, ProduceValidationResult } from "./entry-validation";

/** Beyond this the reply summarizes the remainder instead of listing it. */
const MAX_LISTED_EXCEPTIONS = 10;

function formatPrice(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

function describe(exception: ProduceValidationException): string[] {
  switch (exception.kind) {
    case "unknown_unit":
      return [
        `${exception.productName}`,
        `   หน่วยที่ส่ง: ${exception.unit} — ระบบไม่รู้จักหน่วยนี้`,
        ...(exception.suggestion ? [`   น่าจะเป็น: ${exception.suggestion}`] : []),
      ];
    case "unit_not_withdrawn":
      return [
        `${exception.productName}`,
        `   หน่วยที่ส่ง: ${exception.unit}`,
        `   หน่วยที่เบิก: ${exception.withdrawnUnits.join(", ")}`,
      ];
    case "product_not_withdrawn":
      return [
        `${exception.productName}`,
        "   ไม่พบในรายการเบิกของรอบนี้",
        ...(exception.suggestions.length > 0
          ? [`   รายการใกล้เคียง: ${exception.suggestions.join(", ")}`]
          : []),
      ];
    case "return_exceeds_withdrawal":
      return [
        `${exception.productName} (${exception.unit})`,
        `   เบิก: ${formatQuantity(exception.withdrawnQuantity)}`,
        `   คืนดี: ${formatQuantity(exception.goodReturnQuantity)}`,
        `   คืนเสีย: ${formatQuantity(exception.damagedQuantity)}`,
        `   เกิน: ${formatQuantity(exception.excessQuantity)}`,
      ];
    case "price_not_withdrawn":
      return [
        `${exception.productName} — ${formatQuantity(exception.quantity)} ${exception.unit}`,
        `   ราคาที่ส่ง: ${formatPrice(exception.enteredPrice)} บาท/${exception.unit}`,
        `   ราคาที่พบในรายการเบิก: ${exception.withdrawnPrices.map(formatPrice).join(", ")} บาท/${exception.unit}`,
      ];
  }
}

function numberedBlocks(exceptions: ProduceValidationException[]): string[] {
  const listed = exceptions.slice(0, MAX_LISTED_EXCEPTIONS);
  const lines: string[] = [];
  listed.forEach((exception, index) => {
    const [head, ...rest] = describe(exception);
    lines.push(`${index + 1}. ${head}`, ...rest);
  });
  const hidden = exceptions.length - listed.length;
  if (hidden > 0) lines.push(`และอีก ${hidden} รายการ`);
  return lines;
}

/**
 * The round cannot finalize. Nothing was written and the round stays open, so
 * the operator can send the corrected line as an ordinary item message.
 */
export function buildBlockingValidationReply(result: ProduceValidationResult): string {
  return [
    `⛔ พบ ${result.blocking.length} รายการที่ต้องแก้ไขก่อนจบรายการ`,
    "ระบบยังไม่ได้บันทึกอะไร",
    "",
    ...numberedBlocks(result.blocking),
    "",
    'กรุณาส่งบรรทัดที่ถูกต้องใหม่ แล้วกด "จบรายการ" อีกครั้ง',
  ].join("\n");
}

/**
 * The round can finalize, but a price differs from what was withdrawn. The
 * price is kept exactly as entered — the operator only has to say it is
 * intentional.
 */
export function buildReviewValidationReply(result: ProduceValidationResult): string {
  return [
    `⚠️ พบ ${result.reviews.length} รายการที่ราคาไม่ตรงกับรายการเบิก`,
    "",
    ...numberedBlocks(result.reviews),
    "",
    "ราคาเปลี่ยนระหว่างวันได้ ระบบจะเก็บราคาที่ส่งมาไว้ตามเดิม",
    'กรุณาตรวจว่าปรับราคาจริง แล้วกด "ยืนยัน" เพื่อบันทึก',
  ].join("\n");
}

/** One-line form for a session held because its review was never acknowledged. */
export function buildUnconfirmedReviewReply(): string {
  return [
    "ยังบันทึกไม่ได้ ราคาที่ไม่ตรงกับรายการเบิกยังไม่ได้รับการยืนยัน",
    'กรุณากด "จบรายการ" อีกครั้งเพื่อดูรายการที่ต้องตรวจ',
  ].join("\n");
}
