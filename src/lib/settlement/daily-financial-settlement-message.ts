/**
 * Task 4 report formatter — renders getDailyFinancialSettlement's result as
 * the Thai LINE message. No calculation happens here; every number is
 * already final from computeDailyFinancialSettlement.
 */

import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";
import {
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/line-chunking";
import type { DailyFinancialSettlementResult } from "./daily-financial-settlement";

function fmt(value: number): string {
  return value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MISSING_INPUT_LABEL: Record<string, string> = {
  white_sheet_sales: "ยอดขายตามใบขาว",
  owner_cash: "เงินให้เจ้า",
  expenses: "ค่าใช้จ่าย",
  wages: "ค่าแรง",
  actual_cash: "เงินสดคงเหลือจริง",
};

function buildStatusLines(result: DailyFinancialSettlementResult): string[] {
  if (result.status === "INCOMPLETE") {
    const missingLabels = result.missingInputs
      .map((key) => MISSING_INPUT_LABEL[key] ?? key)
      .join(", ");
    return [
      "⚠️ ยังปิดยอดไม่ได้",
      `รอข้อมูล: ${missingLabels || "ไม่ทราบสาเหตุ"}`,
    ];
  }

  const difference = result.difference ?? 0;
  if (result.status === "CLOSED_MATCHED") {
    return ["✅ เงินปิดตรง"];
  }
  const label = difference < 0 ? "ขาด" : "เกิน";
  return [`🚨 เงินปิดไม่ตรง / ${label} ${fmt(Math.abs(difference))} บาท`];
}

export function buildDailyFinancialSettlementMessage(
  result: DailyFinancialSettlementResult,
): string {
  const market = displayMarketName(result.marketLabelNormalized, result.marketLabelNormalized);

  const lines = [
    "💰 สรุปผลประกอบการประจำวัน",
    market ? `${market} — ${formatThaiDate(result.businessDate)}` : formatThaiDate(result.businessDate),
    "",
    `ยอดขายตามใบขาว ${result.whiteSheetSales === null ? "-" : `${fmt(result.whiteSheetSales)} บาท`}`,
    `เงินโอน ${fmt(result.transferTotal)} บาท`,
    `เงินให้เจ้า ${result.ownerCash === null ? "-" : `${fmt(result.ownerCash)} บาท`}`,
    `ค่าใช้จ่าย ${result.expensesTotal === null ? "-" : `${fmt(result.expensesTotal)} บาท`}`,
    `ค่าแรง ${result.wagesTotal === null ? "-" : `${fmt(result.wagesTotal)} บาท`}`,
    `เงินสดที่ควรเหลือ ${result.expectedCash === null ? "-" : `${fmt(result.expectedCash)} บาท`}`,
    `เงินสดคงเหลือจริง ${result.actualCash === null ? "-" : `${fmt(result.actualCash)} บาท`}`,
    "",
    ...buildStatusLines(result),
  ];

  if (result.uncertainty.length > 0) {
    lines.push("", "— หมายเหตุความไม่แน่นอน —", ...result.uncertainty);
  }

  if (result.produceCrossCheck) {
    lines.push(
      "",
      "— ข้อมูลอ้างอิงจากรายการชั่ง (ไม่ใช่ยอดขายจริง) —",
      `ยอดขายโดยประมาณจากรายการชั่ง ${fmt(result.produceCrossCheck.expectedSales)} บาท`,
      ...result.produceCrossCheck.warnings,
    );
  }

  return lines.join("\n");
}

/** Splits at the latest newline boundary that keeps each half under the limit. */
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

/**
 * Splits into LINE-safe chunks, same newline-boundary strategy as
 * buildWhiteSheetSummaryMessages — this report is short in practice (a
 * dozen lines), so this only ever matters when uncertainty/cross-check
 * sections grow unusually long.
 */
export function buildDailyFinancialSettlementMessages(
  result: DailyFinancialSettlementResult,
): string[] {
  const full = buildDailyFinancialSettlementMessage(result);
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
