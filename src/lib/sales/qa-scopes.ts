/**
 * QA/test market scopes excluded from production Sales reporting.
 *
 * These are real rows in Production, created while testing the White Sheet and
 * central-price flows. They are never deleted or repaired — the data stays
 * stored and auditable — but they must not appear in a report the business
 * reads as sales.
 *
 * EXACT MATCH ONLY, against the same normalized market label P1 already uses
 * for market identity. No substring, no regex, no "contains ทดสอบ": a real
 * market whose name happens to share a word with a QA scope must keep counting.
 * Adding a scope here is a deliberate, reviewable act.
 */
const QA_MARKET_LABELS: ReadonlySet<string> = new Set([
  "ทดสอบ",
  "ทดสอบเงินโอน",
  "ทดสอบผลต่าง",
  "ทดสอบราคาA",
  "ทดสอบราคาB",
  "ทดสอบไวท์ชีท",
  "QAไวท์ชีท",
]);

/** True when this normalized market label is a known QA/test scope. */
export function isQaMarketLabel(marketLabel: string | null | undefined): boolean {
  if (!marketLabel) return false;
  return QA_MARKET_LABELS.has(marketLabel.normalize("NFC").trim());
}

/** The excluded labels, for reporting what a run left out. */
export function qaMarketLabels(): string[] {
  return [...QA_MARKET_LABELS];
}
