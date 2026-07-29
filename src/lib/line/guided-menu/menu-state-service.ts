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
  MENU_SOURCE_TYPES,
  MENU_TTL_MUTATING_MS,
  MENU_TTL_NAVIGATION_MS,
  MENU_TRANSACTION_TYPE_CODES,
  MUTATING_MENU_ACTIONS,
  type ConsumeMenuStateInput,
  type ConsumeMenuStateOutcome,
  type CreateMenuStateInput,
  type MenuActionType,
  type MenuPayload,
  type OperatorIdentity,
  type RecordMenuStateResultInput,
  type RecordMenuStateResultOutcome,
  type ResolveOperatorOutcome,
} from "./menu-state-types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_CODE_RE = /^[a-z0-9_]{1,32}$/;

function nonblank(value: string | null | undefined, label: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`${label} is required`);
  return v;
}

function assertNeverTrustedLabels(payload: Record<string, unknown>): void {
  if ("staff_label" in payload || "market_label" in payload) {
    throw new Error("menu payload must not carry trusted display labels");
  }
}

export function validateMenuPayload(payload: MenuPayload): MenuPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("menu payload must be an object");
  }
  assertNeverTrustedLabels(payload as Record<string, unknown>);

  const out: MenuPayload = {};
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
  if (payload.market_code !== undefined) {
    const code = payload.market_code.trim();
    if (!SHORT_CODE_RE.test(code)) {
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
    if (!ISO_DATE_RE.test(payload.iso_date)) {
      throw new Error("invalid iso_date");
    }
    out.iso_date = payload.iso_date;
  }
  if (payload.step !== undefined) {
    const step = payload.step.trim();
    if (!SHORT_CODE_RE.test(step)) {
      throw new Error("invalid step code");
    }
    out.step = step;
  }
  if (out.date_mode === "iso" && !out.iso_date) {
    throw new Error("iso_date required when date_mode is iso");
  }
  if (out.iso_date && out.date_mode !== "iso") {
    throw new Error("iso_date only allowed when date_mode is iso");
  }

  // Reject unknown keys.
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (
      ![
        "transaction_type",
        "market_code",
        "date_mode",
        "iso_date",
        "step",
      ].includes(key)
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

  /**
   * Create opaque menu state. Returns the wire token once; only the hash is stored.
   */
  async createState(input: CreateMenuStateInput): Promise<{
    wireToken: string;
    tokenHash: string;
    expiresAt: string;
  }> {
    if (!(MENU_ACTION_TYPES as readonly string[]).includes(input.actionType)) {
      throw new Error("invalid action_type");
    }
    if (!(MENU_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
      throw new Error("invalid source_type");
    }

    const lineUserId = nonblank(input.lineUserId, "lineUserId");
    const sourceId = nonblank(input.sourceId, "sourceId");
    const sessionKey =
      input.sessionKey === undefined || input.sessionKey === null
        ? null
        : nonblank(input.sessionKey, "sessionKey");
    const payload = validateMenuPayload(input.payload);

    const raw = generateRawMenuToken(randomBytes);
    const wireToken = encodeMenuToken(raw);
    const tokenHash = hashMenuToken(raw);
    const ttlMs = ttlMsForAction(input.actionType);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const { error } = await this.supabase.from("line_menu_states").insert({
      token_hash: tokenHash,
      action_type: input.actionType,
      line_user_id: lineUserId,
      source_type: input.sourceType,
      source_id: sourceId,
      session_key: sessionKey,
      payload,
      expires_at: expiresAt,
    });

    if (error) {
      throw new Error(`create menu state failed: ${error.message}`);
    }

    return { wireToken, tokenHash, expiresAt };
  }

  async consumeState(
    input: ConsumeMenuStateInput,
  ): Promise<ConsumeMenuStateOutcome> {
    const parsed = parseMenuToken(input.wireToken);
    if (!parsed.ok) {
      return { status: "invalid_or_expired" };
    }
    const tokenHash = hashMenuToken(parsed.raw);
    const lineEventId = nonblank(input.lineEventId, "lineEventId");
    const lineUserId = nonblank(input.lineUserId, "lineUserId");
    const sourceId = nonblank(input.sourceId, "sourceId");
    if (!(MENU_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
      return { status: "invalid_or_expired" };
    }
    const sessionKey =
      input.sessionKey === undefined || input.sessionKey === null
        ? null
        : nonblank(input.sessionKey, "sessionKey");

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
    const eventId = nonblank(input.consumedLineEventId, "consumedLineEventId");
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
    if (
      status === "consumed" ||
      status === "replay" ||
      status === "already_consumed"
    ) {
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
