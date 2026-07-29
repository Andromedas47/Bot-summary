import {
  bangkokCalendarDateFromTimestamp,
  previousBangkokCalendarDateFromTimestamp,
} from "@/lib/business-date";
import type { MenuDateMode } from "./menu-state-types";

export type ResolvedGuidedMenuDate = {
  iso: string;
  /** Operator-facing DD/MM/BBBB (Buddhist Era). */
  thaiShort: string;
  mode: "today" | "yesterday";
};

/** Format YYYY-MM-DD → DD/MM/BBBB for confirmation copy. */
export function formatThaiDateShort(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    utcNoon.getUTCFullYear() !== year ||
    utcNoon.getUTCMonth() !== month - 1 ||
    utcNoon.getUTCDate() !== day
  ) {
    return null;
  }
  const be = year + 543;
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${be}`;
}

/**
 * Resolve today/yesterday from LINE event timestamp (Asia/Bangkok calendar).
 * Slice 2 does not accept free-form iso_date from postback.
 */
export function resolveGuidedMenuDate(
  mode: MenuDateMode,
  lineTimestampMs: number,
): ResolvedGuidedMenuDate | null {
  if (mode !== "today" && mode !== "yesterday") return null;

  const iso =
    mode === "today"
      ? bangkokCalendarDateFromTimestamp(lineTimestampMs)
      : previousBangkokCalendarDateFromTimestamp(lineTimestampMs);
  if (!iso) return null;

  const thaiShort = formatThaiDateShort(iso);
  if (!thaiShort) return null;

  return { iso, thaiShort, mode };
}
