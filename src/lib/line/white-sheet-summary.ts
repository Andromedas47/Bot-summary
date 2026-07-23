import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";
import {
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/remaining-fruit-message";
import type { DigitalWhiteSheetViewModel, WhiteSheetStatus } from "@/components/white-sheet/types";

function fmt(amount: number): string {
  return amount.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const STATUS_DIFFERENCE_LABELS: Record<WhiteSheetStatus, string> = {
  shortage: "เงินขาด",
  matched: "ยอดตรง",
  overage: "เงินเกิน",
};

function formatDifferenceLine(status: WhiteSheetStatus, difference: number): string {
  const label = STATUS_DIFFERENCE_LABELS[status];
  return `ผลต่าง: ${label} ${fmt(Math.abs(difference))} บาท`;
}

function buildExpenseSection(viewModel: DigitalWhiteSheetViewModel): string[] {
  const { expenses } = viewModel;
  const lines = [
    "ค่าใช้จ่าย",
    `- ค่าแรง: ${fmt(expenses.labor)} บาท`,
    `- ค่าที่: ${fmt(expenses.locationFee)} บาท`,
    `- ค่าถุง: ${fmt(expenses.bag)} บาท`,
    `- ค่าขนม: ${fmt(expenses.snack)} บาท`,
    `- ค่าใช้จ่ายอื่น: ${fmt(expenses.other)} บาท`,
  ];

  if (expenses.otherNote?.trim()) {
    lines.push(`  (${expenses.otherNote.trim()})`);
  }

  lines.push(`รวมค่าใช้จ่าย: ${fmt(viewModel.expenseTotal)} บาท`);
  return lines;
}

export function buildWhiteSheetSummaryMessage(viewModel: DigitalWhiteSheetViewModel): string {
  const market = displayMarketName(viewModel.marketLabel, viewModel.marketLabel);

  const lines = [
    `สรุปปิดยอด ${market}`,
    `วันที่ ${formatThaiDate(viewModel.businessDate)}`,
    "",
    `ยอดขายที่ควรได้: ${fmt(viewModel.expectedSales)} บาท`,
    `เงินโอนที่ตรวจแล้ว: ${fmt(viewModel.verifiedTransfers)} บาท`,
    "",
    ...buildExpenseSection(viewModel),
    "",
    `เงินสดที่ควรส่ง: ${fmt(viewModel.expectedCash)} บาท`,
    `เงินสดส่งจริง: ${fmt(viewModel.actualCashSubmitted)} บาท`,
    "",
    formatDifferenceLine(viewModel.status, viewModel.difference),
  ];

  if (viewModel.warnings.length > 0) {
    lines.push("", "— คำเตือน —", ...viewModel.warnings);
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
  viewModel: DigitalWhiteSheetViewModel,
): string[] {
  const full = buildWhiteSheetSummaryMessage(viewModel);
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

export { LINE_MESSAGE_MAX_CODE_POINTS, LINE_REPLY_MAX_MESSAGES, countCodePoints };
