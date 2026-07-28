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
 * The outcome of asking history a question — three states, never two.
 *
 * A nullable hint could not tell "history holds nothing" apart from "history
 * could not be read", and the report rendered both as "ยังไม่พบ…ในระบบ". That
 * is a claim about the data, and it is false whenever the lookup failed: an
 * outage would have told the business its records were empty.
 *
 *   found       — a real earlier date, with its market count
 *   none        — the query SUCCEEDED and history genuinely holds nothing
 *   unavailable — the question could not be answered; assert nothing
 *
 * "unavailable" also covers a partial answer: a date found whose market count
 * could not then be read is not a latest-date claim worth making, because the
 * count is half of what the reader is being told.
 */
export type LatestDataLookup =
  | { status: "found"; hint: LatestDataHint }
  | { status: "none" }
  | { status: "unavailable" };

/**
 * Said when history could not be consulted. Deliberately says nothing about
 * whether data exists — the one thing a failed lookup cannot know.
 */
export const LATEST_DATA_UNAVAILABLE_NOTICE = "ยังตรวจสอบข้อมูลล่าสุดไม่ได้";

/**
 * The closing block of an empty report: the latest date we have, an honest
 * "nothing in the system", or an honest "could not check".
 *
 * `noneNotice` is the report's own wording for a genuinely empty history —
 * ชั่งคืน and รายการขาย are different claims and must stay separate.
 */
export function latestDataBlock(lookup: LatestDataLookup, noneNotice: string): string {
  if (lookup.status === "found") return latestDataHintBlock(lookup.hint);
  if (lookup.status === "unavailable") return LATEST_DATA_UNAVAILABLE_NOTICE;
  return noneNotice;
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
