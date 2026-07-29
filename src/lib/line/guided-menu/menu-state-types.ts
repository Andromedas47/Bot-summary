/** Typed Guided Menu state contracts for 0051 Slice 1. No LINE / Produce wiring. */

export const MENU_ACTION_TYPES = [
  "menu_root",
  "choose_transaction_type",
  "choose_market",
  "choose_date",
  "confirm_open",
  "view_status",
  "request_close",
  "confirm_finalize",
] as const;

export type MenuActionType = (typeof MENU_ACTION_TYPES)[number];

export const MENU_SOURCE_TYPES = ["user", "group", "room"] as const;
export type MenuSourceType = (typeof MENU_SOURCE_TYPES)[number];

export const MENU_TRANSACTION_TYPE_CODES = [
  "withdraw",
  "return",
  "damaged_return",
] as const;
export type MenuTransactionTypeCode =
  (typeof MENU_TRANSACTION_TYPE_CODES)[number];

export const MENU_DATE_MODES = ["today", "yesterday", "iso"] as const;
export type MenuDateMode = (typeof MENU_DATE_MODES)[number];

/** Mutating confirmation actions use a shorter absolute TTL. */
export const MUTATING_MENU_ACTIONS = new Set<MenuActionType>([
  "confirm_open",
  "request_close",
  "confirm_finalize",
]);

export const MENU_TTL_NAVIGATION_MS = 30 * 60 * 1000;
export const MENU_TTL_MUTATING_MS = 10 * 60 * 1000;

export type MenuPayload = {
  /** Known short code only; never a display label. */
  transaction_type?: MenuTransactionTypeCode;
  /** Server-config market code; never market_label. */
  market_code?: string;
  date_mode?: MenuDateMode;
  /** Required when date_mode === "iso"; YYYY-MM-DD only. */
  iso_date?: string;
  /** Opaque step marker; short code only. */
  step?: string;
};

export type CreateMenuStateInput = {
  actionType: MenuActionType;
  lineUserId: string;
  sourceType: MenuSourceType;
  sourceId: string;
  sessionKey?: string | null;
  payload: MenuPayload;
};

export type ConsumeMenuStateInput = {
  wireToken: string;
  lineEventId: string;
  lineUserId: string;
  sourceType: MenuSourceType;
  sourceId: string;
  sessionKey?: string | null;
};

export type RecordMenuStateResultInput = {
  wireToken: string;
  consumedLineEventId: string;
  result: Record<string, unknown>;
};

export type OperatorIdentity = {
  lineUserId: string;
  staffLabel: string;
  active: boolean;
};

export type ConsumeMenuStateOutcome =
  | {
      status: "consumed";
      actionType: MenuActionType;
      payload: MenuPayload;
    }
  | {
      status: "replay";
      actionType: MenuActionType;
      payload: MenuPayload;
      result: Record<string, unknown> | null;
    }
  | {
      status: "already_consumed";
      actionType: MenuActionType;
      payload: MenuPayload;
      result: Record<string, unknown> | null;
    }
  | { status: "invalid_or_expired" };

export type RecordMenuStateResultOutcome =
  | { status: "recorded"; result: Record<string, unknown> }
  | { status: "replay"; result: Record<string, unknown> }
  | { status: "result_conflict"; result: Record<string, unknown> }
  | { status: "invalid_or_expired" };

export type ResolveOperatorOutcome =
  | { status: "mapped"; identity: OperatorIdentity }
  | { status: "unmapped" };
