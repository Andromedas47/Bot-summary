/**
 * Server-configured Guided Menu markets.
 * Labels resolve from trusted code → never from postback payload.
 */

export type GuidedMenuMarketOption = {
  code: string;
  label: string;
};

const SHORT_CODE_RE = /^[a-z0-9_]{1,32}$/;

/** Built-in defaults for local/test; override with GUIDED_MENU_MARKETS. */
export const DEFAULT_GUIDED_MENU_MARKETS: readonly GuidedMenuMarketOption[] = [
  { code: "kee", label: "ตลาดกี้" },
  { code: "seven_front", label: "หน้าเซเวน" },
  { code: "wat_taklam", label: "วัดตะกล่ำ" },
] as const;

/**
 * Parse `code:label,code:label` env form.
 * Invalid segments are dropped (never invent labels from postback).
 */
export function parseGuidedMenuMarketsEnv(
  raw: string | undefined | null,
): GuidedMenuMarketOption[] {
  const text = (raw ?? "").trim();
  if (!text) return [...DEFAULT_GUIDED_MENU_MARKETS];

  const out: GuidedMenuMarketOption[] = [];
  for (const segment of text.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const code = trimmed.slice(0, colon).trim();
    const label = trimmed.slice(colon + 1).trim();
    if (!SHORT_CODE_RE.test(code) || !label || label.length > 40) continue;
    out.push({ code, label });
  }
  return out.length > 0 ? out : [...DEFAULT_GUIDED_MENU_MARKETS];
}

export function loadGuidedMenuMarkets(
  env: NodeJS.ProcessEnv = process.env,
): GuidedMenuMarketOption[] {
  return parseGuidedMenuMarketsEnv(env.GUIDED_MENU_MARKETS);
}

export function findGuidedMenuMarket(
  markets: readonly GuidedMenuMarketOption[],
  code: string,
): GuidedMenuMarketOption | null {
  const needle = code.trim();
  return markets.find((m) => m.code === needle) ?? null;
}
