import { describe, expect, it } from "bun:test";
import {
  WebhookService,
  STRUCTURED_TEXT_CLOSE_REFUSED_REPLY,
} from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { COMMAND_CONTRACT_VERSION } from "@/lib/parsers/weigh-session/seed";

type Row = Record<string, unknown>;

class StructuredCloseDatabase {
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

  from(table: string) {
    return {
      insert: (payload: Row) => {
        return {
          select: () => {
            return {
              single: async () => {
                const row = { id: `raw-${this.rows(table).length + 1}`, ...payload };
                this.tables[table] = [...this.rows(table), row];
                return { data: row, error: null };
              },
            };
          },
        };
      },
      update: () => {
        return {
          eq: () => Promise.resolve({ data: null, error: null }),
        };
      },
      select: () => {
        return {
          eq: (column: string, value: unknown) => {
            return {
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
            };
          },
        };
      },
    };
  }

  rpc = async (name: string, args: Row) => {
    const pending = this.rows("pending_sessions")
      .find((row) => row.session_key === args.p_session_key);

    // No accountability_rounds in this double: the honest answer is that the
    // document has no round to join, which is legacy-unbound behaviour.
    if (name === "bind_plain_text_accountability_round") {
      return { data: { outcome: "no_round" }, error: null };
    }

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
      if (!pending) {
        return { data: { accepted: false, reason: "not_found" }, error: null };
      }
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_requested_at = new Date().toISOString();
        pending.close_line_event_id = args.p_line_event_id;
        pending.close_session_generation = pending.session_generation;
        pending.close_deadline_at = new Date(Date.now() + 30_000).toISOString();
        pending.next_attempt_at = new Date(Date.now() + 8_000).toISOString();
      }
      pending.accumulated_text = `${pending.accumulated_text}\n${args.p_new_text}`;
      return { data: { accepted: true, reason: "appended", session: pending }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };
}

const SESSION_KEY = "group:group-1:user:user-1";
const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";

function basePending(overrides: Row = {}): Row {
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
    ...overrides,
  };
}

function structuredPending(overrides: Row = {}): Row {
  return basePending({
    entry_origin: "structured_menu",
    command_contract_version: COMMAND_CONTRACT_VERSION,
    business_date: "2026-07-28",
    transaction_time: "09:15",
    transaction_time_source: "operator_declared",
    staff_label: "พี่ดำ",
    market_label: "วิหาร",
    session_kind: "main",
    initial_transaction_type: "เบิก",
    declared_transaction_type: null,
    additional_opener: null,
    opened_line_event_id: "evt-open",
    ...overrides,
  });
}

function textEvent(text: string, timestamp = 5_000): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `close-event-${timestamp}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: "reply-close",
    message: { id: `msg-${timestamp}`, type: "text", text },
  } as LineMessageEvent;
}

describe("0050 — executable webhook structured text close", () => {
  it("routes exact จบรายการ only when entry_origin is structured_menu", async () => {
    const db = new StructuredCloseDatabase(structuredPending());
    const apiReplies: unknown[] = [];
    const rawBefore = db.rows("raw_messages").length;
    const service = new WebhookService(db as never, {
      replyApiMessages: async (_token, messages) => {
        apiReplies.push(...messages);
      },
      guidedMenuHandler: {
        handleTextCloseRequest: async () => ({
          screen: "session_close_requested",
          messages: [
            { type: "text", text: "summary" },
            {
              type: "flex",
              altText: "ยืนยันจบรายการ",
              contents: {
                type: "bubble",
                body: { type: "box", layout: "vertical", contents: [] },
                footer: {
                  type: "box",
                  layout: "vertical",
                  contents: [
                    {
                      type: "button",
                      action: {
                        type: "postback",
                        label: "ยืนยันจบรายการ",
                        data: "gpm1:token",
                      },
                    },
                  ],
                },
              },
            },
          ],
          result: { close_reason: "first_close" },
        }),
      } as never,
    });

    await service.processEvents([textEvent("จบรายการ")], "destination");

    expect(apiReplies.length).toBeGreaterThan(0);
    expect(apiReplies.some((m) => (m as { type?: string }).type === "flex")).toBe(
      true,
    );
    expect(db.appendCalls).toBe(0);
    expect(db.admitCalls).toBe(0);
    expect(db.ingestCalls).toBe(0);
    expect(db.rows("pending_session_admission")).toHaveLength(0);
    expect(db.rows("pending_session_ingest")).toHaveLength(0);

    const [session] = db.rows("pending_sessions");
    expect(session.close_event_timestamp_ms).toBeNull();
    expect(session.close_requested_at).toBeNull();
    expect(session.finalize_hold_until ?? null).toBeNull();
    expect(session.accumulated_text).toBe("");
    expect(db.rows("raw_messages").length).toBeGreaterThanOrEqual(rawBefore);
    for (const raw of db.rows("raw_messages")) {
      expect(String(raw.raw_text ?? raw.message_text ?? "จบรายการ")).not.toMatch(
        /พี่ดำ-วิหาร/,
      );
    }
  });

  it("still refuses non-exact close phrases on structured sessions", async () => {
    const db = new StructuredCloseDatabase(structuredPending());
    const replies: string[] = [];
    const service = new WebhookService(db as never, {
      replyMessage: async (_token, text) => {
        replies.push(text);
      },
    });

    await service.processEvents([textEvent("จบรายการ 1 รายการ")], "destination");

    expect(replies).toEqual([STRUCTURED_TEXT_CLOSE_REFUSED_REPLY]);
    expect(db.appendCalls).toBe(0);
  });

  it("does not route exact จบรายการ into Guided close for a non-menu structured origin", async () => {
    const db = new StructuredCloseDatabase(
      structuredPending({ entry_origin: "other_structured" }),
    );
    let guidedCloseCalls = 0;
    const replies: string[] = [];
    const service = new WebhookService(db as never, {
      replyMessage: async (_token, text) => {
        replies.push(text);
      },
      guidedMenuHandler: {
        handleTextCloseRequest: async () => {
          guidedCloseCalls += 1;
          return {
            screen: "session_close_requested",
            messages: [{ type: "text", text: "should-not-send" }],
            result: {},
          };
        },
      } as never,
    });

    await service.processEvents([textEvent("จบรายการ")], "destination");

    expect(guidedCloseCalls).toBe(0);
    expect(replies).toEqual([STRUCTURED_TEXT_CLOSE_REFUSED_REPLY]);
    expect(db.appendCalls).toBe(0);
  });

  it("capture acknowledgement routing requires entry_origin structured_menu", async () => {
    const source = await Bun.file(new URL("./webhook-service.ts", import.meta.url)).text();
    const ackIdx = source.indexOf("guided capture acknowledgement sent");
    expect(ackIdx).toBeGreaterThan(-1);
    const window = source.slice(Math.max(0, ackIdx - 800), ackIdx);
    expect(window).toContain('entry_origin === "structured_menu"');
    expect(window).not.toContain("entry_origin != null");
  });

  it("keeps legacy plain-text จบรายการ close behavior unchanged", async () => {
    const db = new StructuredCloseDatabase(basePending({
      accumulated_text: "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569\n1.ทุเรียน100บาท\n1โล",
      entry_origin: null,
    }));
    const replies: string[] = [];
    const service = new WebhookService(db as never, {
      replyMessage: async (_token, text) => { replies.push(text); },
    });

    await service.processEvents([textEvent("จบรายการ")], "destination");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.appendCalls).toBe(1);
    const [session] = db.rows("pending_sessions");
    expect(session.close_event_timestamp_ms).toBe(5_000);
    expect(session.close_requested_at).not.toBeNull();
  });
});
