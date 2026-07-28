import { formatThaiDate } from "@/lib/date";

/**
 * The most recent business date BEFORE a requested one that actually holds
 * eligible data, plus how many markets contributed it.
 *
 * This is informational context for an EMPTY report and nothing else. It never
 * carries totals, and it is never rendered in place of the requested date — a
 * report that silently answered for another day would be worse than the silence
 * it replaces.
 *
 * Only the shape and the wording live here. Each report finds its own date
 * through its OWN eligibility rules (P0 Stock counts ชั่งคืน rows, P1 Sales
 * counts sales evidence), because those rules genuinely differ and forcing them
 * into one query is how two reports start disagreeing about what "data" means.
 */
export interface LatestDataHint {
  /** ISO business date, strictly before the requested one. */
  date: string;
  /** Distinct markets with eligible data on that date. */
  marketCount: number;
}

/**
 * The "here is the latest data we do have" block.
 *
 * It names its own date explicitly, so it can never be read as the requested
 * date's report. The market count is omitted when it is 0 — "พบข้อมูล 0 ตลาด"
 * reads as a completed count of nothing, which is the exact confusion this
 * whole change exists to remove.
 */
export function latestDataHintBlock(hint: LatestDataHint): string {
  const lines = [`ข้อมูลล่าสุดที่มีคือวันที่ ${formatThaiDate(hint.date)}`];
  if (hint.marketCount > 0) lines.push(`พบข้อมูล ${hint.marketCount} ตลาด`);
  return lines.join("\n");
}
