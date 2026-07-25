import { formatThaiDate } from "@/lib/date";
import {
  displayRemainingUnit,
  formatQuantity,
  REMAINING_STOCK_REPORT_TITLE,
  STOCK_CATEGORY_META,
  UNIDENTIFIED_MARKET_SECTION,
  type RemainingFruitItem,
  type RemainingFruitReport,
  type RemainingFruitSourceRow,
} from "@/lib/summary/remaining-fruit";
import { createDailyStockSummary } from "@/lib/summary/daily-stock-service";

export const LINE_MESSAGE_MAX_CODE_POINTS = 4000;
export const LINE_REPLY_MAX_MESSAGES = 5;
export const OVERFLOW_NOTICE = "\n\nรายการยังไม่ครบ — ดูรายละเอียดทั้งหมดในหน้าเว็บ";

/** Count Unicode code points (not UTF-16 code units). */
export function countCodePoints(text: string): number {
  return [...text].length;
}

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

function overallFruitBlock(row: RemainingFruitReport["overall"][number]): string {
  const lines = [
    row.fruitName,
    `เหลือขายต่อทั้งหมด: ${formatQtyLine(row.totalRemainingForResale, row.unit)}`,
  ];
  for (const entry of row.marketBreakdown) {
    lines.push(`- ${entry.marketName}: ${formatQtyLine(entry.quantity, row.unit)}`);
  }
  return lines.join("\n");
}

function buildCompactCategoryBlocks(report: RemainingFruitReport): string[] {
  const blocks: string[] = [];
  for (const section of report.categories) {
    const meta = STOCK_CATEGORY_META[section.category];
    blocks.push([
      `${meta.icon} ${meta.label}`,
      ...section.items.map((item) =>
        `${item.fruitName} — ${formatQtyLine(item.totalRemainingForResale, item.unit)}`),
    ].join("\n"));
  }
  return blocks;
}

function buildIncompleteBlocks(report: RemainingFruitReport): string[] {
  if (report.incomplete.length === 0) return [];

  const byMarket = new Map<string, string[]>();
  for (const item of report.incomplete) {
    const products = byMarket.get(item.marketName) ?? [];
    products.push(`${item.fruitName} (${displayRemainingUnit(item.unit)})`);
    byMarket.set(item.marketName, products);
  }

  return [[
    "⚠️ ข้อมูลชั่งคืนยังไม่ครบ",
    ...[...byMarket.entries()].map(([market, products]) =>
      `- ${market}: ${products.join(", ")}`),
  ].join("\n")];
}

function buildUnidentifiedOverallBlocks(report: RemainingFruitReport): string[] {
  if (!report.unidentified || report.unidentified.overall.length === 0) return [];
  return [
    UNIDENTIFIED_MARKET_SECTION,
    ...report.unidentified.overall.map(overallFruitBlock),
  ];
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

function joinBlocks(blocks: string[]): string {
  return blocks.join("\n\n");
}

/** Split only at blank-line boundaries within a single oversized block. */
function splitOversizedBlock(block: string, maxCodePoints: number): string[] {
  const parts = block.split("\n\n");
  if (parts.length > 1) return chunkBlocks(parts, maxCodePoints);

  const lines = block.split("\n");
  if (lines.length > 1) {
    const messages: string[] = [];
    let current = "";
    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (countCodePoints(candidate) <= maxCodePoints) {
        current = candidate;
        continue;
      }
      if (current) messages.push(current);
      if (countCodePoints(line) <= maxCodePoints) {
        current = line;
      } else {
        const codePoints = [...line];
        for (let index = 0; index < codePoints.length; index += maxCodePoints) {
          messages.push(codePoints.slice(index, index + maxCodePoints).join(""));
        }
        current = "";
      }
    }
    if (current) messages.push(current);
    return messages;
  }

  const codePoints = [...block];
  return Array.from(
    { length: Math.ceil(codePoints.length / maxCodePoints) },
    (_, index) =>
      codePoints.slice(index * maxCodePoints, (index + 1) * maxCodePoints).join(""),
  );
}

/**
 * Pack blocks into messages without splitting a block unless it alone exceeds the limit.
 */
export function chunkBlocks(blocks: string[], maxCodePoints: number): string[] {
  const messages: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      messages.push(joinBlocks(current));
      current = [];
    }
  };

  for (const block of blocks) {
    const candidate = current.length === 0 ? block : joinBlocks([...current, block]);

    if (countCodePoints(candidate) <= maxCodePoints) {
      current.push(block);
      continue;
    }

    flush();

    if (countCodePoints(block) <= maxCodePoints) {
      current = [block];
    } else {
      messages.push(...splitOversizedBlock(block, maxCodePoints));
    }
  }

  flush();
  return messages;
}

function capAtMaxMessages(messages: string[]): string[] {
  if (messages.length <= LINE_REPLY_MAX_MESSAGES) return messages;

  const kept = messages.slice(0, LINE_REPLY_MAX_MESSAGES - 1);
  const overflow = messages.slice(LINE_REPLY_MAX_MESSAGES - 1).join("\n\n");
  const maxBody = LINE_MESSAGE_MAX_CODE_POINTS - countCodePoints(OVERFLOW_NOTICE);
  const truncated = truncateAtSectionBoundary(overflow, maxBody);
  kept.push(`${truncated}${OVERFLOW_NOTICE}`);
  return kept;
}

function truncateAtSectionBoundary(text: string, maxCodePoints: number): string {
  if (countCodePoints(text) <= maxCodePoints) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = text.slice(0, mid);
    const boundary = slice.lastIndexOf("\n\n");
    const cut = boundary > 0 ? slice.slice(0, boundary) : slice;
    if (countCodePoints(cut) <= maxCodePoints) low = mid;
    else high = mid - 1;
  }

  const slice = text.slice(0, low);
  const boundary = slice.lastIndexOf("\n\n");
  if (boundary > 0) return slice.slice(0, boundary).trimEnd();
  const lineBoundary = slice.lastIndexOf("\n");
  if (lineBoundary > 0) return slice.slice(0, lineBoundary).trimEnd();
  return slice.trimEnd();
}

export function buildRemainingFruitMessages(
  date: string,
  report: RemainingFruitReport,
  options: { includeOverall?: boolean; includeDetails?: boolean } = {},
): string[] {
  const includeOverall = options.includeOverall ?? report.markets.length !== 1;
  const includeDetails = options.includeDetails ?? true;
  const reportTitle = includeOverall
    ? REMAINING_STOCK_REPORT_TITLE
    : `📦 สรุปคงเหลือ${report.markets[0] ? ` — ${report.markets[0].marketName}` : ""}`;
  const header = `${reportTitle}\nวันที่ ${formatThaiDate(date)}`;

  const hasIdentified = report.markets.length > 0 || report.overall.length > 0;
  const hasUnidentified = !!report.unidentified?.markets.length;
  if (!hasIdentified && !hasUnidentified) {
    return [`${header}\n\n\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E40\u0E25\u0E37\u0E2D\u0E01`];
  }

  const messages: string[] = [];
  const showOverall = includeOverall && (
    report.overall.length > 0 ||
    report.incomplete.length > 0 ||
    !!report.unidentified?.overall.length
  );

  if (showOverall) {
    const summaryBlocks = [
      header,
      ...buildCompactCategoryBlocks(report),
      ...buildUnidentifiedOverallBlocks(report),
      ...buildIncompleteBlocks(report),
    ];
    const summaryMessage = joinBlocks(summaryBlocks);
    if (countCodePoints(summaryMessage) <= LINE_MESSAGE_MAX_CODE_POINTS) {
      messages.push(summaryMessage);
    } else {
      messages.push(...chunkBlocks(summaryBlocks, LINE_MESSAGE_MAX_CODE_POINTS));
    }
    if (includeDetails) {
      messages.push(...chunkBlocks(buildAllDetailBlocks(report), LINE_MESSAGE_MAX_CODE_POINTS));
    }
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
    includeDetails?: boolean;
  } = {},
): string[] {
  const report = createDailyStockSummary(rows, {
    marketFilter: options.marketFilter,
  });
  return buildRemainingFruitMessages(date, report, {
    includeOverall: options.includeOverall ?? !options.marketFilter,
    includeDetails: options.includeDetails,
  });
}

/** @deprecated Use buildRemainingFruitMessages — joins all parts for tests/display only. */
export function buildRemainingFruitMessage(
  date: string,
  report: RemainingFruitReport,
  options: { includeOverall?: boolean; includeDetails?: boolean } = {},
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
    includeDetails?: boolean;
  } = {},
): string {
  return buildRemainingFruitMessagesFromRows(date, rows, options).join("\n\n");
}
