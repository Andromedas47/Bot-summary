/**
 * Guided Produce Menu — preview contract types.
 *
 * UX preview and postback contract only. Not wired to webhook or Production DB.
 */

/** Menu-facing labels operators tap. Never silently default these. */
export type GuidedMenuTransactionLabel = "เบิก" | "ชั่งคืน" | "คืนเสีย";

/**
 * Accounting base type expected by 0049 OpenProduceSessionCommand.
 * UI "ชั่งคืน" maps to "คืน".
 */
export type GuidedMenuBaseTransactionType = "เบิก" | "คืน" | "คืนเสีย";

export type GuidedMenuDateMode = "today" | "yesterday" | "custom";

/** Existing screens retained + V1 completion screens. */
export type GuidedMenuScreen =
  | "start_menu"
  | "main_menu"
  | "market_select"
  | "date_select"
  | "custom_date"
  | "other_market"
  | "confirm_open"
  | "active_session"
  | "ack_compact"
  | "session_status"
  | "close_barrier"
  | "review_valid"
  | "review_blocking"
  | "final_confirm"
  | "success"
  /** @deprecated Retained for gallery/compat — maps to review path messaging. */
  | "close_confirm"
  /** @deprecated Retained for gallery/compat — success alias. */
  | "session_closed"
  | "error";

export type GuidedMenuAction =
  | "menu"
  | "start"
  | "select_tx"
  | "select_market"
  | "other_market"
  | "select_date"
  | "custom_date"
  | "set_custom_date"
  | "confirm_open"
  | "edit_open"
  | "start_session"
  | "status"
  | "show_ack"
  | "review_close"
  /** Retained alias → review_close */
  | "close_ask"
  | "barrier_ready"
  | "confirm_persist"
  | "finalize"
  | "send_more"
  | "send_fix"
  | "back_review"
  /** Retained — must NOT finalize; used only as legacy alias path */
  | "close_confirm"
  | "close_cancel"
  | "back";

/** Compact tx codes stored in postbacks — never free-text Thai. */
export type GuidedMenuTxCode = "b" | "k" | "s";

export const TX_CODE_TO_LABEL: Record<GuidedMenuTxCode, GuidedMenuTransactionLabel> = {
  b: "เบิก",
  k: "ชั่งคืน",
  s: "คืนเสีย",
};

export const LABEL_TO_TX_CODE: Record<GuidedMenuTransactionLabel, GuidedMenuTxCode> = {
  เบิก: "b",
  ชั่งคืน: "k",
  คืนเสีย: "s",
};

export const TX_CODE_TO_BASE: Record<GuidedMenuTxCode, GuidedMenuBaseTransactionType> = {
  b: "เบิก",
  k: "คืน",
  s: "คืนเสีย",
};

export const ALL_TX_CODES: readonly GuidedMenuTxCode[] = ["b", "k", "s"];

export interface GuidedMenuMarketOption {
  id: string;
  label: string;
}

/**
 * Versioned postback payload (v1).
 *
 * Business labels are NEVER trusted from the raw string alone — only validated
 * codes/ids that resolve through preview config. `tok` is reserved for 0050
 * opaque server-side state and must not carry trusted business metadata.
 */
export interface GuidedProducePostbackV1 {
  v: 1;
  a: GuidedMenuAction;
  /** Opaque state/token reserved for 0050. TODO(0050-integration). */
  tok?: string;
  tx?: GuidedMenuTxCode;
  mid?: string;
  dm?: GuidedMenuDateMode;
  /** ISO yyyy-mm-dd when dm === "custom". */
  iso?: string;
}

export type DecodePostbackResult =
  | { ok: true; payload: GuidedProducePostbackV1 }
  | { ok: false; reason: string };

export interface GuidedMenuSelection {
  txCode: GuidedMenuTxCode | null;
  marketId: string | null;
  dateMode: GuidedMenuDateMode | null;
  customIsoDate: string | null;
}

/** Preview-only: one received LINE text event (forwarded or pasted). */
export interface PreviewReceivedMessage {
  eventId: string;
  kind: "forwarded" | "pasted_block";
  rawText: string;
}

export interface PreviewParsedItem {
  itemNumber: number;
  productName: string;
  pricePerUnit: number;
  quantity: number | null;
  unit: string | null;
  transactionType: GuidedMenuBaseTransactionType;
  rawPreview: string;
}

export interface PreviewBlockingIssue {
  itemNumber: number | null;
  rawText: string;
  message: string;
}

/** TODO(0049-integration): align with admitted/ingested ledger once 0049 merges. */
export type CloseBarrierStatus = "idle" | "waiting" | "matched";

/** TODO(0049-integration): final review/persist boundary. */
export type ReviewStatus =
  | "none"
  | "valid"
  | "blocking"
  | "awaiting_final"
  | "persisted_sim";

export interface GuidedMenuActiveSession {
  selection: GuidedMenuSelection;
  marketLabel: string;
  businessDateIso: string;
  businessDateThai: string;
  transactionLabel: GuidedMenuTransactionLabel;
  baseTransactionType: GuidedMenuBaseTransactionType;
  staffLabel: string;
  openedAtMs: number;
  /** Distinct from parsedItemCount — webhook/events received. */
  receivedMessageCount: number;
  /** Distinct from receivedMessageCount — reconstructed produce items. */
  parsedItemCount: number;
  blockingIssueCount: number;
  /** @deprecated Prefer parsedItemCount — kept for older callers. */
  observedItemCount: number;
  admittedEventCount: number;
  ingestedEventCount: number;
  closeBarrierStatus: CloseBarrierStatus;
  reviewStatus: ReviewStatus;
  receivedMessages: PreviewReceivedMessage[];
  items: PreviewParsedItem[];
  issues: PreviewBlockingIssue[];
  /** True only after explicit finalize in preview (simulated). */
  persistedSimulated: boolean;
}

export type LineQuickReplyItem = {
  type: "action";
  action: {
    type: "postback";
    label: string;
    data: string;
    displayText?: string;
  };
};

export type LineQuickReply = {
  items: LineQuickReplyItem[];
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

export type LinePreviewMessage = LineFlexMessage | LineTextMessage;

export interface GuidedMenuFlowResult {
  screen: GuidedMenuScreen;
  messages: LinePreviewMessage[];
  selection: GuidedMenuSelection;
  activeSession: GuidedMenuActiveSession | null;
  /** Typed open command emitted only after explicit start — never a Thai header. */
  openCommand: PreviewOpenProduceSessionCommand | null;
  /** Close/finalize command preview after explicit final confirmation. */
  closeCommand: PreviewCloseProduceSessionCommand | null;
  error: string | null;
  previewOnly: true;
}

/**
 * TODO(0049-integration): replace with the real OpenProduceSessionCommand from
 * `src/lib/line/produce-session-commands.ts` once
 * feat/produce-structured-session-foundation merges. Keep field parity identical.
 */
export interface PreviewOpenProduceSessionCommand {
  kind: "open";
  sessionKind: "main";
  initialTransactionType: GuidedMenuBaseTransactionType;
  declaredTransactionType: null;
  additionalOpener: null;
  businessDate: string;
  transactionTime: string;
  transactionTimeSource: "operator_declared" | "line_event";
  staffLabel: string;
  marketLabel: string;
  lineEventId: string;
  lineTimestampMs: number;
}

/**
 * TODO(0049-integration): replace with CloseProduceSessionCommand from 0049.
 */
export interface PreviewCloseProduceSessionCommand {
  kind: "close";
  lineEventId: string;
  lineTimestampMs: number;
  expectedItemCount: number;
}

/** Preview scenario ids for the admin page. */
export type PreviewScenarioId = "valid" | "partial_error" | "waiting";
