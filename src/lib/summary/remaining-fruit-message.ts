import { formatThaiDate } from "@/lib/date";
import {
  buildRemainingFruitReport,
  displayRemainingUnit,
  formatQuantity,
  type RemainingFruitItem,
  type RemainingFruitReport,
  type RemainingFruitSourceRow,
} from "@/lib/summary/remaining-fruit";

const LINE_TEXT_LIMIT = 5000;
const TRUNCATION_NOTICE = "\n\n(ข้อความยาวเกินไป — ดูเพิ่มเติมในเว็บ)";

function formatQtyLine(quantity: number, unit: string): string {
  return `${formatQuantity(quantity)} ${displayRemainingUnit(unit)}`.trim();
}

function formatItemLines(item: RemainingFruitItem, index: number): string[] {
  const lines = [`${index}. ${item.fruitName}`];

  if (item.hasReturnGoodData) {
    lines.push(`เหลือขายต่อ: ${formatQtyLine(item.remainingForResaleQuantity, item.unit)}`);
  } else if (item.hasWithdrawnData || item.hasDamagedData) {
    lines.push("ยังไม่มีข้อมูลชั่งคืน");
  }

  if (item.hasWithdrawnData) {
    lines.push(`เบิกทั้งหมด: ${formatQtyLine(item.withdrawnQuantity, item.unit)}`);
  }

  if (item.hasDamagedData) {
    lines.push(`คืนเสีย: ${formatQtyLine(item.damagedQuantity, item.unit)}`);
  }

  return lines;
}

function appendOverallSection(lines: string[], report: RemainingFruitReport): void {
  lines.push("", "สรุปคงเหลือรวมทุกตลาด");
  for (const row of report.overall) {
    lines.push(
      "",
      row.fruitName,
      `เหลือขายต่อทั้งหมด: ${formatQtyLine(row.totalRemainingForResale, row.unit)}`,
    );
    for (const entry of row.marketBreakdown) {
      lines.push(`- ${entry.marketName}: ${formatQtyLine(entry.quantity, row.unit)}`);
    }
  }
}

function appendMarketSections(lines: string[], report: RemainingFruitReport): void {
  for (const section of report.markets) {
    lines.push("", section.marketName);
    section.items.forEach((item, i) => {
      lines.push("", ...formatItemLines(item, i + 1));
    });
  }
}

/** Truncate before maxLength, preferring a blank-line or line boundary. */
function truncateAtEntryBoundary(text: string, maxLength: number): string {
  let cut = text.slice(0, maxLength);
  const blankLine = cut.lastIndexOf("\n\n");
  if (blankLine > 0) {
    cut = cut.slice(0, blankLine);
  } else {
    const lastNewline = cut.lastIndexOf("\n");
    if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  }
  return cut.trimEnd();
}

function applyLineLimit(text: string): string {
  if (text.length <= LINE_TEXT_LIMIT) return text;

  const maxBodyLength = LINE_TEXT_LIMIT - TRUNCATION_NOTICE.length;
  const truncated = truncateAtEntryBoundary(text, maxBodyLength);
  return `${truncated}${TRUNCATION_NOTICE}`;
}

export function buildRemainingFruitMessage(
  date: string,
  report: RemainingFruitReport,
  options: { includeOverall?: boolean } = {},
): string {
  const includeOverall = options.includeOverall ?? report.markets.length !== 1;
  const lines: string[] = [`สรุปผลไม้คงเหลือ ${formatThaiDate(date)}`];

  if (report.markets.length === 0) {
    lines.push("", "ไม่พบข้อมูลสำหรับวันที่เลือก");
    return lines.join("\n");
  }

  const showOverall = includeOverall && report.overall.length > 0;
  if (showOverall) appendOverallSection(lines, report);
  appendMarketSections(lines, report);

  return applyLineLimit(lines.join("\n"));
}

export function buildRemainingFruitMessageFromRows(
  date: string,
  rows: RemainingFruitSourceRow[],
  options: {
    marketFilter?: string | null;
    includeOverall?: boolean;
  } = {},
): string {
  const report = buildRemainingFruitReport(rows, {
    marketFilter: options.marketFilter,
  });
  return buildRemainingFruitMessage(date, report, {
    includeOverall: options.includeOverall ?? !options.marketFilter,
  });
}
