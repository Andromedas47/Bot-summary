import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";
import type { CategoryLedgerEntry } from "@/lib/summary/produce-category-totals";

export interface DailySummaryMessageRow {
  summary_date: string;
  staff_name: string;
  market_name: string;
  borrow_total: number;
  return_total: number;
  bad_return_total: number;
  net_sales: number;
  transaction_count: number;
}

function fmt(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Integer satang → "1,234.56". Split with integer division and remainder
 * rather than `satang / 100`, matching satangToBahtText in sales/calculate.ts.
 * A float divide is harmless at realistic baht amounts, but the whole point of
 * carrying satang as integers is that no money value takes a float detour on
 * its way to the screen.
 */
function fmtSatang(satang: number): string {
  const negative = satang < 0;
  const absolute = Math.abs(satang);
  const baht = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  const text = `${baht.toLocaleString("th-TH")}.${String(remainder).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/**
 * d/m/พ.ศ. — the compact date format the category-detail block uses. The
 * flat grand-total-only fallback keeps formatThaiDate's long form untouched.
 */
function shortThaiDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${day}/${month}/${(year ?? 0) + 543}`;
}

/**
 * Key shared with dailySummaryCategoryLedgers (daily-summary-cron.ts) so a
 * row's category detail is looked up with the exact same identity
 * DailySummaryService.recalculate groups its grand totals on: staff_name +
 * market_name as stored, never source_id, never a canonicalized market or
 * normalized seller label.
 */
export function dailySummaryCategoryLedgerKey(staffName: string, marketName: string): string {
  return `${staffName}||${marketName}`;
}

function rowTitle(row: DailySummaryMessageRow): string {
  const market = displayMarketName(row.market_name, "");
  return market ? `${row.staff_name} — ${market}` : row.staff_name;
}

/**
 * The original grand-total-only rendering, untouched. Every existing
 * caller/test relies on this being byte-identical, and the category-detail
 * path below falls back to it verbatim whenever detail doesn't fit.
 */
function buildFlatDailySummaryMessage(date: string, rows: DailySummaryMessageRow[]): string {
  const lines = [
    `สรุปยอดประจำวันที่ ${formatThaiDate(date)}`,
  ];

  for (const row of rows) {
    lines.push(
      "",
      rowTitle(row),
      `เบิกรวม: ${fmt(Number(row.borrow_total))} บาท`,
      `คืนรวม: ${fmt(Number(row.return_total))} บาท`,
      `คืนเสียรวม: ${fmt(Number(row.bad_return_total))} บาท`,
      `ยอดส่ง: ${fmt(Number(row.net_sales))} บาท`,
    );
  }

  return lines.join("\n");
}

const LEDGER_DIVIDER = "────────────";

/**
 * One seller/market row rendered with its category breakdown. The closing
 * "รวมทั้งหมด" section deliberately reads from the row's own
 * borrow/return/bad_return/net_sales fields — the same numbers the flat
 * rendering already shows and the same numbers daily_summaries stores — so
 * this block never becomes a second, independently-computed source of the
 * grand total; only the category lines above it are new.
 */
function buildCategoryRowBlock(
  date: string,
  row: DailySummaryMessageRow,
  entries: readonly CategoryLedgerEntry[],
): string {
  const lines = [
    `📊 สรุปยอด ${rowTitle(row)}`,
    shortThaiDate(date),
  ];

  for (const entry of entries) {
    lines.push(
      "",
      entry.heading,
      `เบิก ${fmtSatang(entry.withdrawnSatang)} บาท`,
      `ชั่งคืน ${fmtSatang(entry.goodReturnSatang)} บาท`,
      `คืนเสีย ${fmtSatang(entry.badReturnSatang)} บาท`,
      `ขาย ${fmtSatang(entry.netSatang)} บาท`,
    );
  }

  lines.push(
    "",
    LEDGER_DIVIDER,
    "💰 รวมทั้งหมด",
    "",
    `เบิก ${fmt(Number(row.borrow_total))} บาท`,
    `ชั่งคืน ${fmt(Number(row.return_total))} บาท`,
    `คืนเสีย ${fmt(Number(row.bad_return_total))} บาท`,
    "",
    `✅ ยอดขายสุทธิ ${fmt(Number(row.net_sales))} บาท`,
  );

  return lines.join("\n");
}

/**
 * `categoryLedgers` is optional per-row category detail — staff_name +
 * market_name (dailySummaryCategoryLedgerKey) → CategoryLedgerEntry[], as
 * produced by dailySummaryCategoryLedgers. Omitting it reproduces today's
 * grand-total-only message exactly, so every existing caller/test is
 * unaffected.
 *
 * When supplied, the detailed rendering is built first and used only if it
 * fits LINE_MESSAGE_MAX_CODE_POINTS; an oversized result falls back to the
 * exact grand-total-only message, byte-identical to today's output — the
 * same pattern buildWeighSessionSummary (reply.ts) already uses for the
 * per-document category summary. The cron delivers one push per LINE source
 * with no split and a retry key keyed only on (date, source), so category
 * detail must never be the reason a push stops fitting or a retry diverges.
 */
export function buildDailySummaryMessage(
  date: string,
  rows: DailySummaryMessageRow[],
  categoryLedgers?: ReadonlyMap<string, readonly CategoryLedgerEntry[]>,
): string {
  const flat = buildFlatDailySummaryMessage(date, rows);
  if (!categoryLedgers) return flat;

  const detailed = rows
    .map((row) => buildCategoryRowBlock(
      date,
      row,
      categoryLedgers.get(dailySummaryCategoryLedgerKey(row.staff_name, row.market_name)) ?? [],
    ))
    .join("\n\n");

  return countCodePoints(detailed) <= LINE_MESSAGE_MAX_CODE_POINTS ? detailed : flat;
}
