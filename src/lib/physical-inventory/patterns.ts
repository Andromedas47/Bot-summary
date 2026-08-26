/**
 * Explicit Physical Stock header / close patterns.
 * No fuzzy matching — only strings listed here (and covered by tests).
 */

/** Header lines that open a physical-stock document (NFC-normalized compare). */
export const PHYSICAL_INVENTORY_HEADERS = [
  "สตอกผลไม้คงเหลือ",
  "สต๊อกผลไม้คงเหลือ",
  "สตอกผลไม้คงเหลือวันนี้",
  "ผลไม้คงเหลือในบ้าน",
] as const;

/** Headers whose flow requires a per-item unit price (House Stock). */
export const PHYSICAL_INVENTORY_PRICED_HEADERS = [
  "ผลไม้คงเหลือในบ้าน",
] as const;

/**
 * Explicit "nothing left at home" declarations. Exact NFC match after
 * stripping an optional leading item number / punctuation / whitespace.
 * Deliberately not aliases of ไม่มี / หมด / 0 / ศูนย์.
 */
export const PHYSICAL_INVENTORY_EXPLICIT_EMPTY_DECLARATIONS = [
  "ไม่มีผลไม้เหลือ",
  "ไม่มีของเหลือ",
] as const;

/**
 * Close lines recognized only when a Physical Stock session is already open.
 * Bare "จบ" is intentionally included for in-session use — callers must gate.
 */
export const PHYSICAL_INVENTORY_CLOSE_LINES = [
  "จบ",
  "จบรายการผลไม้ที่เหลือในบ้าน",
  // Observed staff typo — explicit allowlist only
  "จบรายการปลไม้ที่เหลือในบ้าน",
] as const;
