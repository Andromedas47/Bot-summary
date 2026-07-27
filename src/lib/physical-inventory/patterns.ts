/**
 * Explicit Physical Stock header / close patterns.
 * No fuzzy matching — only strings listed here (and covered by tests).
 */

/** Header lines that open a physical-stock document (NFC-normalized compare). */
export const PHYSICAL_INVENTORY_HEADERS = [
  "สตอกผลไม้คงเหลือ",
  "สตอกผลไม้คงเหลือวันนี้",
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
