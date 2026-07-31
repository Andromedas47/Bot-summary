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
  invalidOrExpired: "เมนูนี้หมดอายุ กรุณาใช้เมนูล่าสุด",
  /**
   * Exit-menu with no round open. Never "ยกเลิกแล้ว": there was nothing to
   * cancel, so the copy must not claim a cancellation happened — see §Copy.
   */
  cancelled: [
    "ปิดเมนูแล้ว ไม่มีรายการที่เปิดอยู่",
    'พิมพ์ "เมนู" เพื่อเริ่มรายการใหม่',
  ].join("\n"),
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
  /** 3B: shown under the open-session receipt once the action buttons exist. */
  closeWhenDoneHint: "เมื่อครบแล้วกด “จบรายการ”",
  /** 3B: no guided round is open for this operator right now. */
  noOpenSession: [
    "ไม่พบรายการที่เปิดจากเมนู",
    "กรุณาพิมพ์ เมนู เพื่อเริ่มรายการใหม่",
  ].join("\n"),
  /** 3B: nothing has been captured yet. */
  noCapturedItems: "ยังไม่มีรายการสินค้าที่บันทึกไว้",
  /** 3B: correction is the existing parser contract — resend the item line. */
  correctionHint: [
    "แก้ไขรายการ: ส่งบรรทัดเดิมใหม่พร้อมราคาที่ถูกต้อง",
    "ระบบจะใช้ค่าล่าสุดของสินค้านั้น",
  ].join("\n"),
  /**
   * 3B: dismissing the menu does NOT void an open round. There is no
   * authoritative cancel-open-session contract to call, so the copy must not
   * imply one — see §2.3. Never "ยกเลิกแล้ว": nothing was cancelled.
   */
  menuDismissedSessionOpen: [
    "ปิดเมนูแล้ว รายการยังเปิดอยู่",
    'พิมพ์ "เมนู" เพื่อทำต่อ',
  ].join("\n"),
  /** 3B: close accepted, waiting for the operator's final confirmation. */
  closeRequested: [
    "รับคำสั่งจบรายการแล้ว",
    "กรุณาตรวจสอบยอดด้านบน แล้วกด “ยืนยันจบรายการ”",
  ].join("\n"),
  /** 3B: the close barrier is not satisfied yet — nothing was released. */
  finalizeNotReady: [
    "ยังยืนยันไม่ได้ ระบบยังรอรายการที่ส่งมาไม่ครบ",
    "กรุณารอสักครู่แล้วกดยืนยันอีกครั้ง",
  ].join("\n"),
  /** 3B: the guided close/confirm could not proceed — nothing was written. */
  sessionActionConflict: [
    "ทำรายการไม่สำเร็จ ระบบยังไม่ได้บันทึกการเปลี่ยนแปลง",
    "กรุณาพิมพ์ เมนู แล้วลองใหม่อีกครั้ง",
  ].join("\n"),
  /**
   * 3B: the hold was released and the deferred finalizer has not reported yet.
   * Must never read as saved — no produce row is proven to exist.
   */
  produceFinalizing: [
    "กำลังบันทึกรายการสินค้า ยังไม่เสร็จ",
    'กรุณารอสักครู่แล้วกด "ดูสถานะ" เพื่อตรวจผลอีกครั้ง',
    "ยังไม่ต้องกรอกใบขาว จนกว่าจะขึ้นว่าบันทึกเรียบร้อย",
  ].join("\n"),
  /** 3B: shown beside the validation detail — the list was NOT saved. */
  produceFinalizeFailed: [
    "บันทึกรายการสินค้าไม่สำเร็จ ระบบไม่ได้บันทึกรายการนี้",
    "กรุณาแจ้งผู้ดูแลเพื่อเปิดรอบใหม่ และส่งรายการอีกครั้ง",
    "ยังกรอกใบขาวไม่ได้",
  ].join("\n"),
  /** 3B: one-line form of the failure, for guards on later steps. */
  produceFinalizeFailedShort: [
    "รายการสินค้าของรอบนี้บันทึกไม่สำเร็จ",
    "กรุณาแจ้งผู้ดูแล ยังทำขั้นต่อไปไม่ได้",
  ].join("\n"),
  /**
   * 3B: "จบรายการ" refused before the immutable close boundary was created.
   * The round is still open, so corrections are still ordinary item messages.
   */
  produceCloseValidationFailed: [
    "ยังจบรายการไม่ได้ ระบบอ่านรายการด้านล่างไม่ครบ",
    "รายการยังเปิดอยู่ ยังไม่ได้บันทึกอะไร",
    'กรุณาส่งบรรทัดที่ถูกต้องใหม่ แล้วกด "จบรายการ" อีกครั้ง',
  ].join("\n"),
  /** 3B: the session cannot finalize — refused before any write. */
  produceValidationFailed: [
    "ยังยืนยันไม่ได้ ระบบยังอ่านรายการไม่ครบ",
    "ยังไม่ได้บันทึกอะไร กรุณาแก้บรรทัดด้านล่างแล้วส่งใหม่",
  ].join("\n"),
  /** Ownership guard: every refusal states plainly that nothing was written. */
  ownershipNothingRecorded: "ระบบยังไม่ได้บันทึกอะไร",
  /** Ownership guard: this market/date belongs to another operator's round. */
  ownershipOtherOperator: [
    "รอบนี้เป็นของผู้ใช้อีกคนในกลุ่ม",
    "กรุณาให้เจ้าของรอบส่งเอง หรือเปิดรอบของตัวเองจากเมนู",
  ].join("\n"),
  /** Ownership guard: the produce round is not finished yet. */
  ownershipProduceUnfinished: [
    "รอบนี้ยังทำรายการสินค้าไม่จบ",
    'กรุณากด "จบรายการ" และยืนยันให้เรียบร้อยก่อน',
  ].join("\n"),
  /** Ownership guard: the check could not be answered — fail closed. */
  ownershipUnknown: [
    "ตรวจสอบรอบไม่สำเร็จ",
    "กรุณาลองใหม่อีกครั้ง หากยังไม่ได้ กรุณาแจ้งผู้ดูแล",
  ].join("\n"),
  /** Ownership guard: submitted market/date is not the caller's own round. */
  ownershipRoundMismatch: "ข้อความนี้ไม่ตรงกับรอบที่เปิดอยู่",
  ownershipUseTemplate: "กรุณาใช้แบบฟอร์มที่ระบบส่งให้ และแก้เฉพาะตัวเลข",
  /**
   * Ownership guard: more than one operator owns a matching round, so nothing
   * can decide which one this message belongs to. Fail closed.
   */
  ownershipAmbiguous: [
    "พบรอบของตลาด/วันที่นี้มากกว่าหนึ่งรอบในกลุ่ม",
    "ระบบไม่สามารถระบุได้ว่าข้อความนี้เป็นของรอบไหน",
    "กรุณาให้ผู้ดูแลตรวจก่อน",
  ].join("\n"),
  /**
   * Ownership guard: the message carries a guided form marker that does not
   * match this operator and this round — a copied, edited, or stale-generation
   * template. Framed as expiry, not internals: the operator never needs to
   * understand tokens or session generations, only to ask for a new form.
   */
  ownershipMarkerRejected: [
    "แบบฟอร์มนี้หมดอายุแล้ว กรุณากด “สร้างแบบฟอร์มใหม่”",
  ].join("\n"),
  /**
   * Ownership guard: a stale/invalid form marker whose purpose no longer
   * applies to the caller's CURRENT stage (round moved on, or closed).
   * Regenerating would either do nothing useful or reopen a finished round,
   * so no "สร้างแบบฟอร์มใหม่" action is offered — only a status check.
   */
  staleFormNoLongerApplicable: [
    "แบบฟอร์มนี้หมดอายุแล้ว",
    "กรุณาดูสถานะรอบปัจจุบัน",
  ].join("\n"),
  /** Ownership guard: the round's settlement already went out — terminal. */
  ownershipRoundClosed: [
    "รอบนี้ปิดและส่งสรุปไปแล้ว",
    "ไม่สามารถแก้ไขผ่านไลน์ได้ หากต้องการแก้ไข กรุณาติดต่อผู้ดูแล",
  ].join("\n"),
  /** 3A: another operator already owns this market/date in this group. */
  sessionRoundOwnedByOther: [
    "มีคนเปิดรอบของตลาดและวันที่นี้ไว้แล้วในกลุ่ม",
    "ยังเปิดรอบซ้ำไม่ได้ กรุณาให้เจ้าของรอบทำต่อ หรือเลือกตลาด/วันที่อื่น",
  ].join("\n"),
  /** Slip guard: the header's date cannot be read — refuse before opening. */
  slipOpenBadDate: [
    "วันที่ในหัวข้อสลิปไม่ถูกต้อง ยังเปิดชุดสลิปไม่ได้",
    "กรุณาใช้รูปแบบ วว/ดด/พ.ศ. เช่น 29/07/2569",
  ].join("\n"),
  /** Slip guard: the white sheet has to be in before the slip batch opens. */
  slipOpenWhiteSheetMissing: [
    "ยังเปิดชุดสลิปไม่ได้ ยังไม่ได้บันทึกใบขาวของรอบนี้",
    'กรุณากด "กรอกใบขาว" แล้วส่งใบขาวก่อน',
  ].join("\n"),
  /** Slip guard: the seller→market assignment is no longer active. */
  slipOpenAssignmentRevoked: [
    "คนขายกับตลาดนี้ไม่ได้ผูกกันในระบบแล้ว",
    "กรุณาติดต่อผู้ดูแล",
  ].join("\n"),
  /** 3B → 3C handoff. */
  nextStepWhiteSheet: "ขั้นต่อไป: กรอกใบขาว",
  /** 3C: how to use the white-sheet template. */
  whiteSheetInstructions: [
    "ขั้นตอน 2/4 — กรอกใบขาว",
    "",
    "คัดลอกข้อความด้านล่าง แก้เฉพาะตัวเลข แล้วส่งกลับมา",
    "บรรทัดไหนไม่มีค่าใช้จ่าย ใส่ 0 ไว้",
  ].join("\n"),
  /** 3C: shown when the sheet is already submitted. */
  whiteSheetAlreadySubmitted: "ใบขาวของรอบนี้บันทึกไว้แล้ว",
  /** 3C: FINALIZED sheets are never overwritten from LINE. */
  whiteSheetFinalized: [
    "ใบขาวของรอบนี้ถูกยืนยันแล้ว (FINALIZED)",
    "ไม่สามารถแก้ไขผ่านไลน์ได้ หากต้องการแก้ กรุณาติดต่อผู้ดูแล",
  ].join("\n"),
  /** 3C → 3D handoff. */
  nextStepSlips: "ขั้นต่อไป: ส่งสลิป",
  /** 3D: how to open the transfer-slip batch. */
  slipInstructions: [
    "ขั้นตอน 3/4 — ส่งสลิป",
    "",
    "ส่งข้อความด้านล่างก่อน แล้วส่งรูปสลิปตามได้เลย",
    'เมื่อส่งครบ กด "จบการส่งสลิป"',
    'ถ้ามีสลิปที่ระบบอ่านไม่ได้ ใช้ "สลิปมือ" ตามวิธีเดิม',
  ].join("\n"),
  /** 3D.1: how to use the settlement template. */
  settlementInstructions: [
    "ขั้นตอน 4/4 — กรอกยอดส่ง",
    "",
    "คัดลอกข้อความด้านล่าง แก้เฉพาะตัวเลข แล้วส่งกลับมา",
    "บรรทัดไหนไม่มียอด ใส่ 0 ไว้",
  ].join("\n"),
  /** 3D.1: every refusal must say plainly that no money was recorded. */
  settlementNotRecorded: "ระบบยังไม่ได้บันทึกยอดส่งของรอบนี้",
  /** 3D.1: no guided round to attach a settlement to. */
  settlementNoJourney: [
    "ยังไม่มีรอบที่พร้อมกรอกยอดส่ง",
    "กรุณาพิมพ์ เมนู เพื่อเริ่มรายการใหม่",
  ].join("\n"),
  /** 3D.1: the produce round is still open. */
  settlementProduceUnfinished: [
    "ยังกรอกยอดส่งไม่ได้ รายการสินค้ายังไม่จบ",
    'กรุณากด "จบรายการ" และยืนยันให้เรียบร้อยก่อน',
  ].join("\n"),
  /** 3D.1: the White Sheet must be in before the settlement. */
  settlementWhiteSheetMissing: [
    "ยังกรอกยอดส่งไม่ได้ ยังไม่ได้บันทึกใบขาวของรอบนี้",
    'กรุณากด "กรอกใบขาว" แล้วส่งใบขาวก่อน',
  ].join("\n"),
  /** 3D.1: the round's settlement message already went out. */
  settlementAlreadyClosed: [
    "รอบนี้ปิดและส่งสรุปไปแล้ว",
    "ไม่สามารถแก้ยอดส่งผ่านไลน์ได้ หากต้องการแก้ กรุณาติดต่อผู้ดูแล",
  ].join("\n"),
  /** 3D.1: another settlement row already exists under a different key. */
  settlementAmbiguous: [
    "พบยอดส่งของรอบนี้ที่บันทึกไว้ด้วยข้อมูลอื่นแล้ว",
    "กรุณาให้ผู้ดูแลตรวจก่อน",
  ].join("\n"),
  /** 3D.1: the authoritative write failed — nothing changed. */
  settlementWriteFailed: [
    "บันทึกยอดส่งไม่สำเร็จ",
    "กรุณาลองใหม่อีกครั้ง หากยังไม่ได้ กรุณาแจ้งผู้ดูแล",
  ].join("\n"),
  /** 3D.1 → ตรวจยอด handoff. */
  nextStepReconcile: "ขั้นต่อไป: ตรวจยอด",
  /** 3D: the round-close text command the bot tells the operator to send. */
  roundCloseCommand: "ปิดรอบ",
  /** 3D: nothing to close yet. */
  roundCloseNoJourney: [
    "ยังไม่มีรอบที่พร้อมปิด",
    "กรุณาพิมพ์ เมนู เพื่อเริ่มรายการใหม่",
  ].join("\n"),
  txPrompt: "เลือกรายการที่ต้องการบันทึก",
  marketPrompt: "เลือกตลาด",
  sellerPrompt: "เลือกคนขาย",
  datePrompt: "เลือกวันที่",
  confirmHeading: "กำลังจะเปิดรายการ",

  // ── V2 UX — stage headers, one number per screen, never internal state ────
  stageHeaderCapture: "ขั้นตอน 1/4 — กรอกสินค้า",
  /** V2: awaiting_confirm is a different moment than ordinary capture. */
  stageHeaderConfirm: "ขั้นตอน 1/4 — ยืนยันรายการ",

  /** V2: the close-item button label. Legacy exact text "จบรายการ" is unchanged. */
  closeItemsLabel: "จบการกรอกสินค้า",
  /** V2: the slip-batch-close button label. Legacy exact text "จบสลิป" is unchanged. */
  closeSlipsLabel: "จบการส่งสลิป",
  startSlipsLabel: "เริ่มส่งสลิป",
  /** V2: one authoritative check-and-close action; reuses the "ปิดรอบ" contract. */
  checkAndCloseLabel: "ตรวจและปิดรอบ",
  editSettlementLabel: "แก้ไขยอดส่ง",
  viewDetailLabel: "ดูรายละเอียด",
  /** V2: offered wherever a journey is terminal — never revives it, only opens a new one. */
  startNewLabel: "เริ่มรายการใหม่",
  generateNewFormLabel: "สร้างแบบฟอร์มใหม่",

  /** V2: round closed successfully — kept minimal, no report recap. */
  roundClosed: "ปิดรอบแล้ว ✅",
  /** V2: blockers exist beyond a plain amount mismatch — one actionable list. */
  roundNotReadyHeading: "ยังปิดรอบไม่ได้",
  roundNotReadyNextSteps: "ต้องทำต่อ:",
  /** V2: totals exist but do not match — the one recommended next action. */
  roundMismatchHeading: "ยอดยังไม่ตรง",
  roundMismatchNextStep: "กรุณาตรวจสอบยอดส่งอีกครั้ง",

  /** V2: the produce round is terminally failed with nothing saved. */
  produceFailedZeroWrites: "รอบนี้บันทึกไม่สำเร็จ",
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
  | "session_status"
  | "session_close_requested"
  | "session_finalize_confirmed"
  | "session_finalize_not_ready"
  | "session_finalizing"
  | "session_finalize_failed"
  | "session_validation_failed"
  | "session_action_conflict"
  | "session_menu_dismissed"
  | "no_open_session"
  | "white_sheet_template"
  | "slip_instructions"
  | "settlement_template"
  | "round_status"
  | "round_closed"
  | "round_check_blocked"
  | "produce_failed_terminal"
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

/**
 * A Quick Reply item that resubmits fixed text, exactly as if the operator had
 * typed it — used only to relabel an EXISTING exact-text command (e.g. the
 * legacy "ปิดรอบ"/"เมนู" triggers) with friendlier UX copy. Never a new
 * command: whatever `text` names must already be handled by the plain-text
 * router, so this never becomes a second parser or a second contract.
 */
export type LineMessageAction = {
  type: "message";
  label: string;
  text: string;
};

export type LineQuickReply = {
  items: Array<{
    type: "action";
    action: LinePostbackAction | LineMessageAction;
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
