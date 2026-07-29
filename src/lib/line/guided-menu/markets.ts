/**
 * Server-configured Guided Menu markets.
 * Labels resolve from trusted code → never from postback payload.
 */

export type GuidedMenuMarketOption = {
  code: string;
  /** Operator-facing market name (confirm body, context lines). */
  label: string;
  /**
   * Explicit LINE button label when `label` exceeds the Flex button limit.
   * Never invented by silent clipping — must be configured.
   */
  buttonLabel?: string;
};

const SHORT_CODE_RE = /^[a-z0-9_]{1,32}$/;
const LABEL_MAX = 80;
const BUTTON_LABEL_MAX = 40;

/** Built-in defaults for local/test; override with GUIDED_MENU_MARKETS. */
export const DEFAULT_GUIDED_MENU_MARKETS: readonly GuidedMenuMarketOption[] = [
  { code: "kee", label: "ตลาดกี้" },
  { code: "seven_front", label: "หน้าเซเวน" },
  { code: "wat_taklam", label: "วัดตะกล่ำ" },
] as const;

/**
 * Parse env form: `code:label` or `code:label>buttonLabel`, comma-separated.
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
    const rest = trimmed.slice(colon + 1).trim();
    if (!SHORT_CODE_RE.test(code) || !rest) continue;

    const gt = rest.indexOf(">");
    let label: string;
    let buttonLabel: string | undefined;
    if (gt >= 0) {
      label = rest.slice(0, gt).trim();
      buttonLabel = rest.slice(gt + 1).trim() || undefined;
    } else {
      label = rest;
    }

    if (!label || [...label].length > LABEL_MAX) continue;
    if (buttonLabel && [...buttonLabel].length > BUTTON_LABEL_MAX) continue;

    out.push(buttonLabel ? { code, label, buttonLabel } : { code, label });
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

/** Button text shown on Flex — explicit abbreviation wins when configured. */
export function resolveMarketButtonLabel(market: GuidedMenuMarketOption): string {
  return market.buttonLabel ?? market.label;
}
