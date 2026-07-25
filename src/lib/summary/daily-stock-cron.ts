import { createHash } from "node:crypto";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";

/** Env var holding the comma-separated LINE target IDs for the daily Stock push. */
export const STOCK_SUMMARY_TARGETS_ENV = "STOCK_SUMMARY_LINE_TARGETS";

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Business date for a scheduled run.
 *
 * Uses the Bangkok 04:00 business-day cutoff, so a run at 01:30 Bangkok still
 * reports the day that is closing rather than the calendar day that just
 * started. An explicit ISO ?date= always wins (used for backfill and UAT).
 */
export function resolveStockSummaryDate(dateParam: string | null, timestamp = Date.now()): string {
  if (dateParam && isIsoDate(dateParam)) return dateParam;
  return (
    bangkokBusinessDateFromTimestamp(timestamp) ?? new Date(timestamp).toISOString().slice(0, 10)
  );
}

/**
 * Deterministic X-Line-Retry-Key (UUID shape) per business date + target +
 * message part. A repeated scheduler call re-derives the exact same keys, so
 * LINE answers 409 for anything already delivered instead of re-sending it.
 * Same construction as dailySummaryRetryKey — different namespace.
 */
export function stockSummaryRetryKey(
  businessDate: string,
  targetId: string,
  partIndex: number,
): string {
  const bytes = createHash("sha256")
    .update(`daily-stock-summary:${businessDate}:${targetId}:${partIndex}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID version bits (name-based)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Parse the configured LINE targets. Blank/duplicate entries are dropped.
 * An unset or empty variable yields [] — the route then does nothing, which is
 * how automatic delivery stays inactive until the business supplies real IDs.
 */
export function parseStockSummaryTargets(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}
