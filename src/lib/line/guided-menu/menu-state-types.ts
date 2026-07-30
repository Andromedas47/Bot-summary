/** Typed Guided Menu state contracts for 0051 Slice 1. No LINE / Produce wiring. */

export const MENU_ACTION_TYPES = [
  "menu_root",
  "choose_transaction_type",
  "choose_seller",
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

export const MENU_ROOT_INTENTS = ["cancel", "resume_edit"] as const;
export type MenuRootIntent = (typeof MENU_ROOT_INTENTS)[number];

/** Mutating confirmation actions use a shorter absolute TTL (DB-enforced). */
export const MUTATING_MENU_ACTIONS = new Set<MenuActionType>([
  "confirm_open",
  "request_close",
  "confirm_finalize",
]);

/** Actions that require a non-null session_key binding column. */
export const SESSION_KEY_REQUIRED_ACTIONS = new Set<MenuActionType>([
  "view_status",
  "request_close",
  "confirm_finalize",
]);

/** Documented TTL constants — database is authoritative at create time. */
export const MENU_TTL_NAVIGATION_MS = 30 * 60 * 1000;
export const MENU_TTL_MUTATING_MS = 10 * 60 * 1000;

/**
 * Action-specific payloads. Only stable identifiers — never display labels.
 * Unknown keys are rejected by validateMenuPayloadForAction / DB.
 */
export type MenuRootPayload =
  | Record<string, never>
  | { intent: MenuRootIntent };

export type MenuChooseTransactionTypePayload = {
  transaction_type: MenuTransactionTypeCode;
};

export type MenuChooseSellerPayload = {
  transaction_type: MenuTransactionTypeCode;
  seller_code: string;
};

export type MenuChooseMarketPayload = {
  transaction_type: MenuTransactionTypeCode;
  seller_code: string;
  market_code: string;
};

export type MenuChooseDatePayload =
  | {
      transaction_type: MenuTransactionTypeCode;
      seller_code: string;
      market_code: string;
      date_mode: "today" | "yesterday";
    }
  | {
      transaction_type: MenuTransactionTypeCode;
      seller_code: string;
      market_code: string;
      date_mode: "iso";
      iso_date: string;
    };

export type MenuEmptyPayload = Record<string, never>;

export type MenuPayloadByAction = {
  menu_root: MenuRootPayload;
  choose_transaction_type: MenuChooseTransactionTypePayload;
  choose_seller: MenuChooseSellerPayload;
  choose_market: MenuChooseMarketPayload;
  choose_date: MenuChooseDatePayload;
  confirm_open: MenuChooseDatePayload;
  view_status: MenuEmptyPayload;
  request_close: MenuEmptyPayload;
  confirm_finalize: MenuEmptyPayload;
};

/** Loose payload shape used when reading back validated DB JSON. */
export type MenuPayload = {
  intent?: MenuRootIntent;
  transaction_type?: MenuTransactionTypeCode;
  seller_code?: string;
  market_code?: string;
  date_mode?: MenuDateMode;
  iso_date?: string;
};

export type CreateMenuStateInput<A extends MenuActionType = MenuActionType> = {
  actionType: A;
  lineUserId: string;
  sourceType: MenuSourceType;
  sourceId: string;
  sessionKey?: string | null;
  payload: MenuPayloadByAction[A];
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
  lineUserId: string;
  sourceType: MenuSourceType;
  sourceId: string;
  sessionKey?: string | null;
  result: Record<string, unknown>;
};

export type OperatorIdentity = {
  lineUserId: string;
  staffLabel: string;
  active: boolean;
};

export type CreateMenuStateOutcome =
  | {
      status: "created";
      wireToken: string;
      tokenHash: string;
      actionType: MenuActionType;
      createdAt: string;
      expiresAt: string;
    }
  | { status: "invalid_or_expired" };

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
  | { status: "already_consumed" }
  | { status: "invalid_or_expired" };

export type RecordMenuStateResultOutcome =
  | { status: "recorded"; result: Record<string, unknown> }
  | { status: "replay"; result: Record<string, unknown> }
  | { status: "result_conflict"; result: Record<string, unknown> }
  | { status: "invalid_or_expired" };

export type ResolveOperatorOutcome =
  | { status: "mapped"; identity: OperatorIdentity }
  | { status: "unmapped" };

export type GuidedMenuMarket = {
  marketCode: string;
  label: string;
  active: boolean;
};

export type GuidedMenuSeller = {
  sellerCode: string;
  label: string;
  active: boolean;
  sortOrder: number;
};

export type GuidedMenuSellerMarket = {
  sellerCode: string;
  sellerLabel: string;
  marketCode: string;
  marketLabel: string;
  sortOrder: number;
};
