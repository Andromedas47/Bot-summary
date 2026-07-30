/**
 * Webhook-level regression coverage for the 2026-07-30 production incident.
 *
 * Real evidence (pending_sessions row for seller กี้ / market วัดทุ่งลานนา /
 * business_date 2026-07-29, entry_origin=structured_menu):
 *
 *   accumulated_text = "\n1. แตงโม 40 บาท\n3 ลูก\n2. มะละกอ 20 บาท\n5 ลูก\nยกเลิก"
 *
 * "เมนู" reported zero captured items and "จบรายการ" listed all five raw
 * lines — including the typed "ยกเลิก" — as independent unrecognized lines.
 * See capture-multiline-reconstruction.test.ts for the parser-level (regex)
 * half of the fix. This file covers the webhook routing half: control-command
 * text must never reach the structured pending-session append.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { GuidedSessionCaptureService } from "./guided-menu/session-capture";
import { COMMAND_CONTRACT_VERSION } from "@/lib/parsers/weigh-session/seed";

type Row = Record<string, unknown>;

/** Minimal fake DB — supports the structured append/lookup path only. */
class GuidedCaptureDatabase {
  appendCalls = 0;
  admitCalls = 0;
  ingestCalls = 0;
  tables: Record<string, Row[]> = {
    pending_sessions: [],
    pending_session_admission: [],
    pending_session_ingest: [],
    raw_messages: [],
  };

  constructor(pending: Row) {
    this.tables.pending_sessions = [pending];
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  asClient() {
    return this as never;
  }

  from(table: string) {
    return {
      insert: (payload: Row) => ({
        select: () => ({
          single: async () => {
            const row = { id: `raw-${this.rows(table).length + 1}`, ...payload };
            this.tables[table] = [...this.rows(table), row];
            return { data: row, error: null };
          },
        }),
      }),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      select: () => ({
        eq: (column: string, value: unknown) => ({
          maybeSingle: async () => ({
            data: this.rows(table).find((row) => row[column] === value) ?? null,
            error: null,
          }),
          single: async () => ({
            data: this.rows(table).find((row) => row[column] === value) ?? null,
            error: null,
          }),
          limit: () => ({
            maybeSingle: async () => ({
              data: this.rows(table).find((row) => row[column] === value) ?? null,
              error: null,
            }),
          }),
        }),
      }),
    };
  }

  rpc = async (name: string, args: Row) => {
    const pending = this.rows("pending_sessions")
      .find((row) => row.session_key === args.p_session_key);

    if (name === "admit_pending_session_event") {
      this.admitCalls += 1;
      return { data: null, error: null };
    }
    if (name === "register_pending_session_ingest") {
      this.ingestCalls += 1;
      return { data: null, error: null };
    }
    if (name === "append_pending_session") {
      this.appendCalls += 1;
      if (!pending) return { data: { accepted: false, reason: "not_found" }, error: null };
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_requested_at = new Date().toISOString();
      }
      // Mirrors 0032's unconditional `accumulated_text || E'\n' || p_new_text` —
      // even an empty starting value picks up the leading "\n" (this is why the
      // real production row began with one).
      pending.accumulated_text = `${pending.accumulated_text ?? ""}\n${args.p_new_text}`;
      return { data: { accepted: true, reason: "appended", session: pending }, error: null };
    }
    throw new Error(`Unexpected RPC in this fake: ${name}`);
  };
}

const SESSION_KEY = "group:group-1:user:user-1";

function structuredPending(overrides: Row = {}): Row {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accumulated_text: "",
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: now,
    updated_at: now,
    close_event_timestamp_ms: null,
    close_requested_at: null,
    close_line_event_id: null,
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: null,
    close_deadline_at: null,
    close_session_generation: null,
    expected_item_count: null,
    ingest_revision: 0,
    entry_origin: "structured_menu",
    command_contract_version: COMMAND_CONTRACT_VERSION,
    business_date: "2026-07-29",
    transaction_time: "10:00",
    transaction_time_source: "operator_declared",
    staff_label: "กี้",
    market_label: "วัดทุ่งลานนา",
    session_kind: "main",
    initial_transaction_type: "เบิก",
    declared_transaction_type: null,
    additional_opener: null,
    opened_line_event_id: "evt-open",
    ...overrides,
  };
}

function textEvent(text: string, timestamp: number): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `evt-${timestamp}-${Math.random().toString(36).slice(2)}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: `reply-${timestamp}`,
    message: { id: `msg-${timestamp}`, type: "text", text },
  } as LineMessageEvent;
}

/** A guidedMenuHandler stub wired to a real capture service against the same fake DB. */
function makeGuidedMenuHandler(db: GuidedCaptureDatabase) {
  const capture = new GuidedSessionCaptureService(db.asClient());
  const ackCounts: number[] = [];
  return {
    handler: {
      renderCaptureAcknowledgement: async ({ identity }: { identity: never }) => {
        const snapshot = await capture.snapshot(identity);
        if (snapshot.status !== "ok" || snapshot.closeRequested) return null;
        ackCounts.push(snapshot.parsed.items.length);
        return {
          screen: "session_status",
          messages: [{ type: "text", text: `items:${snapshot.parsed.items.length}` }],
          result: { item_count: snapshot.parsed.items.length },
        };
      },
      handleTextCloseRequest: async () => ({
        screen: "session_close_requested",
        messages: [{ type: "text", text: "close-stub" }],
        result: {},
      }),
      handleTextCancelRequest: async () => ({
        screen: "session_menu_dismissed",
        messages: [{ type: "text", text: "cancel-stub" }],
        result: {},
      }),
      openMenu: async () => ({
        screen: "session_status",
        messages: [{ type: "text", text: "menu-stub" }],
        result: {},
      }),
    } as never,
    ackCounts,
  };
}

describe("guided capture — production incident: multi-message append + control-command interception", () => {
  it("2/3/11. two multiline LINE messages reconstruct as two items; ack count is 1 then 2; exactly one append per real item message", async () => {
    const db = new GuidedCaptureDatabase(structuredPending());
    const { handler, ackCounts } = makeGuidedMenuHandler(db);
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: handler,
      replyApiMessages: async () => {},
      replyMessage: async () => {},
    });

    await service.processEvents(
      [textEvent("1. แตงโม 40 บาท\n3 ลูก", 1_000)],
      "dest",
    );
    await service.processEvents(
      [textEvent("2. มะละกอ 20 บาท\n5 ลูก", 2_000)],
      "dest",
    );

    expect(db.appendCalls).toBe(2);
    expect(ackCounts).toEqual([1, 2]);

    const [row] = db.rows("pending_sessions");
    expect(row!.accumulated_text).toBe(
      "\n1. แตงโม 40 บาท\n3 ลูก\n2. มะละกอ 20 บาท\n5 ลูก",
    );

    const capture = new GuidedSessionCaptureService(db.asClient());
    const snapshot = await capture.snapshot({
      lineUserId: "user-1",
      sourceType: "group",
      sourceId: "group-1",
      sessionKey: SESSION_KEY,
    });
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") return;
    expect(snapshot.parsed.parse_errors).toEqual([]);
    expect(snapshot.parsed.items).toHaveLength(2);
  });

  it("5. เมนู is intercepted before append — never becomes produce data", async () => {
    const db = new GuidedCaptureDatabase(
      structuredPending({ accumulated_text: "\n1. แตงโม 40 บาท\n3 ลูก" }),
    );
    const { handler } = makeGuidedMenuHandler(db);
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: handler,
      replyApiMessages: async () => {},
      replyMessage: async () => {},
    });

    await service.processEvents([textEvent("เมนู", 3_000)], "dest");

    expect(db.appendCalls).toBe(0);
    const [row] = db.rows("pending_sessions");
    expect(row!.accumulated_text).toBe("\n1. แตงโม 40 บาท\n3 ลูก");
  });

  it("6. จบรายการ is intercepted before append on a structured_menu session", async () => {
    const db = new GuidedCaptureDatabase(
      structuredPending({ accumulated_text: "\n1. แตงโม 40 บาท\n3 ลูก" }),
    );
    const { handler } = makeGuidedMenuHandler(db);
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: handler,
      replyApiMessages: async () => {},
      replyMessage: async () => {},
    });

    await service.processEvents([textEvent("จบรายการ", 4_000)], "dest");

    expect(db.appendCalls).toBe(0);
    const [row] = db.rows("pending_sessions");
    expect(row!.accumulated_text).toBe("\n1. แตงโม 40 บาท\n3 ลูก");
  });

  it("7. ยกเลิก is intercepted before append — the exact production corruption is now prevented", async () => {
    const db = new GuidedCaptureDatabase(
      structuredPending({
        accumulated_text:
          "\n1. แตงโม 40 บาท\n3 ลูก\n2. มะละกอ 20 บาท\n5 ลูก",
      }),
    );
    const { handler } = makeGuidedMenuHandler(db);
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: handler,
      replyApiMessages: async () => {},
      replyMessage: async () => {},
    });

    await service.processEvents([textEvent("ยกเลิก", 5_000)], "dest");

    expect(db.appendCalls).toBe(0);
    const [row] = db.rows("pending_sessions");
    expect(row!.accumulated_text).toBe(
      "\n1. แตงโม 40 บาท\n3 ลูก\n2. มะละกอ 20 บาท\n5 ลูก",
    );
    expect(String(row!.accumulated_text)).not.toContain("ยกเลิก");
  });

  it("8. ออกจากเมนู is intercepted before append", async () => {
    const db = new GuidedCaptureDatabase(
      structuredPending({ accumulated_text: "\n1. แตงโม 40 บาท\n3 ลูก" }),
    );
    const { handler } = makeGuidedMenuHandler(db);
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: handler,
      replyApiMessages: async () => {},
      replyMessage: async () => {},
    });

    await service.processEvents([textEvent("ออกจากเมนู", 6_000)], "dest");

    expect(db.appendCalls).toBe(0);
    const [row] = db.rows("pending_sessions");
    expect(row!.accumulated_text).toBe("\n1. แตงโม 40 บาท\n3 ลูก");
    expect(String(row!.accumulated_text)).not.toContain("ออกจากเมนู");
  });

  it("11. no duplicate writes — control-command messages interleaved with real items append exactly once each", async () => {
    const db = new GuidedCaptureDatabase(structuredPending());
    const { handler } = makeGuidedMenuHandler(db);
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: handler,
      replyApiMessages: async () => {},
      replyMessage: async () => {},
    });

    await service.processEvents([textEvent("1. แตงโม 40 บาท\n3 ลูก", 1_000)], "dest");
    await service.processEvents([textEvent("เมนู", 1_500)], "dest");
    await service.processEvents([textEvent("2. มะละกอ 20 บาท\n5 ลูก", 2_000)], "dest");
    await service.processEvents([textEvent("ยกเลิก", 2_500)], "dest");

    expect(db.appendCalls).toBe(2);
    const [row] = db.rows("pending_sessions");
    expect(row!.accumulated_text).toBe(
      "\n1. แตงโม 40 บาท\n3 ลูก\n2. มะละกอ 20 บาท\n5 ลูก",
    );
  });
});
