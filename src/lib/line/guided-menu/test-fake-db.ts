/**
 * In-memory double for Guided Menu Slice 2 unit/webhook tests.
 * Implements create/consume/record RPC semantics used by GuidedMenuStateService.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { hashMenuTokenWire } from "./menu-token";
import type { MenuActionType, MenuPayload } from "./menu-state-types";

type OperatorRow = {
  line_user_id: string;
  staff_label: string;
  active: boolean;
};

type MenuStateRow = {
  token_hash: string;
  action_type: MenuActionType;
  line_user_id: string;
  source_type: string;
  source_id: string;
  session_key: string | null;
  payload: MenuPayload;
  expires_at: string;
  consumed_at: string | null;
  consumed_line_event_id: string | null;
  result: Record<string, unknown> | null;
};

type Row = Record<string, unknown>;

export class GuidedMenuFakeDatabase {
  operators: OperatorRow[] = [];
  states: MenuStateRow[] = [];
  /** wireToken → hash, populated on insert via service (we track from hash only). */
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
  };

  seedOperator(row: OperatorRow): void {
    this.operators = this.operators.filter((o) => o.line_user_id !== row.line_user_id);
    this.operators.push(row);
    this.tables.line_operator_identities = [...this.operators];
  }

  /** Resolve stored state by wire token (tests only). */
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
        if (table === "line_menu_states") {
          for (const row of rows) {
            const state: MenuStateRow = {
              token_hash: String(row.token_hash),
              action_type: row.action_type as MenuActionType,
              line_user_id: String(row.line_user_id),
              source_type: String(row.source_type),
              source_id: String(row.source_id),
              session_key:
                row.session_key === undefined || row.session_key === null
                  ? null
                  : String(row.session_key),
              payload: (row.payload ?? {}) as MenuPayload,
              expires_at: String(row.expires_at),
              consumed_at: null,
              consumed_line_event_id: null,
              result: null,
            };
            this.states.push(state);
            this.tables.line_menu_states = [...this.states] as unknown as Row[];
          }
          return {
            select: () => ({
              single: async () => ({ data: rows[0], error: null }),
            }),
          };
        }
        if (table === "raw_messages") {
          const row: Row = {
            id: `raw-${this.tables.raw_messages.length + 1}`,
            ...rows[0],
          };
          // Duplicate event id → 23505
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
        return {
          eq: (column: string, value: unknown) => ({
            maybeSingle: async () => {
              if (table === "line_operator_identities") {
                const data =
                  this.operators.find((o) => (o as Row)[column] === value) ??
                  null;
                return { data, error: null };
              }
              const data =
                (this.tables[table] ?? []).find((r) => r[column] === value) ??
                null;
              return { data, error: null };
            },
            single: async () => {
              const data =
                (this.tables[table] ?? []).find((r) => r[column] === value) ??
                null;
              return { data, error: null };
            },
            limit: () => ({
              maybeSingle: async () => {
                const data =
                  (this.tables[table] ?? []).find((r) => r[column] === value) ??
                  null;
                return { data, error: null };
              },
            }),
          }),
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
    if (name.includes("close") || name.includes("confirm")) {
      this.closeRpcCalls += 1;
    }

    if (name === "consume_line_menu_state") {
      return { data: this.consume(args), error: null };
    }
    if (name === "record_line_menu_state_result") {
      return { data: this.record(args), error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };

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
    if (row.consumed_at) {
      if (row.consumed_line_event_id === eventId) {
        return {
          status: "replay",
          action_type: row.action_type,
          payload: row.payload,
          result: row.result,
        };
      }
      return {
        status: "already_consumed",
        action_type: row.action_type,
        payload: row.payload,
        result: row.result,
      };
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
    if (!row || row.consumed_line_event_id !== eventId) {
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
