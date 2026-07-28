import {
  bangkokBusinessDateFromTimestamp,
  previousBangkokCalendarDateFromTimestamp,
  bangkokCalendarDateFromTimestamp,
} from "@/lib/business-date";
import { formatBusinessDateThai } from "@/lib/white-sheet/business-date-display";
import { bangkokTimeFromTimestamp } from "@/lib/parsers/weigh-session/parser";
import type { GuidedMenuDateMode } from "./types";
import { isValidIsoCalendarDate } from "./postback";

export interface ResolvedBusinessDate {
  iso: string;
  thai: string;
  mode: GuidedMenuDateMode;
}

/**
 * Resolve guided-menu date selection to ISO (command) + Thai BE (display).
 * Command values stay ISO; operators see Buddhist Era via th-TH formatting.
 */
export function resolveGuidedBusinessDate(
  mode: GuidedMenuDateMode,
  lineTimestampMs: number,
  customIso?: string | null,
): ResolvedBusinessDate | null {
  let iso: string | null = null;

  if (mode === "today") {
    // Calendar "today" for operator intent (not the 04:00 business cutoff).
    iso = bangkokCalendarDateFromTimestamp(lineTimestampMs);
  } else if (mode === "yesterday") {
    iso = previousBangkokCalendarDateFromTimestamp(lineTimestampMs);
  } else if (mode === "custom") {
    if (!customIso || !isValidIsoCalendarDate(customIso)) return null;
    iso = customIso;
  }

  if (!iso) return null;
  const thai = formatBusinessDateThai(iso);
  if (!thai) return null;
  return { iso, thai, mode };
}

export function resolveTransactionTime(lineTimestampMs: number): string {
  return bangkokTimeFromTimestamp(lineTimestampMs) ?? "00:00";
}

/** Preview helper — business-date cutoff aware "today" for reference panels. */
export function previewBusinessDateToday(nowMs = Date.now()): string {
  return bangkokBusinessDateFromTimestamp(nowMs) ?? bangkokCalendarDateFromTimestamp(nowMs) ?? "";
}

export { formatBusinessDateThai, isValidIsoCalendarDate };
