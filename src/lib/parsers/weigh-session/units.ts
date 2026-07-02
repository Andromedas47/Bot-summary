/**
 * Unit alias/conversion registry — the extensible replacement for the old
 * hard-coded `produce_items_unit_check` whitelist (see migrations 0002,
 * 0013, 0016-0018, 0025-0026, all now superseded by 0033).
 *
 * Three tiers, in priority order:
 *   1. UNIT_CONVERSIONS — known scale factor to a canonical unit (quantity
 *      gets rescaled, e.g. ขีด → โล ×0.1).
 *   2. UNIT_ALIASES — pure spelling variants of a canonical unit (no
 *      rescaling, e.g. แพ็ค → แพค).
 *   3. Anything else — an unrecognized unit is stored exactly as written.
 *      No conversion is ever guessed for it.
 */

export interface UnitConversion {
  toUnit: string;
  factor: number;
}

// The full canonical vocabulary this shop uses. Membership here (or in the
// alias/conversion maps below) is what lets the parser recognize a bare
// "<qty><unit><price>บาท" line as an orphan price-basis line instead of a
// product named after the unit — see isKnownUnit().
const CANONICAL_UNITS = new Set([
  "โล", "ขีด", "กรัม",
  "ลูก", "หัว", "กำ", "มัด", "ถุง", "กล่อง", "แพค",
  "หวี", "เครือ", "เข่ง", "พวง", "ลัง",
  "ชิ้น", "ตัว", "ฝัก", "ฟอง", "ใบ", "ดอก",
  "แผง", "ชุด", "ถาด", "กระสอบ", "ขวด", "กระปุก",
  "ลิตร", "มิลลิลิตร", "เส้น", "คู่",
]);

// Pure spelling aliases — normalize to a canonical unit, factor 1 (no
// quantity rescaling).
const UNIT_ALIASES: Record<string, string> = {
  "แพ็ค": "แพค", "แพ็ก": "แพค", "เเพ็ค": "แพค", "เเพค": "แพค",
  "แพต": "แพค", "แพ็ด": "แพค", "แผค": "แพค",
  "กก.": "โล", "กก": "โล", "กิโล": "โล", "กิโลกรัม": "โล",
};

// Explicit, shop-verified conversion factors. Quantity in the raw unit
// gets multiplied by `factor` to land in `toUnit`. Never extend this with a
// guessed factor — an unknown unit must persist as text instead (see
// resolveUnitQuantity below).
const UNIT_CONVERSIONS: Record<string, UnitConversion> = {
  "ขีด":       { toUnit: "โล",   factor: 0.1 },
  "กรัม":      { toUnit: "โล",   factor: 0.001 },
  "มิลลิลิตร": { toUnit: "ลิตร", factor: 0.001 },
};

/** True if `raw` is part of the known vocabulary (canonical, alias, or a conversion source). */
export function isKnownUnit(raw: string): boolean {
  const trimmed = raw.trim();
  return CANONICAL_UNITS.has(trimmed) || trimmed in UNIT_ALIASES || trimmed in UNIT_CONVERSIONS;
}

/** Normalizes spelling only (no rescaling). Unknown units pass through unchanged. */
export function normalizeUnitAlias(raw: string): string {
  const trimmed = raw.trim();
  return UNIT_ALIASES[trimmed] ?? trimmed;
}

/**
 * Resolves a raw (quantity, unit) pair to its canonical form. Applies a
 * known conversion factor if one exists, otherwise applies alias spelling
 * normalization only. A genuinely unknown unit is returned exactly as
 * written, with the quantity untouched — no invented conversion.
 */
export function resolveUnitQuantity(
  rawQuantity: number,
  rawUnit:     string,
): { quantity: number; unit: string } {
  const trimmed    = rawUnit.trim();
  const conversion = UNIT_CONVERSIONS[trimmed];
  if (conversion) {
    return {
      quantity: Number((rawQuantity * conversion.factor).toFixed(10)),
      unit:     conversion.toUnit,
    };
  }
  return { quantity: rawQuantity, unit: normalizeUnitAlias(trimmed) };
}

/**
 * The factor to divide a per-raw-unit price by so that
 * (price / factor) × (quantity × factor) stays equal to price × quantity.
 * Returns 1 for aliases and unknown units (no rescaling happened).
 */
export function conversionFactor(rawUnit: string): number {
  return UNIT_CONVERSIONS[rawUnit.trim()]?.factor ?? 1;
}
