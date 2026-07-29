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

export const GUIDED_MENU_COPY = {
  unmapped:
    "บัญชีไลน์นี้ยังไม่ได้รับสิทธิ์ใช้งานเมนู กรุณาติดต่อผู้ดูแล",
  invalidOrExpired: "เมนูหมดอายุหรือไม่ถูกต้อง กรุณาพิมพ์ เมนู ใหม่",
  cancelled: "ยกเลิกแล้ว",
  confirmPlaceholder: "พร้อมเปิดรายการ — รอ Slice 3A",
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
  /** True when confirm_open landed on the Slice-3A placeholder. */
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
