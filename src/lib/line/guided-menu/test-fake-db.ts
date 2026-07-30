/**
 * In-memory double for Guided Menu Slice 2 unit/webhook tests.
 * Mirrors corrected Slice 1 create/consume/record RPC semantics.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizedMarketLabel } from "@/lib/market";
import { hashMenuTokenWire } from "./menu-token";
import {
  MUTATING_MENU_ACTIONS,
  type MenuActionType,
  type MenuPayload,
} from "./menu-state-types";

type OperatorRow = {
  line_user_id: string;
  staff_label: string;
  active: boolean;
};

type MarketRow = {
  market_code: string;
  label: string;
  active: boolean;
};

type SellerRow = {
  seller_code: string;
  label: string;
  active: boolean;
  sort_order: number;
};

type SellerMarketRow = {
  seller_code: string;
  market_code: string;
  active: boolean;
  sort_order: number;
};

type MenuStateRow = {
  token_hash: string;
  action_type: MenuActionType;
  line_user_id: string;
  source_type: string;
  source_id: string;
  session_key: string | null;
  payload: MenuPayload;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_line_event_id: string | null;
  result: Record<string, unknown> | null;
};

type Row = Record<string, unknown>;

const NAV_TTL_MS = 30 * 60 * 1000;
const MUT_TTL_MS = 10 * 60 * 1000;

function ttlMs(action: MenuActionType): number {
  return MUTATING_MENU_ACTIONS.has(action) ? MUT_TTL_MS : NAV_TTL_MS;
}

function payloadLooksValid(
  action: MenuActionType,
  payload: MenuPayload,
  sellers: SellerRow[],
  markets: MarketRow[],
  assignments: SellerMarketRow[],
): boolean {
  const keys = Object.keys(payload).sort();
  if (
    "staff_label" in payload ||
    "seller_label" in payload ||
    "market_label" in payload ||
    "step" in payload
  ) {
    return false;
  }
  const validTx = ["withdraw", "return", "damaged_return"].includes(
    String(payload.transaction_type),
  );
  const activeSeller = (code: string | undefined) =>
    !!code && sellers.some((row) => row.seller_code === code && row.active);
  const activeMarket = (code: string | undefined) =>
    !!code && markets.some((row) => row.market_code === code && row.active);
  const activeAssignment = (seller: string | undefined, market: string | undefined) =>
    !!seller &&
    !!market &&
    assignments.some(
      (row) =>
        row.seller_code === seller &&
        row.market_code === market &&
        row.active,
    );
  const validSelection = () =>
    validTx &&
    activeSeller(payload.seller_code) &&
    activeMarket(payload.market_code) &&
    activeAssignment(payload.seller_code, payload.market_code);

  switch (action) {
    case "menu_root":
      if (keys.length === 0) return true;
      return keys.length === 1 && keys[0] === "intent" && (
        payload.intent === "cancel" || payload.intent === "resume_edit"
      );
    case "choose_transaction_type":
      return keys.length === 1 && keys[0] === "transaction_type" && validTx;
    case "choose_seller":
      return (
        keys.join(",") === "seller_code,transaction_type" &&
        validTx &&
        activeSeller(payload.seller_code)
      );
    case "choose_market":
      return (
        keys.join(",") === "market_code,seller_code,transaction_type" &&
        validSelection()
      );
    case "choose_date":
    case "confirm_open": {
      if (!validSelection()) return false;
      if (payload.date_mode === "today" || payload.date_mode === "yesterday") {
        return keys.join(",") === "date_mode,market_code,seller_code,transaction_type";
      }
      if (payload.date_mode === "iso") {
        return (
          keys.join(",") ===
            "date_mode,iso_date,market_code,seller_code,transaction_type" &&
          typeof payload.iso_date === "string"
        );
      }
      return false;
    }
    case "view_status":
    case "request_close":
    case "confirm_finalize":
      return keys.length === 0;
    default:
      return false;
  }
}

export class GuidedMenuFakeDatabase {
  operators: OperatorRow[] = [];
  markets: MarketRow[] = [];
  sellers: SellerRow[] = [];
  sellerMarkets: SellerMarketRow[] = [];
  states: MenuStateRow[] = [];
  wireByHash = new Map<string, string>();

  openProduceCalls = 0;
  appendCalls = 0;
  admitCalls = 0;
  ingestCalls = 0;
  closeRpcCalls = 0;
  pushCalls = 0;

  tables: Record<string, Row[]> = {
    raw_messages: [],
    pending_sessions: [],
    pending_session_admission: [],
    pending_session_ingest: [],
    line_operator_identities: [],
    line_menu_states: [],
    line_guided_menu_markets: [],
    line_guided_menu_sellers: [],
    line_guided_menu_seller_markets: [],
    produce_sessions: [],
  };

  seedOperator(row: OperatorRow): void {
    this.operators = this.operators.filter((o) => o.line_user_id !== row.line_user_id);
    this.operators.push(row);
    this.tables.line_operator_identities = [...this.operators];
  }

  seedMarket(row: MarketRow): void {
    this.markets = this.markets.filter((m) => m.market_code !== row.market_code);
    this.markets.push(row);
    this.tables.line_guided_menu_markets = [...this.markets];
  }


  seedSeller(row: SellerRow): void {
    this.sellers = this.sellers.filter(
      (seller) => seller.seller_code !== row.seller_code,
    );
    this.sellers.push(row);
    this.tables.line_guided_menu_sellers = [...this.sellers];
  }

  seedSellerMarket(row: SellerMarketRow): void {
    this.sellerMarkets = this.sellerMarkets.filter(
      (assignment) =>
        assignment.seller_code !== row.seller_code ||
        assignment.market_code !== row.market_code,
    );
    this.sellerMarkets.push(row);
    this.tables.line_guided_menu_seller_markets = [...this.sellerMarkets];
  }
  /** Convenience: seed reviewed active markets used by Guided Menu tests. */
  seedDefaultMarkets(): void {
    this.seedMarket({
      market_code: "wat_thung_lanna",
      label: "วัดทุ่งลานนา",
      active: true,
    });
    this.seedMarket({
      market_code: "seven_front",
      label: "หน้าเซเวน",
      active: true,
    });
    this.seedMarket({
      market_code: "wat_taklam",
      label: "วัดตะกล่ำ",
      active: true,
    });
  }

  stateByWire(wire: string): MenuStateRow | undefined {
    const hash = hashMenuTokenWire(wire);
    if (!hash) return undefined;
    return this.states.find((s) => s.token_hash === hash);
  }

  rememberWire(wire: string): void {
    const hash = hashMenuTokenWire(wire);
    if (hash) this.wireByHash.set(hash, wire);
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }

  from = (table: string) => {
    return {
      insert: (payload: Row | Row[]) => {
        const rows = Array.isArray(payload) ? payload : [payload];
        if (table === "raw_messages") {
          const row: Row = {
            id: `raw-${this.tables.raw_messages.length + 1}`,
            ...rows[0],
          };
          if (
            this.tables.raw_messages.some(
              (r) => r.line_event_id === row.line_event_id,
            )
          ) {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: "23505", message: "duplicate" },
                }),
              }),
            };
          }
          this.tables.raw_messages.push(row);
          return {
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          };
        }
        this.tables[table] = [...(this.tables[table] ?? []), ...rows];
        return {
          select: () => ({
            single: async () => ({ data: rows[0], error: null }),
          }),
        };
      },
      select: (cols?: string) => {
        void cols;
        // Filters accumulate, so eq/not can be chained in any order.
        const chain = (filters: Array<(row: Row) => boolean>) => {
          const source = (): Row[] => {
            if (table === "line_operator_identities") {
              return this.operators as unknown as Row[];
            }
            if (table === "line_guided_menu_markets") {
              return this.markets as unknown as Row[];
            }
            return this.tables[table] ?? [];
          };
          const filterRows = (): Row[] =>
            source().filter((row) => filters.every((f) => f(row)));
          return {
            maybeSingle: async () => {
              const data = filterRows()[0] ?? null;
              return { data, error: null };
            },
            single: async () => {
              const data = filterRows()[0] ?? null;
              return { data, error: null };
            },
            limit: () => ({
              maybeSingle: async () => {
                const data = filterRows()[0] ?? null;
                return { data, error: null };
              },
            }),
            order: async (col: string) => {
              void col;
              const data = filterRows().slice().sort((a, b) =>
                String(a.market_code ?? "").localeCompare(
                  String(b.market_code ?? ""),
                ),
              );
              return { data, error: null };
            },
            eq: (column: string, value: unknown) =>
              chain([...filters, (row) => row[column] === value]),
            /** Only `.not(col, "is", null)` is used by the guided lookups. */
            not: (column: string, _operator: string, _value: unknown) => {
              void _operator;
              void _value;
              return chain([
                ...filters,
                (row) => row[column] !== null && row[column] !== undefined,
              ]);
            },
          };
        };
        return {
          eq: (column: string, value: unknown) =>
            chain([(row) => row[column] === value]),
        };
      },
      update: (patch: Row) => ({
        eq: async (column: string, value: unknown) => {
          this.tables[table] = (this.tables[table] ?? []).map((r) =>
            r[column] === value ? { ...r, ...patch } : r,
          );
          return { data: null, error: null };
        },
      }),
    };
  };

  rpc = async (name: string, args: Row) => {
    if (name === "open_produce_structured_session") {
      this.openProduceCalls += 1;
      throw new Error("Slice 2 must not open produce sessions");
    }
    if (name === "append_pending_session") {
      this.appendCalls += 1;
      throw new Error("Slice 2 must not append pending sessions");
    }
    if (name === "admit_pending_session_event") {
      this.admitCalls += 1;
      throw new Error("Slice 2 must not admit");
    }
    if (name === "register_pending_session_ingest") {
      this.ingestCalls += 1;
      throw new Error("Slice 2 must not ingest");
    }
    if (
      name.includes("close") ||
      (name.includes("confirm") && name !== "record_line_menu_state_result")
    ) {
      this.closeRpcCalls += 1;
    }

    if (name === "create_line_menu_state") {
      return { data: this.create(args), error: null };
    }
    if (name === "consume_line_menu_state") {
      return { data: this.consume(args), error: null };
    }
    if (name === "record_line_menu_state_result") {
      return { data: this.record(args), error: null };
    }
    if (name === "open_or_rotate_produce_structured_session") {
      return { data: this.openOrRotate(args), error: null };
    }
    if (name === "open_or_rotate_guided_produce_structured_session") {
      return { data: this.openGuided(args), error: null };
    }
    if (name === "close_produce_structured_session") {
      return { data: this.closeStructured(args), error: null };
    }
    if (name === "confirm_produce_structured_finalization") {
      return { data: this.confirmStructured(args), error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };

  /** Set when the fake close barrier should answer `not_ready`. */
  finalizeNotReady = false;

  /**
   * What the DEFERRED finalizer reports, if it has run at all.
   *
   * `null` (the default) is production's normal case right after the hold is
   * released: `finalization_status` is still 'pending' and no produce row
   * exists. Setting it simulates `try_finalize_pending_generation` having
   * already reached a terminal state.
   */
  deferredFinalizerOutcome:
    | null
    | "finalized"
    | "duplicate"
    | "failed_closed"
    | "validation_failed" = null;

  /**
   * Apply a deferred-finalizer outcome to the round, the way 0050's finalizer
   * does: every terminal status also terminalizes the row, and a successful one
   * leaves a produce_sessions row behind carrying the authoritative
   * `ingest_idempotency_key` (0036) — `<session_key>:<session_generation>`.
   *
   * `options.ingestKey` overrides that identity so a test can reproduce 0050's
   * OTHER duplicate route: a content-hash match whose produce row belongs to a
   * different generation, which must NOT read as this round having been saved.
   * `null` writes no produce row at all: a status that claims success with
   * nothing behind it.
   */
  runDeferredFinalizer(
    outcome: "finalized" | "duplicate" | "failed_closed" | "validation_failed",
    target?: Row,
    options: { ingestKey?: string | null } = {},
  ): void {
    const row = target ?? (this.tables.pending_sessions ?? [])[0];
    if (!row) return;
    row.finalization_status = outcome;
    row.finalized_at = new Date().toISOString();
    row.terminalized = true;
    if (outcome !== "finalized" && outcome !== "duplicate") return;
    row.finalized_produce_session_id = "produce-session-1";
    const ingestKey =
      options.ingestKey === undefined
        ? `${row.session_key}:${row.session_generation}`
        : options.ingestKey;
    if (ingestKey === null) return;
    const existing = this.tables.produce_sessions ?? [];
    this.tables.produce_sessions = [
      ...existing,
      { id: `produce-session-${existing.length + 1}`, ingest_idempotency_key: ingestKey },
    ];
  }

  private structuredRow(args: Row): Row | undefined {
    return (this.tables.pending_sessions ?? []).find(
      (r) => r.session_key === args.p_session_key,
    );
  }

  /** Mirrors 0050 close_produce_structured_session. */
  private closeStructured(args: Row): Record<string, unknown> {
    const row = this.structuredRow(args);
    if (!row) return { accepted: false, reason: "not_found" };
    if (row.entry_origin == null) {
      return { accepted: false, reason: "not_structured" };
    }
    if (row.line_user_id !== args.p_line_user_id) {
      return { accepted: false, reason: "ownership_conflict" };
    }
    const expected = args.p_expected_session_generation ?? null;
    if (expected != null && row.session_generation !== expected) {
      return { accepted: false, reason: "generation_conflict" };
    }
    if (row.terminalized === true) {
      return { accepted: false, reason: "terminalized", session: row };
    }
    // Repeat close is a status request; the first boundary is immutable.
    if (row.close_event_timestamp_ms != null) {
      return { accepted: true, reason: "close_already_requested", session: row };
    }
    row.close_event_timestamp_ms = args.p_line_timestamp_ms;
    row.close_line_event_id = args.p_close_line_event_id;
    row.close_session_generation = row.session_generation;
    row.finalize_hold_until = new Date(Date.now() + 600_000).toISOString();
    return { accepted: true, reason: "first_close", session: row };
  }

  /** Mirrors 0050 confirm_produce_structured_finalization. */
  private confirmStructured(args: Row): Record<string, unknown> {
    const row = this.structuredRow(args);
    if (!row) return { accepted: false, reason: "not_found" };
    if (row.entry_origin == null) {
      return { accepted: false, reason: "not_structured" };
    }
    if (row.line_user_id !== args.p_line_user_id) {
      return { accepted: false, reason: "ownership_conflict" };
    }
    const expected = args.p_expected_session_generation ?? null;
    if (expected != null && row.session_generation !== expected) {
      return { accepted: false, reason: "generation_conflict" };
    }
    if (row.close_event_timestamp_ms == null) {
      return { accepted: false, reason: "not_closing" };
    }
    if (this.finalizeNotReady) {
      return {
        accepted: false,
        reason: "not_ready",
        readiness_reason: "ingest_admission_mismatch",
        admission_count: 3,
        ingest_count: 2,
        straggler_count: 1,
      };
    }
    // Redelivery of the same confirm postback is idempotent.
    const already = row.finalize_confirm_line_event_id === args.p_confirm_line_event_id;
    row.finalize_confirmed_at = row.finalize_confirmed_at ?? new Date().toISOString();
    row.finalize_confirm_line_event_id =
      row.finalize_confirm_line_event_id ?? args.p_confirm_line_event_id;
    // Releasing the hold does NOT write produce rows: the row stays
    // finalization_status='pending' until the deferred finalizer reports. A test
    // that needs a completed finalizer sets `deferredFinalizerOutcome`.
    if (this.deferredFinalizerOutcome) {
      this.runDeferredFinalizer(this.deferredFinalizerOutcome, row);
    }
    return {
      accepted: true,
      reason: already ? "already_confirmed" : "confirmed",
      session: row,
    };
  }

  /**
   * Mirrors 0049 open_or_rotate_produce_structured_session closely enough to
   * exercise Slice 3A: canonical-key check, ownership refusal, same-event
   * idempotency, optimistic concurrency, then insert-or-rotate.
   */
  private openOrRotate(args: Row): Record<string, unknown> {
    this.openProduceCalls += 1;
    const key = String(args.p_session_key ?? "");
    const user = String(args.p_line_user_id ?? "");
    const source = String(args.p_source_id ?? "");
    const event = String(args.p_opened_line_event_id ?? "");
    const expected = args.p_expected_session_generation ?? null;
    const rows = this.tables.pending_sessions ?? [];
    const existing = rows.find((r) => r.session_key === key);

    if (existing) {
      if (existing.source_id !== source) {
        return { outcome: "ownership_conflict", reason: "source_mismatch" };
      }
      if (existing.line_user_id != null && existing.line_user_id !== user) {
        return { outcome: "ownership_conflict", reason: "user_mismatch" };
      }
      if (existing.opened_line_event_id === event) {
        return {
          outcome: "idempotent",
          reason: "duplicate_open_event",
          session_key: key,
          session_generation: String(existing.session_generation),
        };
      }
      if (expected != null && existing.session_generation !== expected) {
        return { outcome: "generation_conflict", reason: "stale_generation" };
      }
    }

    const generation = `gen-${this.openProduceCalls}`;
    const row: Row = {
      session_key: key,
      source_id: source,
      line_user_id: user,
      accumulated_text: "",
      session_generation: generation,
      terminalized: false,
      close_event_timestamp_ms: null,
      ingest_revision: 0,
      finalization_status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      entry_origin: "structured_menu",
      business_date: args.p_business_date,
      transaction_time: args.p_transaction_time,
      transaction_time_source: args.p_transaction_time_source,
      staff_label: args.p_staff_label,
      market_label: args.p_market_label,
      session_kind: args.p_session_kind,
      initial_transaction_type: args.p_initial_transaction_type,
      declared_transaction_type: args.p_declared_transaction_type ?? null,
      additional_opener: args.p_additional_opener ?? null,
      opened_line_event_id: event,
    };
    this.tables.pending_sessions = existing
      ? rows.map((r) => (r.session_key === key ? row : r))
      : [...rows, row];

    return {
      outcome: existing ? "rotated" : "opened",
      reason: existing ? "rotated" : "opened",
      session_key: key,
      session_generation: generation,
    };
  }

  /** Mirrors 0057's source-wide owner decision before delegating to 0049. */
  private openGuided(args: Row): Record<string, unknown> {
    const source = String(args.p_source_id ?? "").trim();
    const user = String(args.p_line_user_id ?? "").trim();
    const date = String(args.p_business_date ?? "");
    const market = normalizedMarketLabel(
      String(args.p_market_label_normalized ?? ""),
    );
    const owners = new Set(
      (this.tables.pending_sessions ?? [])
        .filter(
          (row) =>
            row.source_id === source
            && row.business_date === date
            && row.entry_origin === "structured_menu"
            && normalizedMarketLabel(String(row.market_label ?? "")) === market,
        )
        .map((row) => String(row.line_user_id ?? "").trim()),
    );

    if (owners.has("") || owners.size > 1) {
      return { outcome: "ownership_conflict", reason: "ambiguous" };
    }
    if (owners.size === 1 && !owners.has(user)) {
      return { outcome: "ownership_conflict", reason: "other_operator" };
    }
    return this.openOrRotate(args);
  }

  /** Seed a pre-existing pending session row (e.g. an unfinished round). */
  seedPendingSession(row: Row): void {
    this.tables.pending_sessions = [
      ...(this.tables.pending_sessions ?? []).filter(
        (r) => r.session_key !== row.session_key,
      ),
      row,
    ];
  }

  private create(args: Row): Record<string, unknown> {
    const hash = String(args.p_token_hash ?? "");
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return { status: "invalid_or_expired" };
    }
    const action = String(args.p_action_type) as MenuActionType;
    const payload = (args.p_payload ?? {}) as MenuPayload;
    if (
      !payloadLooksValid(
        action,
        payload,
        this.sellers,
        this.markets,
        this.sellerMarkets,
      )
    ) {
      return { status: "invalid_or_expired" };
    }
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs(action)).toISOString();
    const state: MenuStateRow = {
      token_hash: hash,
      action_type: action,
      line_user_id: String(args.p_line_user_id),
      source_type: String(args.p_source_type),
      source_id: String(args.p_source_id),
      session_key:
        args.p_session_key === undefined || args.p_session_key === null
          ? null
          : String(args.p_session_key),
      payload,
      created_at: createdAt,
      expires_at: expiresAt,
      consumed_at: null,
      consumed_line_event_id: null,
      result: null,
    };
    this.states.push(state);
    this.tables.line_menu_states = [...this.states] as unknown as Row[];
    return {
      status: "created",
      action_type: action,
      created_at: createdAt,
      expires_at: expiresAt,
    };
  }

  private consume(args: Row): Record<string, unknown> {
    const hash = String(args.p_token_hash);
    const eventId = String(args.p_line_event_id);
    const row = this.states.find((s) => s.token_hash === hash);
    if (!row) return { status: "invalid_or_expired" };
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return { status: "invalid_or_expired" };
    }
    if (
      row.line_user_id !== args.p_line_user_id ||
      row.source_type !== args.p_source_type ||
      row.source_id !== args.p_source_id ||
      (row.session_key ?? null) !== (args.p_session_key ?? null)
    ) {
      return { status: "invalid_or_expired" };
    }
    if (
      !payloadLooksValid(
        row.action_type,
        row.payload,
        this.sellers,
        this.markets,
        this.sellerMarkets,
      )
    ) {
      return { status: "invalid_or_expired" };
    }
    if (row.consumed_at) {
      if (row.consumed_line_event_id === eventId) {
        return {
          status: "replay",
          action_type: row.action_type,
          payload: row.payload,
          result: row.result,
        };
      }
      // Different-event already_consumed: redact action/payload/result.
      return { status: "already_consumed" };
    }
    row.consumed_at = new Date().toISOString();
    row.consumed_line_event_id = eventId;
    return {
      status: "consumed",
      action_type: row.action_type,
      payload: row.payload,
    };
  }

  private record(args: Row): Record<string, unknown> {
    const hash = String(args.p_token_hash);
    const eventId = String(args.p_consumed_line_event_id);
    const row = this.states.find((s) => s.token_hash === hash);
    if (
      !row ||
      row.consumed_line_event_id !== eventId ||
      row.line_user_id !== args.p_line_user_id ||
      row.source_type !== args.p_source_type ||
      row.source_id !== args.p_source_id ||
      (row.session_key ?? null) !== (args.p_session_key ?? null)
    ) {
      return { status: "invalid_or_expired" };
    }
    const incoming = args.p_result as Record<string, unknown>;
    if (row.result) {
      if (JSON.stringify(row.result) === JSON.stringify(incoming)) {
        return { status: "replay", result: row.result };
      }
      return { status: "result_conflict", result: row.result };
    }
    row.result = incoming;
    return { status: "recorded", result: row.result };
  }
}
