/**
 * The `สรุปสินค้าขายดี [DD/MM/YYYY]` LINE command.
 *
 * Date handling is deliberately identical to the deployed `สรุปยอดขาย` command
 * (src/lib/sales/command.ts) and to `ตรวจความพร้อม`: the shop types Buddhist
 * years, a malformed date fails the whole parse rather than silently answering
 * about another day, and LINE export-style "HH:MM ชื่อ " prefixes are stripped
 * before matching.
 */

import { parseSalesSummaryCommand } from "@/lib/sales/command";

const PURCHASE_PLANNING_COMMAND = "สรุปสินค้าขายดี";
const LINE_EXPORT_PREFIX = /^\d{1,2}[:.]\d{2}\s+\S+\s+/;
const PURCHASE_PLANNING_CMD = new RegExp(`^${PURCHASE_PLANNING_COMMAND}(?:\\s+(.*))?$`);

export interface PurchasePlanningCommand {
  /** ISO business date, or null when the caller should use the default. */
  businessDate: string | null;
}

/**
 * Reuses the sales command's date grammar by rewriting the verb, so the two can
 * never accept different date formats — one parser, several command words.
 */
export function parsePurchasePlanningCommand(text: string): PurchasePlanningCommand | null {
  const match = PURCHASE_PLANNING_CMD.exec(text.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  return parseSalesSummaryCommand(`สรุปยอดขาย${rest ? ` ${rest}` : ""}`);
}

export function parsePurchasePlanningCommandFromMessage(
  text: string,
): PurchasePlanningCommand | null {
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
    const command = parsePurchasePlanningCommand(candidate);
    if (command) return command;
  }
  return null;
}
