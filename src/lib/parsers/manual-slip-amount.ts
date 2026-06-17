// Parses amount lines from manual slip session messages.
// Supported formats:
//   "1. 100 บาท"   "1) 300"   "100 บาท"   "1,200 บาท"
//
// PREFIXED: numbered prefix (บาท optional)  e.g. "1. 100" "2) 300 บาท"
// SUFFIXED: amount + บาท (no prefix)         e.g. "100 บาท" "1,200 บาท"

const PREFIXED_RE = /^\d+[.)]\s*([\d,]+(?:\.\d+)?)\s*(?:บาท)?\s*$/;
const SUFFIXED_RE = /^([\d,]+(?:\.\d+)?)\s*บาท\s*$/;

export function parseManualSlipAmounts(text: string): Array<{ rawLine: string; amount: number }> {
  return text.split("\n").flatMap(raw => {
    const line = raw.trim();
    if (!line) return [];
    const m = SUFFIXED_RE.exec(line) ?? PREFIXED_RE.exec(line);
    if (!m) return [];
    const amount = parseFloat(m[1].replace(/,/g, ""));
    return amount > 0 ? [{ rawLine: line, amount }] : [];
  });
}
