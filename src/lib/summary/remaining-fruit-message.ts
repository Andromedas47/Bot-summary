import { formatThaiDate } from "@/lib/date";
import {
  buildRemainingFruitReport,
  displayRemainingUnit,
  formatQuantity,
  REMAINING_STOCK_REPORT_TITLE,
  type RemainingFruitItem,
  type RemainingFruitReport,
  type RemainingFruitSourceRow,
} from "@/lib/summary/remaining-fruit";
import { buildStockSummary } from "@/lib/summary/stock-summary";
import { buildStockSummaryBlocks } from "@/lib/summary/stock-summary-message";
import {
  capAtMaxMessages,
  chunkBlocks,
  countCodePoints,
  joinBlocks,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
  OVERFLOW_NOTICE,
} from "@/lib/summary/line-chunking";

// Re-exported so existing importers (and their tests) keep working after the
// chunking primitives moved into their own module.
export {
  capAtMaxMessages,
  chunkBlocks,
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
  OVERFLOW_NOTICE,
};

function formatQtyLine(quantity: number, unit: string): string {
  return `${formatQuantity(quantity)} ${displayRemainingUnit(unit)}`.trim();
}

function formatItemBlock(item: RemainingFruitItem, index: number): string {
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

  return lines.join("\n");
}

function buildMarketBlocks(sections: RemainingFruitReport["markets"]): string[] {
  const blocks: string[] = [];
  for (const section of sections) {
    blocks.push(section.marketName);
    section.items.forEach((item, i) => {
      blocks.push(formatItemBlock(item, i + 1));
    });
  }
  return blocks;
}

function buildAllDetailBlocks(report: RemainingFruitReport): string[] {
  return [
    ...buildMarketBlocks(report.markets),
    ...(report.unidentified ? buildMarketBlocks(report.unidentified.markets) : []),
  ];
}

export function buildRemainingFruitMessages(
  date: string,
  report: RemainingFruitReport,
  options: { includeOverall?: boolean } = {},
): string[] {
  const includeOverall = options.includeOverall ?? report.markets.length !== 1;
  const header = `${REMAINING_STOCK_REPORT_TITLE} ${formatThaiDate(date)}`;

  const hasIdentified = report.markets.length > 0 || report.overall.length > 0;
  const hasUnidentified = !!report.unidentified?.markets.length;
  if (!hasIdentified && !hasUnidentified) {
    return [`${header}\n\n\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E40\u0E25\u0E37\u0E2D\u0E01`];
  }

  const messages: string[] = [];
  const showOverall =
    includeOverall &&
    (report.overall.length > 0 ||
      !!report.unidentified?.overall.length ||
      report.markets.length > 0);

  if (showOverall) {
    // The all-market view leads with the shared StockSummary executive block
    // (categories + missing-return warnings) — the same model the scheduled
    // delivery uses — and keeps the per-market detail blocks below it.
    const summaryBlocks = buildStockSummaryBlocks(buildStockSummary(date, report));
    const summaryMessage = joinBlocks(summaryBlocks);
    if (countCodePoints(summaryMessage) <= LINE_MESSAGE_MAX_CODE_POINTS) {
      messages.push(summaryMessage);
    } else {
      messages.push(...chunkBlocks(summaryBlocks, LINE_MESSAGE_MAX_CODE_POINTS));
    }
    messages.push(...chunkBlocks(buildAllDetailBlocks(report), LINE_MESSAGE_MAX_CODE_POINTS));
    return capAtMaxMessages(messages);
  }

  messages.push(...chunkBlocks([header, ...buildAllDetailBlocks(report)], LINE_MESSAGE_MAX_CODE_POINTS));
  return capAtMaxMessages(messages);
}

export function buildRemainingFruitMessagesFromRows(
  date: string,
  rows: RemainingFruitSourceRow[],
  options: {
    marketFilter?: string | null;
    includeOverall?: boolean;
  } = {},
): string[] {
  const report = buildRemainingFruitReport(rows, {
    marketFilter: options.marketFilter,
  });
  return buildRemainingFruitMessages(date, report, {
    includeOverall: options.includeOverall ?? !options.marketFilter,
  });
}

/** @deprecated Use buildRemainingFruitMessages — joins all parts for tests/display only. */
export function buildRemainingFruitMessage(
  date: string,
  report: RemainingFruitReport,
  options: { includeOverall?: boolean } = {},
): string {
  return buildRemainingFruitMessages(date, report, options).join("\n\n");
}

/** @deprecated Use buildRemainingFruitMessagesFromRows. */
export function buildRemainingFruitMessageFromRows(
  date: string,
  rows: RemainingFruitSourceRow[],
  options: {
    marketFilter?: string | null;
    includeOverall?: boolean;
  } = {},
): string {
  return buildRemainingFruitMessagesFromRows(date, rows, options).join("\n\n");
}
