import type { GuidedMenuMarketOption, GuidedMenuTransactionLabel } from "./types";

/** Configurable preview markets — labels resolve from id, never from postback text. */
export const PREVIEW_MARKET_OPTIONS: readonly GuidedMenuMarketOption[] = [
  { id: "mkt_khlong_toei", label: "คลองเตย" },
  { id: "mkt_si_mum_mueang", label: "สี่มุมเมือง" },
  { id: "mkt_other", label: "อื่น ๆ" },
] as const;

export const OTHER_MARKET_ID = "mkt_other";

export const PREVIEW_STAFF_LABEL = "พนักงานตัวอย่าง";

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
