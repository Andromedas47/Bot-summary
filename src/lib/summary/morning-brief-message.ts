/**
 * 🌅 สรุปประจำวัน — the LINE rendering for MorningBriefReport.
 *
 * Deliberately short: no per-product or per-issue itemization, ever — that is
 * what the on-demand detailed reports are for (see morning-brief.ts's header
 * comment). Financial numbers are read verbatim from
 * DailyFinancialSettlementResult; this module never computes expected cash,
 * actual cash, or a difference — see computeDailyFinancialSettlement
 * (src/lib/settlement/daily-financial-settlement.ts) for the one place that
 * arithmetic lives.
 */

import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";
import {
  capAtMaxMessages,
  chunkBlocks,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/line-chunking";
import type { MorningBriefFinancialEntry, MorningBriefReport } from "@/lib/summary/morning-brief";
import type { DailyFinancialSettlementResult } from "@/lib/settlement/daily-financial-settlement";

export const MORNING_BRIEF_TITLE = "🌅 สรุปประจำวัน";

/** This report has no web page of its own, so the notice names no destination. */
export const MORNING_BRIEF_OVERFLOW_NOTICE =
  "\n\nแสดงได้ไม่ครบ — ข้อความยาวเกินที่ LINE ตอบได้ในครั้งเดียว";

export const MORNING_BRIEF_NO_FINANCIAL_NOTICE = "ยังไม่พบข้อมูลปิดยอดของตลาดใดในวันนี้";

/**
 * ponytail: a small duplicate of daily-financial-settlement-message.ts's own
 * (unexported) `fmt`. That file belongs to Task 4 and is not to be touched
 * for a formatting convenience. If a THIRD caller ever needs this exact Thai
 * 2-decimal money format, export the original from Task 4's module instead
 * of adding a third copy — that is the upgrade path, not more duplication.
 */
function fmt(value: number): string {
  return value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildPurchaseCountsLine(report: MorningBriefReport): string {
  const { strong, surplus, reduce, unknown } = report.purchaseCounts;
  return `🟢 ${strong} • 🟠 ${surplus} • 🔴 ${reduce} • ⚠️ ${unknown}`;
}

/**
 * Status line only — the same three states Task 4's own formatter renders
 * (buildStatusLines in daily-financial-settlement-message.ts), reproduced
 * minimally here because that function is not exported. Reads only the
 * already-final `status`/`difference` fields; no arithmetic happens here.
 *
 * CRITICAL: INCOMPLETE must never render "เงินปิดตรง" — it renders the
 * waiting state instead.
 */
function buildFinancialStatusLine(result: DailyFinancialSettlementResult): string {
  if (result.status === "INCOMPLETE") return "⚠️ ยังปิดยอดไม่ได้";
  if (result.status === "CLOSED_MATCHED") return "✅ เงินปิดตรง";
  const difference = result.difference ?? 0;
  const label = difference < 0 ? "ขาด" : "เกิน";
  return `🚨 เงินปิดไม่ตรง / ${label} ${fmt(Math.abs(difference))} บาท`;
}

function buildFinancialBlock(
  entry: MorningBriefFinancialEntry,
  showMarketLabel: boolean,
): string {
  const { result } = entry;
  const lines: string[] = ["💰 ผลประกอบการ"];
  if (showMarketLabel) {
    lines.push(displayMarketName(entry.marketLabelNormalized, entry.marketLabelNormalized));
  }
  lines.push(
    `ยอดขายตามใบขาว ${result.whiteSheetSales === null ? "-" : `${fmt(result.whiteSheetSales)} บาท`}`,
    `เงินโอน ${fmt(result.transferTotal)} บาท`,
    `เงินสดที่ควรเหลือ ${result.expectedCash === null ? "-" : `${fmt(result.expectedCash)} บาท`}`,
    `เงินสดคงเหลือจริง ${result.actualCash === null ? "-" : `${fmt(result.actualCash)} บาท`}`,
    buildFinancialStatusLine(result),
  );
  return lines.join("\n");
}

function buildIssuesBlock(report: MorningBriefReport): string | null {
  const { critical, actionRequired } = report.issues;
  if (critical <= 0 && actionRequired <= 0) return null;
  const lines: string[] = [];
  if (critical > 0) lines.push(`🚨 ต้องตรวจด่วน ${critical} เรื่อง`);
  if (actionRequired > 0) lines.push(`⚠️ ต้องตรวจ ${actionRequired} เรื่อง`);
  return lines.join("\n");
}

/**
 * Block list, one entry per logical section — always small and bounded
 * regardless of how much is happening underneath, because every section is a
 * count or a handful of final numbers, never a list of items. This is what
 * keeps the brief concise even on the busiest day.
 */
export function buildMorningBriefBlocks(report: MorningBriefReport): string[] {
  const blocks: string[] = [
    [MORNING_BRIEF_TITLE, `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`].join("\n"),
    ["📦 แผนซื้อ", buildPurchaseCountsLine(report)].join("\n"),
  ];

  if (report.financial.length === 0) {
    blocks.push(["💰 ผลประกอบการ", MORNING_BRIEF_NO_FINANCIAL_NOTICE].join("\n"));
  } else {
    const showMarketLabel = report.financial.length > 1;
    for (const entry of report.financial) {
      blocks.push(buildFinancialBlock(entry, showMarketLabel));
    }
  }

  const issuesBlock = buildIssuesBlock(report);
  if (issuesBlock) blocks.push(issuesBlock);

  return blocks;
}

export function buildMorningBriefMessage(report: MorningBriefReport): string {
  return buildMorningBriefBlocks(report).join("\n\n");
}

/**
 * Splits into LINE-safe chunks using the same chunkBlocks convention every
 * other multi-message report in this codebase uses. In practice this report
 * is a handful of lines and should never need to split — kept anyway so a
 * pathological multi-market day degrades the same safe way every other
 * report does instead of silently overflowing LINE's limit.
 */
export function buildMorningBriefMessages(
  report: MorningBriefReport,
  options: { maxCodePoints?: number; maxMessages?: number } = {},
): string[] {
  const messages = chunkBlocks(
    buildMorningBriefBlocks(report),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
  return capAtMaxMessages(
    messages,
    options.maxMessages ?? LINE_REPLY_MAX_MESSAGES,
    MORNING_BRIEF_OVERFLOW_NOTICE,
  );
}
