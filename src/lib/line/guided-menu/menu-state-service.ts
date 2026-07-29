import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  encodeMenuToken,
  generateRawMenuToken,
  hashMenuToken,
  hashMenuTokenWire,
  parseMenuToken,
} from "./menu-token";
import {
  MENU_ACTION_TYPES,
  MENU_DATE_MODES,
  MENU_ROOT_INTENTS,
  MENU_SOURCE_TYPES,
  MENU_TTL_MUTATING_MS,
  MENU_TTL_NAVIGATION_MS,
  MENU_TRANSACTION_TYPE_CODES,
  MUTATING_MENU_ACTIONS,
  SESSION_KEY_REQUIRED_ACTIONS,
  type ConsumeMenuStateInput,
  type ConsumeMenuStateOutcome,
  type CreateMenuStateInput,
  type CreateMenuStateOutcome,
  type GuidedMenuMarket,
  type GuidedMenuSeller,
  type GuidedMenuSellerMarket,
  type MenuActionType,
  type MenuPayload,
  type MenuPayloadByAction,
  type OperatorIdentity,
  type RecordMenuStateResultInput,
  type RecordMenuStateResultOutcome,
  type ResolveOperatorOutcome,
} from "./menu-state-types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARKET_CODE_RE = /^[a-z0-9_]{1,32}$/;
const SELLER_CODE_RE = MARKET_CODE_RE;

function nonblank(value: string | null | undefined, label: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`${label} is required`);
  return v;
}

function assertNeverTrustedLabels(payload: Record<string, unknown>): void {
  if (
    "staff_label" in payload ||
    "seller_label" in payload ||
    "market_label" in payload
  ) {
    throw new Error("menu payload must not carry trusted display labels");
  }
}

function isValidIsoCalendarDate(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const utcNoon = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  return (
    utcNoon.getUTCFullYear() === y &&
    utcNoon.getUTCMonth() === m! - 1 &&
    utcNoon.getUTCDate() === d
  );
}

function sortedKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).sort();
}

function keysEqual(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((k, i) => k === expected[i]);
}

/**
 * Action-specific payload validation (mirrors DB guided_menu_payload_valid).
 * market_code format is checked here; active allowlist is enforced by DB.
 */
export function validateMenuPayloadForAction<A extends MenuActionType>(
  actionType: A,
  payload: MenuPayloadByAction[A],
): MenuPayloadByAction[A] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("menu payload must be an object");
  }
  const raw = payload as Record<string, unknown>;
  assertNeverTrustedLabels(raw);
  const keys = sortedKeys(raw);

  switch (actionType) {
    case "menu_root": {
      if (keys.length === 0) return {} as MenuPayloadByAction[A];
      if (
        keysEqual(keys, ["intent"]) &&
        (MENU_ROOT_INTENTS as readonly string[]).includes(String(raw.intent))
      ) {
        return { intent: raw.intent as "cancel" } as MenuPayloadByAction[A];
      }
      throw new Error("invalid menu_root payload");
    }
    case "choose_transaction_type": {
      if (!keysEqual(keys, ["transaction_type"])) {
        throw new Error("invalid choose_transaction_type payload keys");
      }
      if (
        !(MENU_TRANSACTION_TYPE_CODES as readonly string[]).includes(
          String(raw.transaction_type),
        )
      ) {
        throw new Error("invalid transaction_type code");
      }
      return {
        transaction_type: raw.transaction_type,
      } as MenuPayloadByAction[A];
    }
    case "choose_seller": {
      if (!keysEqual(keys, ["seller_code", "transaction_type"])) {
        throw new Error("invalid choose_seller payload keys");
      }
      const sellerCode = String(raw.seller_code ?? "").trim();
      if (!SELLER_CODE_RE.test(sellerCode)) {
        throw new Error("invalid seller_code");
      }
      if (
        !(MENU_TRANSACTION_TYPE_CODES as readonly string[]).includes(
          String(raw.transaction_type),
        )
      ) {
        throw new Error("invalid transaction_type code");
      }
      return {
        transaction_type: raw.transaction_type,
        seller_code: sellerCode,
      } as MenuPayloadByAction[A];
    }
    case "choose_market": {
      if (
        !keysEqual(keys, ["market_code", "seller_code", "transaction_type"])
      ) {
        throw new Error("invalid choose_market payload keys");
      }
      const sellerCode = String(raw.seller_code ?? "").trim();
      const marketCode = String(raw.market_code ?? "").trim();
      if (!SELLER_CODE_RE.test(sellerCode)) {
        throw new Error("invalid seller_code");
      }
      if (!MARKET_CODE_RE.test(marketCode)) {
        throw new Error("invalid market_code");
      }
      if (
        !(MENU_TRANSACTION_TYPE_CODES as readonly string[]).includes(
          String(raw.transaction_type),
        )
      ) {
        throw new Error("invalid transaction_type code");
      }
      return {
        transaction_type: raw.transaction_type,
        seller_code: sellerCode,
        market_code: marketCode,
      } as MenuPayloadByAction[A];
    }
    case "choose_date":
    case "confirm_open": {
      const tx = String(raw.transaction_type ?? "");
      const sellerCode = String(raw.seller_code ?? "").trim();
      const marketCode = String(raw.market_code ?? "").trim();
      const dateMode = String(raw.date_mode ?? "");
      if (
        !(MENU_TRANSACTION_TYPE_CODES as readonly string[]).includes(tx)
      ) {
        throw new Error("invalid transaction_type code");
      }
      if (!SELLER_CODE_RE.test(sellerCode)) {
        throw new Error("invalid seller_code");
      }
      if (!MARKET_CODE_RE.test(marketCode)) {
        throw new Error("invalid market_code");
      }
      if (dateMode === "today" || dateMode === "yesterday") {
        if (
          !keysEqual(keys, [
            "date_mode",
            "market_code",
            "seller_code",
            "transaction_type",
          ])
        ) {
          throw new Error(`invalid ${actionType} payload keys`);
        }
        return {
          transaction_type: tx,
          seller_code: sellerCode,
          market_code: marketCode,
          date_mode: dateMode,
        } as MenuPayloadByAction[A];
      }
      if (dateMode === "iso") {
        if (
          !keysEqual(keys, [
            "date_mode",
            "iso_date",
            "market_code",
            "seller_code",
            "transaction_type",
          ])
        ) {
          throw new Error(`invalid ${actionType} payload keys`);
        }
        const iso = String(raw.iso_date ?? "");
        if (!isValidIsoCalendarDate(iso)) {
          throw new Error("invalid iso_date");
        }
        return {
          transaction_type: tx,
          seller_code: sellerCode,
          market_code: marketCode,
          date_mode: "iso",
          iso_date: iso,
        } as MenuPayloadByAction[A];
      }
      throw new Error("invalid date_mode");
    }
    case "view_status":
    case "request_close":
    case "confirm_finalize": {
      if (keys.length !== 0) {
        throw new Error(`invalid ${actionType} payload keys`);
      }
      return {} as MenuPayloadByAction[A];
    }
    default: {
      const _exhaustive: never = actionType;
      throw new Error(`unknown action_type: ${_exhaustive}`);
    }
  }
}

/** @deprecated Prefer validateMenuPayloadForAction — kept for older call sites. */
export function validateMenuPayload(payload: MenuPayload): MenuPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("menu payload must be an object");
  }
  assertNeverTrustedLabels(payload as Record<string, unknown>);
  // Reject free-form step — removed from contract.
  if ("step" in (payload as Record<string, unknown>)) {
    throw new Error("unknown payload key: step");
  }
  const out: MenuPayload = {};
  if (payload.intent !== undefined) {
    if (!(MENU_ROOT_INTENTS as readonly string[]).includes(payload.intent)) {
      throw new Error("invalid intent");
    }
    out.intent = payload.intent;
  }
  if (payload.transaction_type !== undefined) {
    if (
      !(MENU_TRANSACTION_TYPE_CODES as readonly string[]).includes(
        payload.transaction_type,
      )
    ) {
      throw new Error("invalid transaction_type code");
    }
    out.transaction_type = payload.transaction_type;
  }
  if (payload.seller_code !== undefined) {
    const code = payload.seller_code.trim();
    if (!SELLER_CODE_RE.test(code)) {
      throw new Error("invalid seller_code");
    }
    out.seller_code = code;
  }
  if (payload.market_code !== undefined) {
    const code = payload.market_code.trim();
    if (!MARKET_CODE_RE.test(code)) {
      throw new Error("invalid market_code");
    }
    out.market_code = code;
  }
  if (payload.date_mode !== undefined) {
    if (!(MENU_DATE_MODES as readonly string[]).includes(payload.date_mode)) {
      throw new Error("invalid date_mode");
    }
    out.date_mode = payload.date_mode;
  }
  if (payload.iso_date !== undefined) {
    if (!isValidIsoCalendarDate(payload.iso_date)) {
      throw new Error("invalid iso_date");
    }
    out.iso_date = payload.iso_date;
  }
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (
      !["intent", "transaction_type", "seller_code", "market_code", "date_mode", "iso_date"].includes(
        key,
      )
    ) {
      throw new Error(`unknown payload key: ${key}`);
    }
  }
  return out;
}

export function ttlMsForAction(actionType: MenuActionType): number {
  return MUTATING_MENU_ACTIONS.has(actionType)
    ? MENU_TTL_MUTATING_MS
    : MENU_TTL_NAVIGATION_MS;
}

function isActionType(value: unknown): value is MenuActionType {
  return (
    typeof value === "string" &&
    (MENU_ACTION_TYPES as readonly string[]).includes(value)
  );
}

function asPayload(value: unknown): MenuPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return validateMenuPayload(value as MenuPayload);
}

function asResultObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("menu result must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export class GuidedMenuStateService {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Resolve trusted staff_label for a LINE user. Never falls back to display name.
   * Missing or inactive rows are unmapped.
   */
  async resolveOperator(lineUserId: string): Promise<ResolveOperatorOutcome> {
    const id = nonblank(lineUserId, "lineUserId");
    const { data, error } = await this.supabase
      .from("line_operator_identities")
      .select("line_user_id, staff_label, active")
      .eq("line_user_id", id)
      .maybeSingle();

    if (error) {
      throw new Error(`operator identity lookup failed: ${error.message}`);
    }
    if (!data || data.active !== true) {
      return { status: "unmapped" };
    }
    const staffLabel = String(data.staff_label ?? "").trim();
    if (!staffLabel) {
      return { status: "unmapped" };
    }
    const identity: OperatorIdentity = {
      lineUserId: String(data.line_user_id),
      staffLabel,
      active: true,
    };
    return { status: "mapped", identity };
  }

  /** Active seller catalog, ordered for the LINE menu. */
  async listActiveSellers(): Promise<GuidedMenuSeller[]> {
    const [sellerResult, assignmentResult, activeMarkets] = await Promise.all([
      this.supabase
        .from("line_guided_menu_sellers")
        .select("seller_code, label, active, sort_order")
        .eq("active", true)
        .order("sort_order"),
      this.supabase
        .from("line_guided_menu_seller_markets")
        .select("seller_code, market_code, active")
        .eq("active", true)
        .order("seller_code"),
      this.listActiveMarkets(),
    ]);

    if (sellerResult.error) {
      throw new Error(
        `seller catalog lookup failed: ${sellerResult.error.message}`,
      );
    }
    if (assignmentResult.error) {
      throw new Error(
        `seller-market lookup failed: ${assignmentResult.error.message}`,
      );
    }
    const activeMarketCodes = new Set(
      activeMarkets.map((market) => market.marketCode),
    );
    const navigableSellerCodes = new Set(
      (assignmentResult.data ?? [])
        .filter(
          (row) =>
            row.active === true &&
            activeMarketCodes.has(String(row.market_code)),
        )
        .map((row) => String(row.seller_code)),
    );
    return (sellerResult.data ?? [])
      .map((row) => ({
        sellerCode: String(row.seller_code),
        label: String(row.label),
        active: row.active === true,
        sortOrder: Number(row.sort_order),
      }))
      .filter(
        (seller) =>
          seller.active &&
          seller.label.trim() &&
          navigableSellerCodes.has(seller.sellerCode),
      )
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, "th"),
      );
  }

  /** Re-read active seller, active assignments, and active markets together. */
  async loadActiveSellerMarkets(sellerCode: string): Promise<{
    seller: GuidedMenuSeller | null;
    markets: GuidedMenuSellerMarket[];
  }> {
    const code = nonblank(sellerCode, "sellerCode");
    const { data: sellerRow, error: sellerError } = await this.supabase
      .from("line_guided_menu_sellers")
      .select("seller_code, label, active, sort_order")
      .eq("seller_code", code)
      .maybeSingle();
    if (sellerError) {
      throw new Error(`seller catalog lookup failed: ${sellerError.message}`);
    }
    if (
      !sellerRow ||
      sellerRow.active !== true ||
      !String(sellerRow.label ?? "").trim()
    ) {
      return { seller: null, markets: [] };
    }
    const seller: GuidedMenuSeller = {
      sellerCode: String(sellerRow.seller_code),
      label: String(sellerRow.label),
      active: true,
      sortOrder: Number(sellerRow.sort_order),
    };

    const { data, error } = await this.supabase
      .from("line_guided_menu_seller_markets")
      .select("seller_code, market_code, active, sort_order")
      .eq("seller_code", code)
      .eq("active", true)
      .order("sort_order");
    if (error) {
      throw new Error(`seller-market lookup failed: ${error.message}`);
    }

    const marketByCode = new Map(
      (await this.listActiveMarkets()).map((market) => [
        market.marketCode,
        market,
      ]),
    );
    const markets = (data ?? [])
      .filter((row) => row.active === true && row.seller_code === code)
      .flatMap((row) => {
        const market = marketByCode.get(String(row.market_code));
        return market
          ? [{
              sellerCode: code,
              sellerLabel: seller.label,
              marketCode: market.marketCode,
              marketLabel: market.label,
              sortOrder: Number(row.sort_order),
            }]
          : [];
      })
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.marketLabel.localeCompare(b.marketLabel, "th"),
      );

    return { seller, markets };
  }

  /** Load trusted market allowlist from DB (authoritative source). */
  async listActiveMarkets(): Promise<GuidedMenuMarket[]> {
    const { data, error } = await this.supabase
      .from("line_guided_menu_markets")
      .select("market_code, label, active")
      .eq("active", true)
      .order("market_code");

    if (error) {
      throw new Error(`market allowlist lookup failed: ${error.message}`);
    }
    return (data ?? []).map((row) => ({
      marketCode: String(row.market_code),
      label: String(row.label),
      active: row.active === true,
    }));
  }

  /**
   * Create opaque menu state via DB-authoritative RPC.
   * Returns the wire token once; only the hash is stored. TTL is set by PostgreSQL.
   */
  async createState(
    input: CreateMenuStateInput,
  ): Promise<CreateMenuStateOutcome> {
    if (!(MENU_ACTION_TYPES as readonly string[]).includes(input.actionType)) {
      return { status: "invalid_or_expired" };
    }
    if (!(MENU_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
      return { status: "invalid_or_expired" };
    }

    let lineUserId: string;
    let sourceId: string;
    let sessionKey: string | null;
    let payload: MenuPayloadByAction[MenuActionType];
    try {
      lineUserId = nonblank(input.lineUserId, "lineUserId");
      sourceId = nonblank(input.sourceId, "sourceId");
      sessionKey =
        input.sessionKey === undefined || input.sessionKey === null
          ? null
          : nonblank(input.sessionKey, "sessionKey");
      payload = validateMenuPayloadForAction(input.actionType, input.payload);
    } catch {
      return { status: "invalid_or_expired" };
    }

    if (
      SESSION_KEY_REQUIRED_ACTIONS.has(input.actionType) &&
      sessionKey === null
    ) {
      return { status: "invalid_or_expired" };
    }

    const raw = generateRawMenuToken(randomBytes);
    const wireToken = encodeMenuToken(raw);
    const tokenHash = hashMenuToken(raw);

    const { data, error } = await this.supabase.rpc("create_line_menu_state", {
      p_token_hash: tokenHash,
      p_action_type: input.actionType,
      p_line_user_id: lineUserId,
      p_source_type: input.sourceType,
      p_source_id: sourceId,
      p_session_key: sessionKey,
      p_payload: payload,
    });

    if (error) {
      throw new Error(`create menu state failed: ${error.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { status: "invalid_or_expired" };
    }
    const row = data as Record<string, unknown>;
    if (row.status !== "created") {
      return { status: "invalid_or_expired" };
    }
    if (!isActionType(row.action_type)) {
      return { status: "invalid_or_expired" };
    }
    if (
      typeof row.created_at !== "string" ||
      typeof row.expires_at !== "string"
    ) {
      return { status: "invalid_or_expired" };
    }

    return {
      status: "created",
      wireToken,
      tokenHash,
      actionType: row.action_type,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async consumeState(
    input: ConsumeMenuStateInput,
  ): Promise<ConsumeMenuStateOutcome> {
    const parsed = parseMenuToken(input.wireToken);
    if (!parsed.ok) {
      return { status: "invalid_or_expired" };
    }
    const tokenHash = hashMenuToken(parsed.raw);
    let lineEventId: string;
    let lineUserId: string;
    let sourceId: string;
    let sessionKey: string | null;
    try {
      lineEventId = nonblank(input.lineEventId, "lineEventId");
      lineUserId = nonblank(input.lineUserId, "lineUserId");
      sourceId = nonblank(input.sourceId, "sourceId");
      sessionKey =
        input.sessionKey === undefined || input.sessionKey === null
          ? null
          : nonblank(input.sessionKey, "sessionKey");
    } catch {
      return { status: "invalid_or_expired" };
    }
    if (!(MENU_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
      return { status: "invalid_or_expired" };
    }

    const { data, error } = await this.supabase.rpc("consume_line_menu_state", {
      p_token_hash: tokenHash,
      p_line_event_id: lineEventId,
      p_line_user_id: lineUserId,
      p_source_type: input.sourceType,
      p_source_id: sourceId,
      p_session_key: sessionKey,
    });

    if (error) {
      throw new Error(`consume menu state failed: ${error.message}`);
    }
    return this.mapConsume(data);
  }

  async recordResult(
    input: RecordMenuStateResultInput,
  ): Promise<RecordMenuStateResultOutcome> {
    const tokenHash = hashMenuTokenWire(input.wireToken);
    if (!tokenHash) {
      return { status: "invalid_or_expired" };
    }
    let eventId: string;
    let lineUserId: string;
    let sourceId: string;
    let sessionKey: string | null;
    try {
      eventId = nonblank(input.consumedLineEventId, "consumedLineEventId");
      lineUserId = nonblank(input.lineUserId, "lineUserId");
      sourceId = nonblank(input.sourceId, "sourceId");
      sessionKey =
        input.sessionKey === undefined || input.sessionKey === null
          ? null
          : nonblank(input.sessionKey, "sessionKey");
    } catch {
      return { status: "invalid_or_expired" };
    }
    if (!(MENU_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
      return { status: "invalid_or_expired" };
    }
    if (
      !input.result ||
      typeof input.result !== "object" ||
      Array.isArray(input.result)
    ) {
      return { status: "invalid_or_expired" };
    }

    const { data, error } = await this.supabase.rpc(
      "record_line_menu_state_result",
      {
        p_token_hash: tokenHash,
        p_consumed_line_event_id: eventId,
        p_line_user_id: lineUserId,
        p_source_type: input.sourceType,
        p_source_id: sourceId,
        p_session_key: sessionKey,
        p_result: input.result,
      },
    );

    if (error) {
      throw new Error(`record menu state result failed: ${error.message}`);
    }
    return this.mapRecord(data);
  }

  private mapConsume(data: unknown): ConsumeMenuStateOutcome {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { status: "invalid_or_expired" };
    }
    const row = data as Record<string, unknown>;
    const status = row.status;
    if (status === "invalid_or_expired") {
      return { status: "invalid_or_expired" };
    }
    if (status === "already_consumed") {
      // Different-event consumption: no action/payload/result disclosure.
      return { status: "already_consumed" };
    }
    if (status === "consumed" || status === "replay") {
      if (!isActionType(row.action_type)) {
        return { status: "invalid_or_expired" };
      }
      const payload = asPayload(row.payload);
      if (status === "consumed") {
        return { status, actionType: row.action_type, payload };
      }
      return {
        status,
        actionType: row.action_type,
        payload,
        result: asResultObject(row.result),
      };
    }
    return { status: "invalid_or_expired" };
  }

  private mapRecord(data: unknown): RecordMenuStateResultOutcome {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { status: "invalid_or_expired" };
    }
    const row = data as Record<string, unknown>;
    if (row.status === "invalid_or_expired") {
      return { status: "invalid_or_expired" };
    }
    if (
      row.status === "recorded" ||
      row.status === "replay" ||
      row.status === "result_conflict"
    ) {
      const result = asResultObject(row.result);
      if (!result) {
        return { status: "invalid_or_expired" };
      }
      return { status: row.status, result };
    }
    return { status: "invalid_or_expired" };
  }
}
