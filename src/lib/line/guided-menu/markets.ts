/**
 * Display helpers for Guided Menu markets.
 * Authoritative allowlist is public.line_guided_menu_markets via
 * GuidedMenuStateService.listActiveMarkets() — no independent Slice 2 list.
 */

import type { GuidedMenuMarket } from "./menu-state-types";

export type GuidedMenuMarketOption = {
  /** Stable allowlist code — only identity stored in menu payloads. */
  code: string;
  /** Trusted server label for display only (never in postback payloads). */
  label: string;
  /**
   * Explicit LINE button label when `label` exceeds the Flex button limit.
   * Never invented by silent clipping — must be configured for that market.
   */
  buttonLabel?: string;
};

/** Map a DB allowlist row into a display option. */
export function toMarketOption(
  market: GuidedMenuMarket,
  buttonLabel?: string,
): GuidedMenuMarketOption {
  return buttonLabel
    ? { code: market.marketCode, label: market.label, buttonLabel }
    : { code: market.marketCode, label: market.label };
}

export function marketOptionsFromActive(
  markets: readonly GuidedMenuMarket[],
): GuidedMenuMarketOption[] {
  return markets
    .filter((m) => m.active)
    .map((m) => toMarketOption(m))
    .sort((a, b) => a.code.localeCompare(b.code));
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
