const DATE_RE = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:25)?\d{2}\b/g;
const TX_RE = /(เบิกเพิ่ม|คืนเสีย|เบิก|คืน)/;

export function cleanMarketName(value: string | null | undefined): string | null {
  if (!value) return null;

  let market = value
    .replace(/\r?\n/g, " ")
    .replace(DATE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

  const dashIndex = market.indexOf("-");
  if (dashIndex >= 0) {
    market = market.slice(dashIndex + 1).trim();
  }

  market = market
    .split(TX_RE)[0]
    .replace(/^รายการชั่ง/, "")
    .replace(/^รายการ/, "")
    .replace(/^ไป/, "")
    .trim();

  return market || null;
}

export function displayMarketName(value: string | null | undefined, fallback = "—"): string {
  return cleanMarketName(value) ?? fallback;
}
