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

export const GUIDED_MENU_COPY = {
  unmapped:
    "บัญชีไลน์นี้ยังไม่ได้รับสิทธิ์ใช้งานเมนู กรุณาติดต่อผู้ดูแล",
  invalidOrExpired: "เมนูหมดอายุหรือไม่ถูกต้อง กรุณาพิมพ์ เมนู ใหม่",
  cancelled: "ยกเลิกแล้ว",
  noActiveMarkets:
    "ยังไม่มีตลาดที่พร้อมใช้งาน กรุณาติดต่อผู้ดูแล",
  marketUnavailable:
    "ตลาดนี้ไม่พร้อมใช้งานแล้ว กรุณาพิมพ์ เมนู ใหม่",
  /**
   * Confirm boundary placeholder — must not read as a successful open.
   * Explicitly: no session opened, no data recorded, use existing method.
   */
  confirmPlaceholder: [
    "ยังไม่ได้เปิดรายการ",
    "ขณะนี้เมนูทดลองยังไม่บันทึกข้อมูล กรุณาใช้วิธีเดิมก่อน",
  ].join("\n"),
  txPrompt: "เลือกรายการที่ต้องการบันทึก",
  marketPrompt: "เลือกตลาด",
  datePrompt: "เลือกวันที่",
  confirmHeading: "กำลังจะเปิดรายการ",
} as const;

export type GuidedMenuScreen =
  | "transaction_type"
  | "market"
  | "date"
  | "confirm"
  | "cancelled"
  | "confirm_placeholder"
  | "unmapped"
  | "no_markets"
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
};
