/**
 * P4A — operator-facing Thai text for the produce entry validation gate.
 *
 * Exceptions only. A round with fifty good lines and one bad one gets one
 * problem back, not fifty confirmations, and the list is capped so a pathological
 * session can never approach the LINE message limit.
 */

import { formatQuantity } from "@/lib/summary/remaining-fruit";
import {
  countCodePoints,
  LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";
import type {
  ProduceValidationAdvisory,
  ProduceValidationException,
  ProduceValidationResult,
} from "./entry-validation";

/** Beyond this the reply summarizes the remainder instead of listing it. */
const MAX_LISTED_EXCEPTIONS = 10;
const ADVISORY_SEPARATOR = "\n\n";
const PRICE_ADVISORY_SUMMARY_TRUNCATED_NOTICE = "…สรุปรายการถูกย่อเพื่อแสดงคำเตือนราคา";
const GENERIC_SUMMARY_TRUNCATED_NOTICE = "…สรุปรายการถูกย่อเนื่องจากข้อความยาวเกินกำหนด";

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

function numberedBlocks(
  exceptions: ProduceValidationException[],
  maxListed = MAX_LISTED_EXCEPTIONS,
): string[] {
  const listed = exceptions.slice(0, maxListed);
  const lines: string[] = [];
  listed.forEach((exception) => {
    const [head, ...rest] = describe(exception);
    const label = "itemNumber" in exception
      ? `ข้อ ${exception.itemNumber} — ${head}`
      : `• ${head}`;
    lines.push(label, ...rest);
  });
  const hidden = exceptions.length - listed.length;
  if (hidden > 0) lines.push(`และอีก ${hidden} รายการ`);
  return lines;
}

function correctionGuidance(exceptions: ProduceValidationException[]): string[] {
  const itemNumbers = [...new Set(
    exceptions.flatMap((exception) =>
      "itemNumber" in exception ? [exception.itemNumber] : []),
  )];
  if (itemNumbers.length === 1) {
    return [
      `ส่ง “แก้ข้อ ${itemNumbers[0]}”`,
      `แล้วส่งข้อ ${itemNumbers[0]} ที่ถูกต้องใหม่ พร้อมราคาและจำนวน`,
    ];
  }
  if (itemNumbers.length > 1) {
    return [
      `แก้ทีละข้อ: ${itemNumbers.map((number) => `“แก้ข้อ ${number}”`).join(", ")}`,
      "หลังแต่ละคำสั่ง ส่งรายการข้อนั้นใหม่พร้อมราคาและจำนวน",
    ];
  }
  return ["แก้เฉพาะรายการที่ทำให้ยอดเกิน แล้วปิดรายการอีกครั้ง"];
}

function renderPriceAdvisoryWarning(
  advisories: ProduceValidationAdvisory[],
  listedCount: number,
): string {
  const listed = advisories.slice(0, listedCount);
  const lines = [
    `⚠️ พบ ${advisories.length} รายการที่ราคาแตกต่างจากตอนเบิก`,
    ...listed.map((advisory) =>
      `• ${advisory.productName} — เบิก ${advisory.withdrawnPrices.map(formatPrice).join(", ")} บาท/${advisory.unit} → ชั่งคืน ${formatPrice(advisory.enteredPrice)} บาท/${advisory.unit}`
    ),
  ];
  const hidden = advisories.length - listed.length;
  if (hidden > 0) lines.push(`…และอีก ${hidden} รายการที่ราคาแตกต่าง`);
  lines.push("", "ระบบบันทึกตามราคาที่กรอกไว้แล้ว");
  return lines.join("\n");
}

/** Price differences are visible after save, never framed as a refusal. */
export function buildPriceAdvisoryWarning(
  advisories: ProduceValidationAdvisory[],
): string {
  if (advisories.length === 0) return "";
  return renderPriceAdvisoryWarning(
    advisories,
    Math.min(advisories.length, MAX_LISTED_EXCEPTIONS),
  );
}

function warningWithinBudget(
  advisories: ProduceValidationAdvisory[],
  maxCodePoints: number,
): string {
  for (
    let listed = Math.min(advisories.length, MAX_LISTED_EXCEPTIONS);
    listed >= 0;
    listed -= 1
  ) {
    const warning = renderPriceAdvisoryWarning(advisories, listed);
    if (countCodePoints(warning) <= maxCodePoints) return warning;
  }
  throw new Error("price advisory cannot fit within the LINE text limit");
}

function truncateSummary(
  summary: string,
  maxCodePoints: number,
  notice: string,
): string {
  if (countCodePoints(summary) <= maxCodePoints) return summary;
  const suffix = `\n${notice}`;
  const bodyBudget = maxCodePoints - countCodePoints(suffix);
  const prefix = [...summary].slice(0, Math.max(0, bodyBudget)).join("");
  const lineBoundary = prefix.lastIndexOf("\n");
  const body = (lineBoundary > 0 ? prefix.slice(0, lineBoundary) : prefix).trimEnd();
  return `${body}${suffix}`;
}

/** Build the one durable success notification without crossing LINE's hard limit. */
export function buildPriceAdvisoryNotification(
  summary: string,
  advisories: ProduceValidationAdvisory[],
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
): string {
  if (advisories.length === 0) {
    return truncateSummary(summary, maxCodePoints, GENERIC_SUMMARY_TRUNCATED_NOTICE);
  }

  const fullWarning = buildPriceAdvisoryWarning(advisories);
  const full = `${summary}${ADVISORY_SEPARATOR}${fullWarning}`;
  if (countCodePoints(full) <= maxCodePoints) return full;

  const compactWarning = renderPriceAdvisoryWarning(advisories, 0);
  const summaryBudget = maxCodePoints
    - countCodePoints(ADVISORY_SEPARATOR)
    - countCodePoints(compactWarning);
  const safeSummary = truncateSummary(
    summary,
    summaryBudget,
    PRICE_ADVISORY_SUMMARY_TRUNCATED_NOTICE,
  );
  const warningBudget = maxCodePoints
    - countCodePoints(safeSummary)
    - countCodePoints(ADVISORY_SEPARATOR);
  const warning = warningWithinBudget(advisories, warningBudget);
  return `${safeSummary}${ADVISORY_SEPARATOR}${warning}`;
}

/**
 * The round cannot finalize. Nothing was written and the round stays open, so
 * the operator can send the corrected line as an ordinary item message.
 */
export function buildBlockingValidationReply(result: ProduceValidationResult): string {
  return [
    `⛔ พบ ${result.blocking.length} รายการที่ต้องแก้ไขก่อนจบรายการ`,
    "",
    ...numberedBlocks(result.blocking),
    "",
    "รายการอื่นยังอยู่ครบ ไม่ต้องยกเลิก",
    ...correctionGuidance(result.blocking),
    'แล้วส่งข้อความ "จบรายการ" อีกครั้ง',
  ].join("\n");
}

function reviewHeadline(result: ProduceValidationResult): string {
  return `⚠️ พบ ${result.reviews.length} ชื่อสินค้าที่ต้องตรวจสอบ`;
}

function reviewCorrectionGuidance(result: ProduceValidationResult): string[] {
  const itemNumbers = [...new Set(result.reviews.map((review) => review.itemNumber))];
  if (itemNumbers.length === 1) {
    return [
      `ส่ง “แก้ข้อ ${itemNumbers[0]}”`,
      `แล้วส่งข้อ ${itemNumbers[0]} ใหม่ พร้อมราคาและจำนวน`,
    ];
  }
  return [
    "ส่งคำสั่ง “แก้ข้อ <เลขข้อ>” ทีละข้อ",
    "แล้วส่งข้อนั้นใหม่ พร้อมราคาและจำนวน",
  ];
}

function reviewActionBlock(
  result: ProduceValidationResult,
  confirmationInstruction: string,
): string[] {
  const subject = result.reviews.length === 1 ? "ชื่อนี้" : "ชื่อเหล่านี้";
  return [
    `✅ ถ้า${subject}ถูกต้องและต้องการบันทึกตามที่พิมพ์`,
    confirmationInstruction,
    "",
    "✏️ ถ้าต้องการแก้ชื่อ",
    ...reviewCorrectionGuidance(result),
    "",
    "รายการอื่นยังอยู่ครบ ไม่ต้องเริ่มใหม่",
  ];
}

function buildReviewReplyWithinBudget(
  result: ProduceValidationResult,
  confirmationInstruction: string,
  maxCodePoints: number,
): string {
  const actionBlock = reviewActionBlock(result, confirmationInstruction);
  for (
    let listed = Math.min(result.reviews.length, MAX_LISTED_EXCEPTIONS);
    listed >= 0;
    listed -= 1
  ) {
    const reply = [
      reviewHeadline(result),
      "",
      ...numberedBlocks(result.reviews, listed),
      "",
      ...actionBlock,
    ].join("\n");
    if (countCodePoints(reply) <= maxCodePoints) return reply;
  }
  throw new Error("product review actions cannot fit within the LINE text limit");
}

/**
 * A withdrawal product name outside the approved dictionary needs one human
 * confirmation before finalization.
 */
export function buildReviewValidationReply(
  result: ProduceValidationResult,
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
): string {
  return buildReviewReplyWithinBudget(
    result,
    'กด “ยืนยัน” เพื่อบันทึกและจบรายการ',
    maxCodePoints,
  );
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
  closeCommand: string,
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
): string {
  return buildReviewReplyWithinBudget(
    result,
    `ส่ง “${closeCommand.trim()}” อีกครั้ง`,
    maxCodePoints,
  );
}

/** One-line form for a session held because its review was never acknowledged. */
export function buildUnconfirmedReviewReply(result?: ProduceValidationResult): string {
  const subject = result?.reviews.length
    ? "ชื่อสินค้าที่ไม่ตรงกับรายการมาตรฐาน"
    : "รายการที่ต้องตรวจสอบ";
  return [
    `ยังบันทึกไม่ได้ ${subject}ยังไม่ได้รับการยืนยัน`,
    'กรุณากด "จบรายการ" อีกครั้งเพื่อดูรายการที่ต้องตรวจ',
  ].join("\n");
}
