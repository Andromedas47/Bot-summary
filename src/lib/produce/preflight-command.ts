/**
 * The `ตรวจความพร้อม [DD/MM/YYYY]` LINE command.
 *
 * Date handling is deliberately identical to the deployed `สรุปยอดขาย` command
 * (see src/lib/sales/command.ts): the shop types Buddhist years, a malformed
 * date fails the whole parse rather than silently answering about another day,
 * and LINE export-style "HH:MM ชื่อ " prefixes are stripped before matching.
 */

import { parseSalesSummaryCommand } from "@/lib/sales/command";

const PREFLIGHT_COMMAND = "ตรวจความพร้อม";
const LINE_EXPORT_PREFIX = /^\d{1,2}[:.]\d{2}\s+\S+\s+/;
const PREFLIGHT_CMD = new RegExp(`^${PREFLIGHT_COMMAND}(?:\\s+(.*))?$`);

export interface PreflightCommand {
  /** ISO business date, or null when the caller should use the default. */
  businessDate: string | null;
}

/**
 * Reuses the sales command's date grammar by rewriting the verb, so the two can
 * never accept different date formats — one parser, two command words.
 */
export function parsePreflightCommand(text: string): PreflightCommand | null {
  const match = PREFLIGHT_CMD.exec(text.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  return parseSalesSummaryCommand(`สรุปยอดขาย${rest ? ` ${rest}` : ""}`);
}

export function parsePreflightCommandFromMessage(text: string): PreflightCommand | null {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  for (const rawLine of text.split("\n")) {
    const stripped = rawLine.replace(LINE_EXPORT_PREFIX, "").trim();
    if (stripped !== rawLine.trim()) push(stripped);
    push(rawLine);
  }
  push(text);

  for (const candidate of candidates) {
    const command = parsePreflightCommand(candidate);
    if (command) return command;
  }
  return null;
}
