import type { GuidedMenuMarketOption, GuidedMenuTransactionLabel } from "./types";

/**
 * Configurable preview markets — labels resolve from id, never from postback text.
 * Spec examples: หน้าเซเวน / วัดตะกล่ำ / ตลาดอื่น
 */
export const PREVIEW_MARKET_OPTIONS: readonly GuidedMenuMarketOption[] = [
  { id: "mkt_seven_front", label: "หน้าเซเวน" },
  { id: "mkt_wat_taklam", label: "วัดตะกล่ำ" },
  { id: "mkt_other", label: "ตลาดอื่น" },
] as const;

export const OTHER_MARKET_ID = "mkt_other";

/** Spec example staff label for confirmation / success copy. */
export const PREVIEW_STAFF_LABEL = "ดำ";

export const PREVIEW_LINE_EVENT_ID = "preview-line-event";

export const MAIN_MENU_CHOICES: readonly {
  label: GuidedMenuTransactionLabel;
  description: string;
}[] = [
  { label: "เบิก", description: "เบิกสินค้าออกไปขาย" },
  { label: "ชั่งคืน", description: "ชั่งของคืนเข้าคลัง" },
  { label: "คืนเสีย", description: "คืนของเสีย / ของชำรุด" },
] as const;

export function findMarketOption(id: string): GuidedMenuMarketOption | null {
  return PREVIEW_MARKET_OPTIONS.find((m) => m.id === id) ?? null;
}

export function isKnownMarketId(id: string): boolean {
  return PREVIEW_MARKET_OPTIONS.some((m) => m.id === id);
}
