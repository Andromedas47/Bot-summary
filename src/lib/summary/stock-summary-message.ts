import { formatThaiDate } from "@/lib/date";
import { formatQuantity } from "@/lib/summary/remaining-fruit";
import { STOCK_CATEGORY_EMOJI } from "@/lib/summary/stock-categories";
import type { StockCategoryGroup, StockSummary } from "@/lib/summary/stock-summary";
import {
  capAtMaxMessages,
  chunkBlocks,
  countCodePoints,
  LINE_MESSAGE_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";

export const STOCK_REPORT_TITLE = "📦 สรุปคงเหลือทุกตลาด";
export const STOCK_INCOMPLETE_HEADING = "⚠️ ข้อมูลชั่งคืนยังไม่ครบ";
export const STOCK_COMPLETE_NOTICE = "✅ ชั่งคืนครบทุกตลาด";
export const STOCK_UNIDENTIFIED_HEADING = "❔ ยังระบุตลาดไม่ได้";
export const STOCK_EMPTY_NOTICE = "ไม่พบข้อมูลสำหรับวันที่เลือก";

/**
 * A single block must stay comfortably under the LINE limit so the shared
 * splitter never has to break one apart mid-product.
 */
const MAX_BLOCK_CODE_POINTS = 3000;

/**
 * Executive-report unit label. The weight canonical unit is "โล"; the daily
 * purchasing report shows it as "กก." as requested by the business. The
 * per-market detail path keeps its own existing label (displayRemainingUnit).
 */
export function stockDisplayUnit(unit: string): string {
  if (unit === "โล") return "กก.";
  return unit || "—";
}

function productLine(productName: string, quantity: number, unit: string): string {
  return `${productName} — ${formatQuantity(quantity)} ${stockDisplayUnit(unit)}`.trimEnd();
}

/**
 * Pack a heading plus its lines into one or more blocks. The heading repeats on
 * every continuation block so a split section is still readable on its own.
 */
function packSection(heading: string, lines: string[]): string[] {
  if (lines.length === 0) return [];

  const blocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    blocks.push([heading, ...current].join("\n"));
    current = [];
  };

  for (const line of lines) {
    const candidate = [heading, ...current, line].join("\n");
    if (current.length > 0 && countCodePoints(candidate) > MAX_BLOCK_CODE_POINTS) {
      flush();
    }
    current.push(line);
  }

  flush();
  return blocks;
}

function categoryBlocks(group: StockCategoryGroup): string[] {
  const heading = `${STOCK_CATEGORY_EMOJI[group.category]} ${group.category}`;
  const lines = group.products.map((p) => productLine(p.productName, p.quantity, p.unit));
  return packSection(heading, lines);
}

/** One line per market, products comma-joined, so a busy day stays readable. */
function incompleteBlocks(summary: StockSummary): string[] {
  if (summary.incomplete.length === 0) return [];

  const byMarket = new Map<string, string[]>();
  for (const entry of summary.incomplete) {
    const products = byMarket.get(entry.marketName) ?? [];
    const label = `${entry.productName} (${stockDisplayUnit(entry.unit)})`;
    if (!products.includes(label)) products.push(label);
    byMarket.set(entry.marketName, products);
  }

  const lines = [...byMarket.entries()].map(
    ([marketName, products]) => `- ${marketName}: ${products.join(", ")}`,
  );
  return packSection(STOCK_INCOMPLETE_HEADING, lines);
}

function unidentifiedBlocks(summary: StockSummary): string[] {
  if (summary.unidentified.length === 0) return [];

  const lines: string[] = [];
  for (const group of summary.unidentified) {
    for (const product of group.products) {
      lines.push(productLine(product.productName, product.quantity, product.unit));
    }
  }
  return packSection(STOCK_UNIDENTIFIED_HEADING, lines);
}

/**
 * The compact executive block set: header, one section per category, the
 * unresolved-market carve-out, and the completeness verdict.
 *
 * Detailed per-market figures are intentionally NOT repeated here — they are
 * preserved by the existing detail blocks that follow in the manual reply and
 * by the dashboard.
 */
export function buildStockSummaryBlocks(summary: StockSummary): string[] {
  const header = `${STOCK_REPORT_TITLE}\nวันที่ ${formatThaiDate(summary.businessDate)}`;

  const body = [
    ...summary.categories.flatMap(categoryBlocks),
    ...unidentifiedBlocks(summary),
  ];

  if (body.length === 0 && summary.incomplete.length === 0) {
    return [`${header}\n\n${STOCK_EMPTY_NOTICE}`];
  }

  return [
    header,
    ...body,
    ...(summary.isComplete ? [STOCK_COMPLETE_NOTICE] : incompleteBlocks(summary)),
  ];
}

/** LINE-ready executive messages — used by the scheduled daily delivery. */
export function buildStockSummaryMessages(
  summary: StockSummary,
  options: { maxMessages?: number } = {},
): string[] {
  const messages = chunkBlocks(buildStockSummaryBlocks(summary), LINE_MESSAGE_MAX_CODE_POINTS);
  return capAtMaxMessages(messages, options.maxMessages);
}
