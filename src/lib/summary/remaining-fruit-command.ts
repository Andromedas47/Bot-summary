import { parseBuddhistDate } from "@/lib/parsers/weigh-session/parser";

const DATE_CAPTURE = "(\\d{1,2}\\/\\d{1,2}\\/(?:25)?\\d{2})";

const REMAINING_CMD = new RegExp(`^สรุปคงเหลือ(?:\\s+${DATE_CAPTURE})?\\s*$`);
const MARKET_REMAINING_CMD = new RegExp(`^(.+?)\\s+สรุปคงเหลือ(?:\\s+${DATE_CAPTURE})?\\s*$`);
/** Same prefix strip as webhook normalizeLine — keeps command parsing independent of webhook imports. */
const LINE_EXPORT_PREFIX = /^\d{1,2}[:.]\d{2}\s+\S+\s+/;

export interface RemainingFruitCommand {
  businessDate: string | null;
  marketFilter: string | null;
}

function parseDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/((?:25)?\d{2})$/);
  if (!parts) return null;

  const day = Number(parts[1]);
  const month = Number(parts[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  return parseBuddhistDate(parts[1], parts[2], parts[3]);
}

export function parseRemainingFruitCommand(text: string): RemainingFruitCommand | null {
  const trimmed = text.trim();

  const marketMatch = MARKET_REMAINING_CMD.exec(trimmed);
  if (marketMatch) {
    const marketFilter = marketMatch[1].trim();
    if (!marketFilter) return null;
    const businessDate = parseDate(marketMatch[2]);
    if (marketMatch[2] && !businessDate) return null;
    return { businessDate, marketFilter };
  }

  const match = REMAINING_CMD.exec(trimmed);
  if (!match) return null;

  const businessDate = parseDate(match[1]);
  if (match[1] && !businessDate) return null;
  return { businessDate, marketFilter: null };
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

/** Parses remaining-fruit commands from raw LINE text, including export-style prefixed lines. */
export function parseRemainingFruitCommandFromMessage(text: string): RemainingFruitCommand | null {
  for (const candidate of commandCandidates(text)) {
    const cmd = parseRemainingFruitCommand(candidate);
    if (cmd) return cmd;
  }
  return null;
}
