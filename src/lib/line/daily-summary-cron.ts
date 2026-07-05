import { createHash } from "node:crypto";
import type { DailySummaryMessageRow } from "@/lib/line/daily-summary-message";
import { previousBangkokCalendarDateFromTimestamp } from "@/lib/business-date";

export interface DailySummaryTransactionRow {
  raw_message_id: string;
  staff_name: string;
  market_name: string | null;
  transaction_type: string;
  total_amount: number | null;
}

export interface DailySummarySourceRow {
  id: string;
  source_id: string;
  source_type: string;
}

export interface GroupedDailySummaryRow extends DailySummaryMessageRow {
  source_id: string;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function resolveDailySummaryDate(dateParam: string | null, timestamp = Date.now()): string {
  if (dateParam && isIsoDate(dateParam)) return dateParam;
  return previousBangkokCalendarDateFromTimestamp(timestamp)
    ?? new Date(timestamp - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Deterministic X-Line-Retry-Key (UUID format) per summary date + target.
// A cron retry after a partial failure reuses the same key, so LINE answers
// 409 for targets that already received the message instead of re-delivering.
export function dailySummaryRetryKey(summaryDate: string, sourceId: string): string {
  const bytes = createHash("sha256")
    .update(`daily-summary:${summaryDate}:${sourceId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID version bits (name-based)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function groupKey(sourceId: string, staffName: string, marketName: string): string {
  return `${sourceId}||${staffName}||${marketName}`;
}

function addAmount(row: GroupedDailySummaryRow, tx: DailySummaryTransactionRow): void {
  const amount = Number(tx.total_amount ?? 0);

  if (tx.transaction_type === "เบิก" || tx.transaction_type === "เบิกเพิ่ม") {
    row.borrow_total += amount;
  } else if (tx.transaction_type === "คืน") {
    row.return_total += amount;
  } else if (tx.transaction_type === "คืนเสีย" || tx.transaction_type === "เสีย") {
    row.bad_return_total += amount;
  }

  row.net_sales = row.borrow_total - row.return_total - row.bad_return_total;
  row.transaction_count += 1;
}

export function groupDailySummariesBySource(
  transactions: DailySummaryTransactionRow[],
  sources: DailySummarySourceRow[],
  summaryDate: string,
): Map<string, DailySummaryMessageRow[]> {
  const sourceByMessageId = new Map(
    sources
      .filter((row) => row.source_id && row.source_id !== "unknown")
      .map((row) => [row.id, row]),
  );

  const grouped = new Map<string, GroupedDailySummaryRow>();
  for (const tx of transactions) {
    const source = sourceByMessageId.get(tx.raw_message_id);
    if (!source) continue;

    const marketName = tx.market_name ?? "";
    const key = groupKey(source.source_id, tx.staff_name, marketName);
    const row = grouped.get(key) ?? {
      source_id: source.source_id,
      summary_date: summaryDate,
      staff_name: tx.staff_name,
      market_name: marketName,
      borrow_total: 0,
      return_total: 0,
      bad_return_total: 0,
      net_sales: 0,
      transaction_count: 0,
    };

    addAmount(row, tx);
    grouped.set(key, row);
  }

  const summariesBySource = new Map<string, DailySummaryMessageRow[]>();
  for (const row of grouped.values()) {
    const { source_id, ...summaryRow } = row;
    const rows = summariesBySource.get(source_id) ?? [];
    rows.push(summaryRow);
    summariesBySource.set(source_id, rows);
  }

  return summariesBySource;
}
