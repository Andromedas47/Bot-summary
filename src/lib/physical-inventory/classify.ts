/**
 * Physical Stock routing helpers.
 *
 * Close recognition is NEVER a global chat command. Callers must already know
 * a Physical Stock session is open before treating a line as close.
 */

import {
  PHYSICAL_INVENTORY_CLOSE_LINES,
  PHYSICAL_INVENTORY_HEADERS,
} from "./patterns";

function nfcTrim(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function isPhysicalInventoryHeaderLine(line: string): boolean {
  const n = nfcTrim(line);
  return (PHYSICAL_INVENTORY_HEADERS as readonly string[]).includes(n);
}

/**
 * Pattern match for known Physical Stock close strings.
 * Does NOT imply the message is a global bot command — use only with an open session.
 */
export function matchesPhysicalInventoryCloseLine(line: string): boolean {
  const n = nfcTrim(line);
  return (PHYSICAL_INVENTORY_CLOSE_LINES as readonly string[]).includes(n);
}

/**
 * Session-gated close check. Without `sessionOpen: true`, always false —
 * including bare "จบ" and the long close phrases.
 */
export function isPhysicalInventorySessionClose(
  line: string,
  opts: { sessionOpen: boolean },
): boolean {
  if (!opts.sessionOpen) return false;
  return matchesPhysicalInventoryCloseLine(line);
}

/**
 * Standalone routing intent for an inbound message (no open-session context).
 * Close-like text must NOT classify as a command here.
 */
export type PhysicalInventoryStandaloneIntent = "header" | "none";

export function classifyPhysicalInventoryStandaloneIntent(
  text: string,
): PhysicalInventoryStandaloneIntent {
  const lines = text
    .split(/\r?\n/)
    .map((l) => nfcTrim(l))
    .filter(Boolean);
  if (lines.some((l) => isPhysicalInventoryHeaderLine(l))) return "header";
  return "none";
}

/**
 * Session-gated item admission. Physical Stock observations are staff-numbered
 * product or quantity/unit lines, so every non-empty line starts with a number.
 * This deliberately stays narrower than "any chat while a session is open".
 */
export function isPhysicalInventoryItemMessage(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => nfcTrim(line))
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^-?\d/u.test(line));
}
