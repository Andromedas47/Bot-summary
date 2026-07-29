import type {
  MenuActionType,
  MenuDateMode,
  MenuPayload,
  MenuSourceType,
  MenuTransactionTypeCode,
} from "./menu-state-types";

export const TX_CODE_TO_LABEL: Record<MenuTransactionTypeCode, string> = {
  withdraw: "เบิก",
  return: "ชั่งคืน",
  damaged_return: "คืนเสีย",
};

export const LABEL_TO_TX_CODE: Record<string, MenuTransactionTypeCode> = {
  เบิก: "withdraw",
  ชั่งคืน: "return",
  คืนเสีย: "damaged_return",
};

export const GUIDED_MENU_TRIGGER = "เมนู";

/** LINE buttons-template action label limit (code points). */
export const TEMPLATE_ACTION_LABEL_MAX = 20;
/** LINE Flex button label limit (code points). */
export const FLEX_BUTTON_LABEL_MAX = 40;
/** LINE Flex bubble JSON size limit (UTF-8 bytes). */
export const FLEX_BUBBLE_MAX_UTF8_BYTES = 30 * 1024;
/** Split seller choices across reply messages; LINE permits at most five. */
export const SELLERS_PER_MESSAGE = 8;
export const LINE_REPLY_MESSAGE_MAX = 5;

export const GUIDED_MENU_COPY = {
  unmapped:
    "บัญชีไลน์นี้ยังไม่ได้รับสิทธิ์ใช้งานเมนู กรุณาติดต่อผู้ดูแล",
  invalidOrExpired: "เมนูหมดอายุหรือไม่ถูกต้อง กรุณาพิมพ์ เมนู ใหม่",
  cancelled: "ยกเลิกแล้ว",
  noActiveSellers:
    "ยังไม่มีคนขายที่พร้อมใช้งาน กรุณาติดต่อผู้ดูแล",
  sellerUnavailable:
    "คนขายนี้ไม่พร้อมใช้งานแล้ว กรุณาพิมพ์ เมนู ใหม่",
  noActiveSellerMarkets:
    "คนขายนี้ยังไม่มีตลาดที่พร้อมใช้งาน กรุณาติดต่อผู้ดูแล",
  marketUnavailable:
    "ตลาดนี้ไม่พร้อมใช้งานแล้ว กรุณาพิมพ์ เมนู ใหม่",
  /**
   * Confirm boundary placeholder — must not read as a successful open.
   * Explicitly: no session opened, no data recorded, use existing method.
   * Retained after Slice 3A for the replay path: results recorded before 3A
   * still decode to this screen and must keep rendering their original copy.
   */
  confirmPlaceholder: [
    "ยังไม่ได้เปิดรายการ",
    "ขณะนี้เมนูทดลองยังไม่บันทึกข้อมูล กรุณาใช้วิธีเดิมก่อน",
  ].join("\n"),
  /** 3A: a live round already exists — nothing was written for this press. */
  sessionAlreadyOpen: [
    "มีรายการที่เปิดค้างอยู่ ยังเปิดรายการใหม่ไม่ได้",
    "กรุณาปิดรายการเดิมให้เรียบร้อยก่อน",
    "หากปิดไม่ได้ กรุณาแจ้งผู้ดูแล",
  ].join("\n"),
  /** 3A: the authoritative open refused — nothing was written. */
  sessionOpenConflict: [
    "เปิดรายการไม่สำเร็จ ระบบยังไม่ได้บันทึกอะไร",
    "กรุณาพิมพ์ เมนู แล้วเริ่มใหม่อีกครั้ง",
  ].join("\n"),
  /** 3A: post-open instruction. 3B adds the จบรายการ button beside it. */
  sendItemsHint: "ส่งรายการสินค้าได้เลย",
  txPrompt: "เลือกรายการที่ต้องการบันทึก",
  marketPrompt: "เลือกตลาด",
  sellerPrompt: "เลือกคนขาย",
  datePrompt: "เลือกวันที่",
  confirmHeading: "กำลังจะเปิดรายการ",
} as const;

export type GuidedMenuScreen =
  | "transaction_type"
  | "market"
  | "seller"
  | "date"
  | "confirm"
  | "cancelled"
  | "confirm_placeholder"
  | "session_opened"
  | "session_already_open"
  | "session_open_conflict"
  | "unmapped"
  | "no_sellers"
  | "seller_unavailable"
  | "no_seller_markets"
  | "market_unavailable"
  | "invalid";

export type LinePostbackAction = {
  type: "postback";
  label: string;
  data: string;
  displayText?: string;
};

export type LineQuickReply = {
  items: Array<{
    type: "action";
    action: LinePostbackAction;
  }>;
};

export type LineFlexBubble = {
  type: "bubble";
  size?: "mega" | "kilo" | "micro";
  header?: Record<string, unknown>;
  body: Record<string, unknown>;
  footer?: Record<string, unknown>;
};

export type LineFlexMessage = {
  type: "flex";
  altText: string;
  contents: LineFlexBubble;
  quickReply?: LineQuickReply;
};

export type LineTextMessage = {
  type: "text";
  text: string;
  quickReply?: LineQuickReply;
};

/** Buttons template — used when ≤4 actions fit. */
export type LineTemplateButtonsMessage = {
  type: "template";
  altText: string;
  template: {
    type: "buttons";
    text: string;
    actions: LinePostbackAction[];
  };
};

export type GuidedMenuLineMessage =
  | LineFlexMessage
  | LineTextMessage
  | LineTemplateButtonsMessage;

export type GuidedMenuIdentity = {
  lineUserId: string;
  sourceType: MenuSourceType;
  sourceId: string;
  sessionKey: string | null;
};

export type GuidedMenuUxResult = {
  screen: GuidedMenuScreen;
  messages: GuidedMenuLineMessage[];
  /** Compact result persisted for same-event replay. */
  result: Record<string, unknown>;
  /** True when confirm_open landed on the no-write placeholder. */
  confirmPlaceholder?: boolean;
};

export type TokenButtonSpec = {
  label: string;
  displayText?: string;
  actionType: MenuActionType;
  payload: MenuPayload;
};

export type SelectionSnapshot = {
  transactionType?: MenuTransactionTypeCode;
  marketCode?: string;
  dateMode?: MenuDateMode;
  sellerCode?: string;
};
