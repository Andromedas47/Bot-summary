const DATE_RE = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:25)?\d{2}\b/g;
const LONG_DATE_RE = /วันที่\s+\d{1,2}\s+[\u0E00-\u0E7F]+\s+(?:25)?\d{2}/g;
const TALAD_RE = /ตลาด[\u0E00-\u0E7Fa-zA-Z0-9]+/;

const BARE_TX_FRAGMENTS = new Set([
  "\u0E40\u0E1A\u0E34\u0E01",
  "\u0E04\u0E37\u0E19",
  "\u0E0A\u0E31\u0E48\u0E07",
  "\u0E0A\u0E48\u0E32\u0E07",
  "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23",
  "\u0E40\u0E1A\u0E34\u0E01\u0E1C\u0E31\u0E01",
  "\u0E04\u0E37\u0E19\u0E1C\u0E31\u0E01",
  "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E40\u0E1A\u0E34\u0E01\u0E1C\u0E31\u0E01",
  "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01",
  "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07",
  "\u0E44\u0E1B",
]);

function stripDates(value: string): string {
  return value
    .replace(DATE_RE, " ")
    .replace(LONG_DATE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTaladMarket(value: string): string | null {
  const match = value.match(TALAD_RE);
  return match?.[0] ?? null;
}

function stripTransactionTokens(value: string): string {
  return value
    .replace(/\u0E40\u0E1A\u0E34\u0E01\u0E40\u0E1E\u0E34\u0E48\u0E21/g, " ")
    .replace(/\u0E04\u0E37\u0E19\u0E40\u0E2A\u0E35\u0E22/g, " ")
    .replace(/\u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19/g, " ")
    .replace(/\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07/g, " ")
    .replace(/\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23/g, " ")
    .replace(/\u0E40\u0E1A\u0E34\u0E01/g, " ")
    .replace(/\u0E04\u0E37\u0E19/g, " ")
    .replace(/^\u0E44\u0E1B\s*/, "")
    .replace(/\s*(?:\u0E0A\u0E31\u0E48\u0E07|\u0E0A\u0E48\u0E32\u0E07)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBareTransactionFragment(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (BARE_TX_FRAGMENTS.has(trimmed)) return true;
  if (/^(?:\u0E40\u0E1A\u0E34\u0E01|\u0E04\u0E37\u0E19|\u0E0A\u0E31\u0E48\u0E07|\u0E0A\u0E48\u0E32\u0E07)(?:\u0E1C\u0E31\u0E01)?$/.test(trimmed)) return true;
  if (/^\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23/.test(trimmed) && !TALAD_RE.test(trimmed)) return true;
  return false;
}

function isTransactionOnlyTitle(value: string): boolean {
  const stripped = stripDates(value.replace(/\r?\n/g, " "));
  if (!stripped) return true;
  if (TALAD_RE.test(stripped)) return false;
  if (/^\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23/.test(stripped)) return true;
  if (/^(?:\u0E40\u0E1A\u0E34\u0E01|\u0E04\u0E37\u0E19)(?:\u0E1C\u0E31\u0E01|\d|$)/.test(stripped)) return true;
  if (/^(?:\u0E0A\u0E31\u0E48\u0E07|\u0E0A\u0E48\u0E32\u0E07)\u0E04\u0E37\u0E19/.test(stripped)) return true;
  return false;
}

/**
 * Resolve a stored session title / market_name to a canonical market label.
 * Returns null when the source text does not identify a market.
 */
export function cleanMarketName(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isTransactionOnlyTitle(value)) return null;

  let market = stripDates(value.replace(/\r?\n/g, " "));

  const talad = extractTaladMarket(market);
  if (talad) return talad;

  const dashIndex = market.indexOf("-");
  if (dashIndex >= 0) {
    market = market.slice(dashIndex + 1).trim();
    const taladAfterDash = extractTaladMarket(market);
    if (taladAfterDash) return taladAfterDash;
  }

  const postTalad = market.match(
    /(?:\u0E44\u0E1B|\u0E40\u0E1A\u0E34\u0E01|\u0E04\u0E37\u0E19|\u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19)\s*(\u0E15\u0E25\u0E32\u0E14[\u0E00-\u0E7Fa-zA-Z0-9]+)/,
  );
  if (postTalad?.[1]) return postTalad[1];

  market = stripTransactionTokens(market);

  const taladAfterStrip = extractTaladMarket(market);
  if (taladAfterStrip) return taladAfterStrip;

  if (isBareTransactionFragment(market)) return null;
  return market || null;
}

export function isIdentifiedMarket(value: string | null | undefined): boolean {
  return cleanMarketName(value) !== null;
}

export function displayMarketName(value: string | null | undefined, fallback = "—"): string {
  return cleanMarketName(value) ?? fallback;
}

/**
 * Canonical market identity for White Sheet financial comparison.
 * Same boundary for produce rows and slip evidence market_label — never use
 * SQL trim/NFC alone as the trusted identity.
 */
export function normalizedMarketLabel(marketName: string | null | undefined): string {
  return displayMarketName(marketName, "").normalize("NFC").trim();
}
