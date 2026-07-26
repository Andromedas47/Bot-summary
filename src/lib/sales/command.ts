import { parseBuddhistDate } from "@/lib/parsers/weigh-session/parser";

/**
 * P1 manual LINE command: `สรุปยอดขาย` with an optional date.
 *
 * Date handling matches the deployed commands (`สรุปคงเหลือ`): a Thai
 * Buddhist-era year is what the shop actually types. Accepted forms:
 *
 *   25/07/69    2-digit BE  → 2569 BE → 2026-07-25   (parseBuddhistDate rule)
 *   25/07/2569  4-digit BE  → 2026-07-25
 *   25/07/2026  4-digit CE  → 2026-07-25             (the DD/MM/YYYY in the spec)
 *
 * A 4-digit year is read as Buddhist when it is ≥ 2400, otherwise as Gregorian.
 * The two ranges cannot overlap in any realistic business date, so the rule is
 * deterministic and never guesses between them.
 *
 * A malformed date is NOT silently ignored: the command fails to parse, so the
 * bot never answers for a different day than the one that was asked about.
 */

const SALES_COMMAND = "สรุปยอดขาย";
const DATE_CAPTURE = "(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})";
const SALES_CMD = new RegExp(`^${SALES_COMMAND}(?:\\s+${DATE_CAPTURE})?\\s*$`);
/** Same prefix strip as webhook normalizeLine — keeps parsing independent of webhook imports. */
const LINE_EXPORT_PREFIX = /^\d{1,2}[:.]\d{2}\s+\S+\s+/;

const MIN_BUDDHIST_YEAR = 2400;

export interface SalesSummaryCommand {
  /** ISO business date, or null when the caller should use the default. */
  businessDate: string | null;
}

function parseCommandDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;

  const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!parts) return null;

  const day = Number(parts[1]);
  const month = Number(parts[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const rawYear = parts[3];
  const iso =
    rawYear.length === 4 && Number(rawYear) < MIN_BUDDHIST_YEAR
      ? `${rawYear}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`
      : parseBuddhistDate(parts[1], parts[2], rawYear);

  // Reject dates that do not exist (31/02) rather than letting Date roll over.
  const [year, isoMonth, isoDay] = iso.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(year, isoMonth - 1, isoDay));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== isoMonth - 1 ||
    roundTrip.getUTCDate() !== isoDay
  ) {
    return null;
  }

  return iso;
}

export function parseSalesSummaryCommand(text: string): SalesSummaryCommand | null {
  const match = SALES_CMD.exec(text.trim());
  if (!match) return null;

  const businessDate = parseCommandDate(match[1]);
  if (match[1] && !businessDate) return null;
  return { businessDate };
}

function commandCandidates(text: string): string[] {
  const strippedLines: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  const push = (bucket: string[], value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    bucket.push(trimmed);
  };

  for (const rawLine of text.split("\n")) {
    const stripped = rawLine.replace(LINE_EXPORT_PREFIX, "").trim();
    if (stripped !== rawLine.trim()) push(strippedLines, stripped);
    push(other, rawLine);
  }
  push(other, text);

  return [...strippedLines, ...other];
}

/** Parses the command from raw LINE text, including export-style prefixed lines. */
export function parseSalesSummaryCommandFromMessage(text: string): SalesSummaryCommand | null {
  for (const candidate of commandCandidates(text)) {
    const command = parseSalesSummaryCommand(candidate);
    if (command) return command;
  }
  return null;
}
