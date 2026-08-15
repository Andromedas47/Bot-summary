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
    case "unknown_product_vocabulary":
      return [
        `${exception.productName}`,
        ...(exception.suggestions.length > 0
          ? [
              "   ชื่อใกล้เคียง:",
              ...exception.suggestions.map(
                (candidate) => `   • ${candidate.productCode} — ${candidate.canonicalName}`,
              ),
            ]
          : ["   ไม่พบชื่อใกล้เคียงในรายการมาตรฐาน"]),
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
 * The review set carries two unrelated problems — a price that differs from
 * the withdrawal, and a withdrawal product name that is not an approved
 * dictionary spelling — so the wording is composed from whichever are present
 * rather than assuming the price case.
 */
function reviewComposition(result: ProduceValidationResult): {
  vocabulary: number;
  price: number;
} {
  const vocabulary = result.reviews.filter(
    (exception) => exception.kind === "unknown_product_vocabulary",
  ).length;
  return { vocabulary, price: result.reviews.length - vocabulary };
}

function reviewHeadline(result: ProduceValidationResult): string {
  const { vocabulary, price } = reviewComposition(result);
  if (vocabulary === 0) return `⚠️ พบ ${price} รายการที่ราคาไม่ตรงกับรายการเบิก`;
  if (price === 0) return `⚠️ พบ ${vocabulary} ชื่อสินค้าที่ไม่ตรงกับรายการมาตรฐาน`;
  return `⚠️ พบ ${result.reviews.length} รายการที่ต้องตรวจสอบก่อนบันทึก`;
}

/**
 * What the operator is being asked to weigh up. Nothing is rewritten either
 * way: an unapproved name is persisted exactly as typed once it is confirmed,
 * and a suggestion is never applied on the operator's behalf.
 */
function reviewGuidance(result: ProduceValidationResult): string[] {
  const { vocabulary, price } = reviewComposition(result);
  const lines: string[] = [];
  if (vocabulary > 0) {
    lines.push(
      "หากพิมพ์ผิด กรุณาแก้ชื่อสินค้าแล้วส่งรายการที่ถูกต้องใหม่",
      "หากเป็นสินค้าใหม่จริง ระบบจะบันทึกชื่อตามที่ส่งมาทุกตัวอักษร",
    );
  }
  if (price > 0) {
    lines.push("ราคาเปลี่ยนระหว่างวันได้ ระบบจะเก็บราคาที่ส่งมาไว้ตามเดิม");
  }
  return lines;
}

function reviewConfirmPrompt(result: ProduceValidationResult, action: string): string {
  const { vocabulary, price } = reviewComposition(result);
  if (vocabulary === 0) return `กรุณาตรวจว่าปรับราคาจริง แล้ว${action}`;
  if (price === 0) return `หากตรวจแล้วว่าถูกต้อง ${action}`;
  return `กรุณาตรวจรายการข้างต้น แล้ว${action}`;
}

/**
 * The round can finalize, but something in it needs a human to look once: a
 * price that differs from what was withdrawn, or a withdrawal product name
 * that is not an approved dictionary spelling. Both are kept exactly as
 * entered — the operator only has to say they are intentional.
 */
export function buildReviewValidationReply(result: ProduceValidationResult): string {
  return [
    reviewHeadline(result),
    "",
    ...numberedBlocks(result.reviews),
    "",
    ...reviewGuidance(result),
    reviewConfirmPrompt(result, 'กด "ยืนยัน" เพื่อบันทึก'),
  ].join("\n");
}

/**
 * Same content, plain-text acknowledgement.
 *
 * The plain-text flow has no ยืนยัน button; its second press is a second
 * "จบรายการ…" message, which carries a different LINE event id and so cannot be
 * satisfied by a duplicate delivery of the first one.
 */
export function buildPlainTextReviewValidationReply(
  result: ProduceValidationResult,
): string {
  return [
    reviewHeadline(result),
    "",
    ...numberedBlocks(result.reviews),
    "",
    ...reviewGuidance(result),
    reviewConfirmPrompt(result, "ส่งข้อความจบรายการอีกครั้งเพื่อยืนยัน"),
  ].join("\n");
}

/** One-line form for a session held because its review was never acknowledged. */
export function buildUnconfirmedReviewReply(result?: ProduceValidationResult): string {
  const { vocabulary, price } = result
    ? reviewComposition(result)
    : { vocabulary: 0, price: 1 };
  const subject =
    vocabulary === 0
      ? "ราคาที่ไม่ตรงกับรายการเบิก"
      : price === 0
        ? "ชื่อสินค้าที่ไม่ตรงกับรายการมาตรฐาน"
        : "รายการที่ต้องตรวจสอบ";
  return [
    `ยังบันทึกไม่ได้ ${subject}ยังไม่ได้รับการยืนยัน`,
    'กรุณากด "จบรายการ" อีกครั้งเพื่อดูรายการที่ต้องตรวจ',
  ].join("\n");
}
