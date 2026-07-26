import { createHash } from "node:crypto";
import { previousBangkokBusinessDate, isIsoDate } from "@/lib/summary/daily-stock-cron";

/**
 * P1 Daily Sales scheduling helpers.
 *
 * Deliberately separate from P0 Stock: the two reports go to their own
 * recipient lists and must be able to diverge without either one touching the
 * other. Only the pure date helpers are shared — the business date a scheduled
 * run reports is the same "previous Bangkok business date" rule P0 proved, and
 * duplicating that rule is how two schedulers end up reporting different days.
 */

/** Env var holding the comma-separated LINE target IDs for the daily Sales push. */
export const SALES_SUMMARY_TARGETS_ENV = "SALES_SUMMARY_LINE_TARGETS";

export { previousBangkokBusinessDate } from "@/lib/summary/daily-stock-cron";

/**
 * Report date for a cron invocation. An explicit ISO ?date= wins verbatim so
 * backfill and UAT are never shifted; with no parameter the scheduled semantics
 * apply — the previous Bangkok business date, the day that just closed.
 */
export function resolveSalesSummaryDate(dateParam: string | null, timestamp = Date.now()): string {
  if (dateParam && isIsoDate(dateParam)) return dateParam;
  return previousBangkokBusinessDate(timestamp);
}

/**
 * Deterministic X-Line-Retry-Key (UUID shape) per business date + target +
 * message part, so a repeated scheduler call re-derives the same keys and LINE
 * answers 409 instead of delivering the report twice. Same construction as
 * stockSummaryRetryKey — different namespace, so the two reports can never
 * collide on a key.
 */
export function salesSummaryRetryKey(
  businessDate: string,
  targetId: string,
  partIndex: number,
): string {
  const bytes = createHash("sha256")
    .update(`daily-sales-summary:${businessDate}:${targetId}:${partIndex}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID version bits (name-based)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Parse the configured LINE targets. Blank/duplicate entries are dropped. An
 * unset or empty variable yields [] — the route then does nothing, which is how
 * automatic delivery stays inactive until the business supplies real IDs.
 */
export function parseSalesSummaryTargets(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}
