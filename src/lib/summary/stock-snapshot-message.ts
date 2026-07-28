import { formatThaiDate } from "@/lib/date";
import { formatQuantity } from "@/lib/summary/remaining-fruit";
import { STOCK_CATEGORY_EMOJI } from "@/lib/summary/stock-categories";
import type { StockCategoryGroup, StockProductTotal, StockSummary } from "@/lib/summary/stock-summary";
import {
  STOCK_COMPLETE_NOTICE,
  STOCK_UNIDENTIFIED_HEADING,
  stockDisplayUnit,
} from "@/lib/summary/stock-summary-message";
import { latestDataHintBlock, type LatestDataHint } from "@/lib/summary/latest-data-hint";
import { chunkBlocks, countCodePoints } from "@/lib/summary/line-chunking";

/**
 * The automatic 08:00 morning snapshot.
 *
 * WHAT IT IS: the sellable remaining stock of the previous business date,
 * combined across every market. A factual picture, nothing more. P'Krai and Je
 * read it and decide what to buy — the Bot does not decide, does not rank
 * urgency, does not recommend, and never hides a product.
 *
 * WHY PRODUCTS ARE GROUPED BY UNIT: quantities are only comparable inside one
 * unit. 3 ลูก against 3 กก. is a meaningless comparison, and sorting them into
 * one list would imply a ranking that does not exist. So each category is split
 * into unit groups first, and only inside a unit group are quantities sorted —
 * ascending, smallest first, purely as a reading aid.
 *
 * This is presentation only. Every number comes from the same StockSummary the
 * manual `สรุปคงเหลือ` command renders; no stock arithmetic happens here.
 */

export const STOCK_SNAPSHOT_TITLE = "📦 สต๊อกคงเหลือรวมทุกตลาด";

/**
 * Auto-snapshot incomplete heading. Wording differs from the manual
 * `สรุปคงเหลือ` heading (`STOCK_INCOMPLETE_HEADING`) — same incomplete list,
 * presentation only.
 */
export const STOCK_SNAPSHOT_INCOMPLETE_HEADING = "⚠️ พบรายการเบิกที่ไม่มีข้อมูลชั่งคืน";

/**
 * The empty state, and why it is worded this way.
 *
 * "ไม่พบข้อมูลสำหรับวันที่เลือก" under a "ข้อมูลจาก 0 ตลาด • พบคงเหลือ 0 ตลาด"
 * header read as a finished calculation that found zero stock. It was not: no
 * ชั่งคืน had been recorded for that date at all. These two lines say only what
 * is true — the requested date has nothing YET — and name the date again so the
 * following context block can never be mistaken for it.
 */
export const STOCK_SNAPSHOT_NO_DATA_PREFIX = "ยังไม่พบข้อมูลชั่งคืนประจำวันที่";
/** Nothing anywhere in history, so there is no earlier date to point at. */
export const STOCK_SNAPSHOT_NO_HISTORY_NOTICE = "ยังไม่พบข้อมูลชั่งคืนในระบบ";

/**
 * Readability caps, both far below the 4000 code-point LINE hard limit.
 *
 * A vegetable-heavy day is ~90 products; as one message that is a wall of text
 * nobody reads at 08:00. Splitting on category and unit-group boundaries keeps
 * each part scannable. Nothing is ever dropped to hit these numbers — the
 * report simply uses as many parts as the day needs.
 */
const SNAPSHOT_MESSAGE_MAX_CODE_POINTS = 1200;
const SNAPSHOT_BLOCK_MAX_CODE_POINTS = 1000;

interface UnitGroup {
  /** Display label ("กก.", "ลูก", "แพค", …). */
  unit: string;
  products: StockProductTotal[];
}

function productLine(product: StockProductTotal): string {
  return `${product.productName} — ${formatQuantity(product.quantity)} ${stockDisplayUnit(product.unit)}`.trimEnd();
}

/**
 * Split a category into unit groups.
 *
 * Groups are ordered by how many products they hold (the unit a category is
 * mostly sold in leads), then alphabetically so the order is stable day to day.
 * Inside a group, quantity ascending.
 */
function unitGroups(products: readonly StockProductTotal[]): UnitGroup[] {
  const byUnit = new Map<string, StockProductTotal[]>();

  for (const product of products) {
    const unit = stockDisplayUnit(product.unit);
    const group = byUnit.get(unit) ?? [];
    group.push(product);
    byUnit.set(unit, group);
  }

  return [...byUnit.entries()]
    .map(([unit, group]) => ({
      unit,
      products: [...group].sort(
        (a, b) => a.quantity - b.quantity || a.productName.localeCompare(b.productName, "th"),
      ),
    }))
    .sort(
      (a, b) => b.products.length - a.products.length || a.unit.localeCompare(b.unit, "th"),
    );
}

/** Pack a heading plus lines into blocks, repeating the heading on continuation. */
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
    if (current.length > 0 && countCodePoints(candidate) > SNAPSHOT_BLOCK_MAX_CODE_POINTS) {
      flush();
    }
    current.push(line);
  }

  flush();
  return blocks;
}

/**
 * One block per category when it fits, so the reader sees the whole category at
 * once. A category too large for a single block falls back to one block per
 * unit group, which repeats the category heading — the split then lands on a
 * boundary that still makes sense on its own.
 */
function sectionBlocks(heading: string, groups: UnitGroup[]): string[] {
  if (groups.length === 0) return [];

  const body = groups.map((group) => [group.unit, ...group.products.map(productLine)].join("\n"));
  const single = [heading, ...body].join("\n\n");
  if (countCodePoints(single) <= SNAPSHOT_BLOCK_MAX_CODE_POINTS) return [single];

  return groups.flatMap((group) =>
    packSection(`${heading}\n\n${group.unit}`, group.products.map(productLine)),
  );
}

function categoryBlocks(group: StockCategoryGroup): string[] {
  return sectionBlocks(
    `${STOCK_CATEGORY_EMOJI[group.category]} ${group.category}`,
    unitGroups(group.products),
  );
}

/**
 * Unresolved-market stock is still stock we are holding, so it is shown — in
 * its own section, exactly as the manual report does, never folded into the
 * all-market totals and never dropped.
 */
function unidentifiedBlocks(summary: StockSummary): string[] {
  const products = summary.unidentified.flatMap((group) => group.products);
  return sectionBlocks(STOCK_UNIDENTIFIED_HEADING, unitGroups(products));
}

export interface StockSnapshotMarketCoverage {
  /** Distinct markets represented in this business day's data. */
  total: number;
  /** Of those, the markets that contributed sellable remaining stock. */
  withStock: number;
}

/**
 * Both market numbers behind the header.
 *
 * They are reported separately because "10 ตลาด" alone is ambiguous: a market
 * can appear in the day's data and still contribute no sellable stock — most
 * often because its ชั่งคืน has not been recorded yet. Such a market is NOT a
 * zero-stock market, and collapsing the two numbers into one would quietly
 * claim it was. The ⚠️ warning stays separate and says how many are pending.
 *
 * Unresolved-market rows are excluded from both counts: they have no market
 * identity to count. Their stock is still shown in its own section.
 */
export function stockSnapshotMarketCoverage(summary: StockSummary): StockSnapshotMarketCoverage {
  const withStock = new Set<string>();
  for (const group of summary.categories) {
    for (const product of group.products) {
      for (const market of product.markets) withStock.add(market.marketName);
    }
  }

  return { total: summary.detail.markets.length, withStock: withStock.size };
}

/**
 * The morning warning is counts only. Which market owes which product is a
 * follow-up conversation, and the manual report already answers it in full.
 */
function incompleteBlocks(summary: StockSummary): string[] {
  if (summary.incomplete.length === 0) return [STOCK_COMPLETE_NOTICE];

  // Same meaning as before: รายการ = incomplete market+product+unit rows;
  // ตลาด = distinct markets among those rows. Counts unchanged; wording only.
  const markets = new Set(summary.incomplete.map((entry) => entry.marketName));
  return [
    `${STOCK_SNAPSHOT_INCOMPLETE_HEADING}\n${summary.incomplete.length} รายการ จาก ${markets.size} ตลาด`,
  ];
}

/**
 * True when the business date produced no eligible stock evidence at all — no
 * sellable remaining, no unresolved-market remaining, and nothing awaiting its
 * ชั่งคืน. A day with pending withdrawals is NOT empty: it has data, and the
 * report already says what is missing about it.
 */
export function isStockSnapshotEmpty(summary: StockSummary): boolean {
  return (
    summary.categories.length === 0
    && summary.unidentified.length === 0
    && summary.incomplete.length === 0
  );
}

export function buildStockSnapshotBlocks(
  summary: StockSummary,
  latest: LatestDataHint | null = null,
): string[] {
  const requestedDate = formatThaiDate(summary.businessDate);

  if (isStockSnapshotEmpty(summary)) {
    // The market-coverage line is deliberately absent: with no source data at
    // all, "ข้อมูลจาก 0 ตลาด" states a count that was never taken.
    return [
      [
        `${STOCK_SNAPSHOT_TITLE}\nข้อมูลวันที่ ${requestedDate}`,
        `${STOCK_SNAPSHOT_NO_DATA_PREFIX} ${requestedDate}`,
        latest ? latestDataHintBlock(latest) : STOCK_SNAPSHOT_NO_HISTORY_NOTICE,
      ].join("\n\n"),
    ];
  }

  const coverage = stockSnapshotMarketCoverage(summary);
  const header = [
    STOCK_SNAPSHOT_TITLE,
    `ข้อมูลวันที่ ${requestedDate}`,
    `ข้อมูลจาก ${coverage.total} ตลาด • พบคงเหลือ ${coverage.withStock} ตลาด`,
  ].join("\n");

  const body = [...summary.categories.flatMap(categoryBlocks), ...unidentifiedBlocks(summary)];

  return [header, ...body, ...incompleteBlocks(summary)];
}

/**
 * LINE-ready parts for the scheduled delivery.
 *
 * Deliberately NOT capped at LINE_REPLY_MAX_MESSAGES: that cap truncates, and
 * losing stock to fit a message budget would defeat the whole report. These are
 * pushes, not a reply, so the day gets as many parts as it needs.
 */
export function buildStockSnapshotMessages(
  summary: StockSummary,
  options: { maxCodePoints?: number; latest?: LatestDataHint | null } = {},
): string[] {
  return chunkBlocks(
    buildStockSnapshotBlocks(summary, options.latest ?? null),
    options.maxCodePoints ?? SNAPSHOT_MESSAGE_MAX_CODE_POINTS,
  );
}
