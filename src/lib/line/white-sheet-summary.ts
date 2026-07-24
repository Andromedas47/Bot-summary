import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";
import {
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/remaining-fruit-message";
import type { DigitalWhiteSheetSummary, WhiteSheetStatus } from "@/lib/white-sheet";
import {
  requireTrustedWhiteSheetSummary,
  type DigitalWhiteSheetPageModel,
} from "@/lib/white-sheet/compose";

function fmt(amount: number): string {
  return amount.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatStatusLine(status: WhiteSheetStatus, difference: number): string {
  if (status === "matched") return "✅ ยอดตรง";
  if (status === "shortage") return `เงินขาด ${fmt(Math.abs(difference))} บาท`;
  return `เงินเกิน ${fmt(Math.abs(difference))} บาท`;
}

function buildExpenseSection(summary: DigitalWhiteSheetSummary): string[] {
  const { expenses } = summary;
  const lines = [
    "ค่าใช้จ่าย",
    `ค่าแรง ${fmt(expenses.labor)} บาท`,
    `ค่าที่ ${fmt(expenses.locationFee)} บาท`,
    `ค่าถุง ${fmt(expenses.bag)} บาท`,
    `ค่าขนม ${fmt(expenses.snack)} บาท`,
  ];

  if (expenses.otherNote?.trim()) {
    lines.push(`ค่าอื่น ${fmt(expenses.other)} บาท — ${expenses.otherNote.trim()}`);
  } else {
    lines.push(`ค่าอื่น ${fmt(expenses.other)} บาท`);
  }

  lines.push(`รวมค่าใช้จ่าย ${fmt(summary.expenseTotal)} บาท`);
  return lines;
}

export function buildWhiteSheetSummaryMessage(summary: DigitalWhiteSheetSummary): string {
  const market = displayMarketName(summary.marketLabel, summary.marketLabel);

  const lines = [
    `สรุปปิดยอด — ${market}`,
    formatThaiDate(summary.businessDate),
    "",
    `ยอดขายที่ควรได้ ${fmt(summary.expectedSales)} บาท`,
    `ยอดโอนที่ตรวจแล้ว ${fmt(summary.verifiedTransfers)} บาท`,
    "",
    ...buildExpenseSection(summary),
    "",
    `เงินสดที่ควรส่ง ${fmt(summary.expectedCash)} บาท`,
    `เงินสดที่ส่งจริง ${fmt(summary.actualCashSubmitted)} บาท`,
    "",
    formatStatusLine(summary.status, summary.difference),
  ];

  if (summary.warnings.length > 0) {
    lines.push("", "— คำเตือน —", ...summary.warnings);
  }

  return lines.join("\n");
}

function splitMessageAtNewline(text: string, maxCodePoints: number): [string, string] | null {
  const lines = text.split("\n");
  let current = "";

  for (let i = 0; i < lines.length; i++) {
    const candidate = current ? `${current}\n${lines[i]}` : lines[i];
    if (countCodePoints(candidate) > maxCodePoints) {
      if (!current) return null;
      return [current, lines.slice(i).join("\n")];
    }
    current = candidate;
  }

  return null;
}

export function buildWhiteSheetSummaryMessages(
  summary: DigitalWhiteSheetSummary,
): string[] {
  const full = buildWhiteSheetSummaryMessage(summary);
  if (countCodePoints(full) <= LINE_MESSAGE_MAX_CODE_POINTS) {
    return [full];
  }

  const messages: string[] = [];
  let remaining = full;

  while (remaining && messages.length < LINE_REPLY_MAX_MESSAGES) {
    if (countCodePoints(remaining) <= LINE_MESSAGE_MAX_CODE_POINTS) {
      messages.push(remaining);
      break;
    }

    const split = splitMessageAtNewline(remaining, LINE_MESSAGE_MAX_CODE_POINTS);
    if (!split) {
      messages.push(remaining.slice(0, LINE_MESSAGE_MAX_CODE_POINTS));
      remaining = remaining.slice(LINE_MESSAGE_MAX_CODE_POINTS);
      continue;
    }

    messages.push(split[0]);
    remaining = split[1];
  }

  if (remaining && messages.length >= LINE_REPLY_MAX_MESSAGES) {
    const last = messages[messages.length - 1];
    const notice = "\n\n(ข้อความยาวเกินไป — ดูรายละเอียดในหน้าเว็บ)";
    if (countCodePoints(last + notice) <= LINE_MESSAGE_MAX_CODE_POINTS) {
      messages[messages.length - 1] = last + notice;
    }
  }

  return messages.length > 0 ? messages : [full.slice(0, LINE_MESSAGE_MAX_CODE_POINTS)];
}

/**
 * HARD STOP reply after a successful closing persistence: inputs were saved,
 * but matched/shortage/overage must not be claimed.
 */
export function buildWhiteSheetHardStopReplyMessages(
  hardStopWarnings: readonly string[],
): string[] {
  const warningLines =
    hardStopWarnings.length > 0
      ? hardStopWarnings.map((w) => (w.startsWith("⚠️") ? w : `⚠️ ${w}`))
      : ["⚠️ สรุปยอดยังไม่น่าเชื่อถือ กรุณาให้ผู้ดูแลตรวจสอบ"];

  const full = [
    "บันทึกข้อมูลปิดยอดแล้ว ✅",
    "",
    "แต่ยังไม่สามารถสรุปยอดตรง/ขาด/เกินได้",
    "เนื่องจาก:",
    ...warningLines,
    "",
    "กรุณาให้ผู้ดูแลตรวจสอบก่อน",
  ].join("\n");

  if (countCodePoints(full) <= LINE_MESSAGE_MAX_CODE_POINTS) {
    return [full];
  }

  const messages: string[] = [];
  let remaining = full;
  while (remaining && messages.length < LINE_REPLY_MAX_MESSAGES) {
    if (countCodePoints(remaining) <= LINE_MESSAGE_MAX_CODE_POINTS) {
      messages.push(remaining);
      break;
    }
    const split = splitMessageAtNewline(remaining, LINE_MESSAGE_MAX_CODE_POINTS);
    if (!split) {
      messages.push(remaining.slice(0, LINE_MESSAGE_MAX_CODE_POINTS));
      remaining = remaining.slice(LINE_MESSAGE_MAX_CODE_POINTS);
      continue;
    }
    messages.push(split[0]);
    remaining = split[1];
  }
  return messages.length > 0 ? messages : [full.slice(0, LINE_MESSAGE_MAX_CODE_POINTS)];
}

/**
 * Builds the White Sheet LINE messages directly from the composed page
 * model, guarded so it can never run against a not-yet-submitted entry or a
 * HARD STOP result — see requireTrustedWhiteSheetSummary.
 */
export function buildWhiteSheetSummaryMessagesFromPageModel(
  pageModel: DigitalWhiteSheetPageModel,
): string[] {
  const summary = requireTrustedWhiteSheetSummary(pageModel);
  return buildWhiteSheetSummaryMessages(summary);
}

export { LINE_MESSAGE_MAX_CODE_POINTS, LINE_REPLY_MAX_MESSAGES, countCodePoints };
