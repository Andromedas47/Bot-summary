import { describe, expect, it } from "bun:test";
import {
  PendingSessionService,
  PendingSessionGenerationConflictError,
  type PendingSession,
} from "./pending-session-service";
import { WebhookService, findProduceSessionHeader, hasSessionStart } from "./webhook-service";
import { getPendingSessionKey } from "./verify";
import type { LineMessageEvent } from "./types";

type Row = Record<string, unknown>;
type QueryMode = "select" | "insert" | "update" | "delete" | "upsert";

function compareLe(a: unknown, b: unknown): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na <= nb;
  return String(a) <= String(b);
}

function compareGe(a: unknown, b: unknown): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na >= nb;
  return String(a) >= String(b);
}

function withPendingSessionDefaults(row: Row): Row {
  return {
    close_event_timestamp_ms: null,
    close_requested_at: null,
    close_line_event_id: null,
    close_finalize_started_at: null,
    latest_reply_token: null,
    ...row,
  };
}

class MemoryQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private returning = false;

  constructor(
    private readonly db: IdentityDatabase,
    private readonly table: string,
    private readonly mode: QueryMode,
    private readonly payload?: Row | Row[],
  ) {}

  select(): this { this.returning = true; return this; }
  eq(column: string, value: unknown): this { this.filters.push((row) => row[column] === value); return this; }
  gte(column: string, value: unknown): this { this.filters.push((row) => compareGe(row[column], value)); return this; }
  lte(column: string, value: unknown): this { this.filters.push((row) => compareLe(row[column], value)); return this; }
  order(): this { return this; }

  async single() {
    const result = this.execute();
    return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: result.error };
  }

  async maybeSingle() { return this.single(); }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | Row | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: Row[] | Row | null; error: null } {
    const rows = this.db.rows(this.table);
    const matches = () => rows.filter((row) => this.filters.every((filter) => filter(row)));

    if (this.mode === "select") return { data: matches(), error: null };

    if (this.mode === "insert" || this.mode === "upsert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const inserted = payloads.map((payload) => this.db.insert(this.table, payload, this.mode));
      return { data: this.returning ? inserted : null, error: null };
    }

    if (this.mode === "update") {
      const updated = matches();
      for (const row of updated) Object.assign(row, this.payload);
      return { data: this.returning ? updated : null, error: null };
    }

    const removed = matches();
    this.db.remove(this.table, new Set(removed));
    return { data: this.returning ? removed : null, error: null };
  }
}

class IdentityDatabase {
  private readonly tables = new Map<string, Row[]>();
  private readonly idSeq = new Map<string, number>();

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  private nextId(table: string): string {
    const next = (this.idSeq.get(table) ?? 0) + 1;
    this.idSeq.set(table, next);
    return `${table}-${next}`;
  }

  insert(table: string, payload: Row, mode: QueryMode): Row {
    const rows = this.rows(table);
    if (mode === "upsert" && table === "pending_sessions") {
      const existing = rows.find((row) => row.session_key === payload.session_key);
      if (existing) {
        Object.assign(existing, withPendingSessionDefaults(payload));
        return existing;
      }
    }

    let row: Row = { ...payload };
    if (table === "raw_messages") {
      row.id = row.id ?? this.nextId(table);
      row.created_at = row.created_at ?? new Date().toISOString();
    }
    if (table === "pending_sessions") {
      row = withPendingSessionDefaults(row);
      row.id = row.id ?? this.nextId(table);
      row.session_generation = row.session_generation ?? crypto.randomUUID();
      row.created_at = row.created_at ?? new Date().toISOString();
      row.updated_at = row.updated_at ?? new Date().toISOString();
    }
    if (table === "produce_sessions" || table === "produce_items") {
      row.id = row.id ?? this.nextId(table);
    }
    rows.push(row);
    return row;
  }

  remove(table: string, removed: Set<Row>): void {
    this.tables.set(table, this.rows(table).filter((row) => !removed.has(row)));
  }

  from = (table: string) => ({
    select: () => new MemoryQuery(this, table, "select"),
    insert: (payload: Row | Row[]) => new MemoryQuery(this, table, "insert", payload),
    upsert: (payload: Row | Row[]) => new MemoryQuery(this, table, "upsert", payload),
    update: (payload: Row) => new MemoryQuery(this, table, "update", payload),
    delete: () => new MemoryQuery(this, table, "delete"),
  });

  rpc = async (name: string, args: Row) => {
    const pending = this.rows("pending_sessions").find((row) => row.session_key === args.p_session_key);

    if (name === "admit_pending_session_event") {
      if (!pending) return { data: false, error: null };
      const expected = args.p_expected_session_generation;
      if (expected != null && pending.session_generation !== expected) {
        return { data: false, error: null };
      }
      this.insert("pending_session_admission", {
        session_key: pending.session_key,
        session_generation: pending.session_generation,
        line_event_id: args.p_line_event_id,
        line_timestamp_ms: args.p_line_timestamp_ms,
      }, "insert");
      return { data: true, error: null };
    }

    if (name === "register_pending_session_ingest") {
      if (pending) {
        this.insert("pending_session_ingest", {
          session_key: pending.session_key,
          session_generation: pending.session_generation,
          line_event_id: args.p_line_event_id,
          line_timestamp_ms: args.p_line_timestamp_ms,
          raw_text: args.p_raw_text,
        }, "insert");
      }
      return { data: null, error: null };
    }

    if (name === "append_pending_session") {
      if (!pending) return { data: [], error: null };
      const expected = args.p_expected_session_generation;
      if (expected != null && pending.session_generation !== expected) {
        return { data: [], error: null }; // generation conflict — empty set
      }
      pending.accumulated_text = `${pending.accumulated_text}\n${args.p_new_text}`;
      pending.latest_reply_token = args.p_reply_token;
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_requested_at = new Date().toISOString();
        pending.close_line_event_id = args.p_line_event_id;
      }
      this.insert("pending_session_ingest", {
        session_key: pending.session_key,
        session_generation: pending.session_generation,
        line_event_id: args.p_line_event_id,
        line_timestamp_ms: args.p_line_timestamp_ms,
        raw_text: args.p_new_text,
      }, "insert");
      return { data: [pending], error: null };
    }

    if (name === "claim_pending_close_finalize") {
      if (!pending) return { data: { claimed: false, reason: "gone" }, error: null };
      const expected = args.p_expected_session_generation;
      if (expected != null && pending.session_generation !== expected) {
        return { data: { claimed: false, reason: "generation_conflict" }, error: null };
      }
      if (pending.close_event_timestamp_ms == null) {
        return { data: { claimed: false, reason: "not_closing" }, error: null };
      }
      if (pending.close_finalize_started_at != null) {
        return { data: { claimed: false, reason: "already_claimed" }, error: null };
      }
      const admissionCount = this.rows("pending_session_admission")
        .filter((r) => r.session_generation === pending.session_generation).length;
      const ingestCount = this.rows("pending_session_ingest")
        .filter((r) => r.session_generation === pending.session_generation).length;
      if (admissionCount === 0 || admissionCount !== ingestCount) {
        return {
          data: { claimed: false, reason: "awaiting_ingest", admission_count: admissionCount, ingest_count: ingestCount },
          error: null,
        };
      }
      pending.close_finalize_started_at = new Date().toISOString();
      return {
        data: {
          claimed: true,
          session: { ...pending },
          admission_count: admissionCount,
          ingest_count: ingestCount,
        },
        error: null,
      };
    }

    throw new Error(`Unexpected RPC: ${name}`);
  };
}

let eventSequence = 0;
function textEvent(
  text: string,
  timestamp: number,
  opts: { groupId?: string; userId?: string; replyToken?: string } = {},
): LineMessageEvent {
  eventSequence += 1;
  return {
    type: "message",
    webhookEventId: `identity-event-${eventSequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: opts.groupId
      ? { type: "group", groupId: opts.groupId, userId: opts.userId }
      : { type: "user", userId: opts.userId ?? "user-1" },
    mode: "active",
    replyToken: opts.replyToken ?? `reply-${eventSequence}`,
    message: { id: `identity-message-${eventSequence}`, type: "text", text },
  } as LineMessageEvent;
}

function service(db: IdentityDatabase, repliesByToken: Map<string, string[]>) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (token, text) => {
      const list = repliesByToken.get(token) ?? [];
      list.push(text);
      repliesByToken.set(token, list);
    },
  });
}

const U1 = "user-1";
const U2 = "user-2";
const GROUP = "group-1";
const U1_HEADER = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";
const U2_HEADER = "แนน-สวนผลไม้ เบิก 30/06/2569";

describe("pending produce session — sender identity isolation (Release A)", () => {
  it("U1 and U2 in the same group get independent session keys and rows", async () => {
    const db = new IdentityDatabase();
    const replies = new Map<string, string[]>();
    const webhook = service(db, replies);

    await webhook.processEvents([
      textEvent(U1_HEADER, 1_000, { groupId: GROUP, userId: U1 }),
      textEvent(U2_HEADER, 1_001, { groupId: GROUP, userId: U2 }),
    ], "destination");

    const rows = db.rows("pending_sessions");
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.session_key).sort();
    expect(keys).toEqual([
      `group:${GROUP}:user:${U1}`,
      `group:${GROUP}:user:${U2}`,
    ].sort());
    expect(rows.find((r) => r.session_key === `group:${GROUP}:user:${U1}`)?.accumulated_text).toBe(U1_HEADER);
    expect(rows.find((r) => r.session_key === `group:${GROUP}:user:${U2}`)?.accumulated_text).toBe(U2_HEADER);

    // source_id must be the plain LINE destination (groupId) — never the
    // composite session_key — for both senders' rows.
    for (const row of rows) {
      expect(row.source_id).toBe(GROUP);
      expect(row.source_id).not.toBe(row.session_key);
    }
  });

  it("reply destination is never the composite session_key or source_id — only the original LINE replyToken is used", async () => {
    const db = new IdentityDatabase();
    const replies = new Map<string, string[]>();
    const webhook = service(db, replies);

    // Item line with no active pending session — handled entirely via
    // this.replyMessage (the injectable reply path), so it's a direct probe
    // of what value is used as the reply destination.
    const [result] = await webhook.processEvents([
      textEvent("1.ทุเรียน100บาท\n2โล", 1_000, { groupId: GROUP, userId: U1, replyToken: "u1-no-session" }),
    ], "destination");

    expect(result.parsed).toBe(false);
    const compositeKey = getPendingSessionKey({ type: "group", groupId: GROUP, userId: U1 })!;
    const tokensUsed = [...replies.keys()];
    expect(tokensUsed).toEqual(["u1-no-session"]);
    for (const token of tokensUsed) {
      expect(token).not.toBe(compositeKey);
      expect(token).not.toBe(GROUP); // never the plain source_id/destination either
    }
  });

  it("interleaved header/item/close traffic never leaks text, reply token, or metadata across senders", async () => {
    const db = new IdentityDatabase();
    const replies = new Map<string, string[]>();
    const webhook = service(db, replies);

    const results = await webhook.processEvents([
      textEvent(U1_HEADER, 1_000, { groupId: GROUP, userId: U1, replyToken: "u1-header" }),
      textEvent(U2_HEADER, 1_001, { groupId: GROUP, userId: U2, replyToken: "u2-header" }),
      textEvent("1.ทุเรียน100บาท\n2โล", 2_000, { groupId: GROUP, userId: U1, replyToken: "u1-item" }),
      textEvent("1.มะม่วง50บาท\n3โล", 2_001, { groupId: GROUP, userId: U2, replyToken: "u2-item" }),
      textEvent("จบรายการเบิก", 3_000, { groupId: GROUP, userId: U1, replyToken: "u1-close" }),
      textEvent("จบรายการเบิก", 3_001, { groupId: GROUP, userId: U2, replyToken: "u2-close" }),
    ], "destination");

    expect(results.filter((r) => r.parsed).length).toBe(2);

    const sessions = db.rows("produce_sessions");
    expect(sessions).toHaveLength(2);
    const items = db.rows("produce_items");
    expect(items).toHaveLength(2);

    const u1Session = sessions.find((s) => s.sender_name === "โอม" || s.staff_name === "โอม");
    const u2Session = sessions.find((s) => s.sender_name === "แนน" || s.staff_name === "แนน");
    expect(u1Session).toBeTruthy();
    expect(u2Session).toBeTruthy();

    const u1Item = items.find((i) => i.session_id === u1Session!.id);
    const u2Item = items.find((i) => i.session_id === u2Session!.id);
    expect(u1Item?.product_name).toBe("ทุเรียน");
    expect(u2Item?.product_name).toBe("มะม่วง");

    // Confirm no cross-sender reply-token or pending row survives.
    expect(db.rows("pending_sessions")).toHaveLength(0);
  });

  it("rejects a group event without userId — no pending session mutation", async () => {
    const db = new IdentityDatabase();
    const replies = new Map<string, string[]>();
    const webhook = service(db, replies);

    const event = {
      type: "message",
      webhookEventId: "no-user-event",
      deliveryContext: { isRedelivery: false },
      timestamp: 1_000,
      source: { type: "group", groupId: GROUP }, // no userId
      mode: "active",
      replyToken: "no-user-reply",
      message: { id: "no-user-message", type: "text", text: U1_HEADER },
    } as unknown as LineMessageEvent;

    const [result] = await webhook.processEvents([event], "destination");

    expect(result.status).toBe("saved");
    expect(db.rows("pending_sessions")).toHaveLength(0);
    expect(db.rows("pending_session_ingest")).toHaveLength(0);
    expect(db.rows("pending_session_admission")).toHaveLength(0);
  });

  it("parser-failed U1 generation is terminalized: item-only retry is rejected, no old text leaks", async () => {
    const db = new IdentityDatabase();
    const replies = new Map<string, string[]>();
    const webhook = service(db, replies);

    // Header + a malformed item line that will fail validation/parse (missing unit).
    await webhook.processEvents([
      textEvent(U1_HEADER, 1_000, { groupId: GROUP, userId: U1, replyToken: "u1-header" }),
      textEvent("รายการพัง", 2_000, { groupId: GROUP, userId: U1, replyToken: "u1-bad" }),
    ], "destination");

    await webhook.processEvents([
      textEvent("จบรายการเบิก", 3_000, { groupId: GROUP, userId: U1, replyToken: "u1-close" }),
    ], "destination");

    // The failed generation must have been deleted — no row survives to be
    // appended into by a later item-only message.
    expect(db.rows("pending_sessions")).toHaveLength(0);
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.rows("produce_items")).toHaveLength(0);

    const [itemOnlyResult] = await webhook.processEvents([
      textEvent("1.ทุเรียน100บาท\n2โล", 4_000, { groupId: GROUP, userId: U1, replyToken: "u1-retry" }),
    ], "destination");

    expect(itemOnlyResult.parsed).toBe(false);
    expect(db.rows("pending_sessions")).toHaveLength(0); // still no session created
    expect(replies.get("u1-retry")?.[0]).toContain("หัวรายการใหม่");
  });

  it("a valid header after a failed generation creates a clean generation with no old error/text", async () => {
    const db = new IdentityDatabase();
    const replies = new Map<string, string[]>();
    const webhook = service(db, replies);

    await webhook.processEvents([
      textEvent(U1_HEADER, 1_000, { groupId: GROUP, userId: U1, replyToken: "u1-header" }),
      textEvent("รายการพัง", 2_000, { groupId: GROUP, userId: U1, replyToken: "u1-bad" }),
    ], "destination");
    await webhook.processEvents([
      textEvent("จบรายการเบิก", 3_000, { groupId: GROUP, userId: U1, replyToken: "u1-close" }),
    ], "destination");
    expect(db.rows("pending_sessions")).toHaveLength(0);

    await webhook.processEvents([
      textEvent(U1_HEADER, 4_000, { groupId: GROUP, userId: U1, replyToken: "u1-fresh" }),
    ], "destination");

    const rows = db.rows("pending_sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0].accumulated_text).toBe(U1_HEADER);
    expect(rows[0].accumulated_text).not.toContain("รายการพัง");
  });

  it("U2 is unaffected by U1's parser failure — no shared reply/error/metadata", async () => {
    const db = new IdentityDatabase();
    const replies = new Map<string, string[]>();
    const webhook = service(db, replies);

    await webhook.processEvents([
      textEvent(U1_HEADER, 1_000, { groupId: GROUP, userId: U1, replyToken: "u1-header" }),
      textEvent("รายการพัง", 2_000, { groupId: GROUP, userId: U1, replyToken: "u1-bad" }),
    ], "destination");
    await webhook.processEvents([
      textEvent("จบรายการเบิก", 3_000, { groupId: GROUP, userId: U1, replyToken: "u1-close" }),
    ], "destination");

    // U2 opens and closes cleanly in the same group — must succeed independently.
    const results = await webhook.processEvents([
      textEvent(U2_HEADER, 4_000, { groupId: GROUP, userId: U2, replyToken: "u2-header" }),
      textEvent("1.มะม่วง50บาท\n1โล", 5_000, { groupId: GROUP, userId: U2, replyToken: "u2-item" }),
      textEvent("จบรายการเบิก", 6_000, { groupId: GROUP, userId: U2, replyToken: "u2-close" }),
    ], "destination");

    expect(results.at(-1)?.parsed).toBe(true);
    expect(replies.has("u1-bad")).toBe(false); // U2 never received U1's failure reply
    const sessions = db.rows("produce_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].staff_name).toBe("แนน");
    expect(db.rows("produce_items")).toHaveLength(1);
  });

  it("header-predicate consistency: creation and rotation accept the same header forms", () => {
    const sampleHeaders = [
      "พี่ปลา-ราชพฤกษ์ คืน 29/5/2569",
      "น้อย-วัดตะกล่ำ เบิก 29/5/2569",
      "น้อย-วัดตะกล่ำ เสีย 29/5/2569",
      "เบิก 29/5/2569",
      "รายการชั่งคืน",
    ];
    for (const header of sampleHeaders) {
      expect(hasSessionStart(header)).toBe(true);
      expect(findProduceSessionHeader(header)).not.toBeNull();
    }

    const nonHeaders = ["จบรายการคืน", "ดีครับ", "1.ทุเรียน100บาท"];
    for (const line of nonHeaders) {
      expect(findProduceSessionHeader(line)).toBeNull();
    }
  });

  it("stale read then concurrent rotation: stale append is rejected with an explicit generation conflict", async () => {
    const db = new IdentityDatabase();
    const sessionKey = getPendingSessionKey({ type: "group", groupId: GROUP, userId: U1 })!;
    db.insert("pending_sessions", {
      session_key: sessionKey,
      source_id: GROUP,
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accumulated_text: U1_HEADER,
      line_user_id: U1,
    }, "insert");

    const service = new PendingSessionService(db as never);
    // Simulate a concurrent rotation changing the generation after this
    // caller's stale read.
    const rows = db.rows("pending_sessions");
    (rows[0] as Row).session_generation = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await expect(
      service.append(sessionKey, "1.ทุเรียน100บาท\n1โล", null, "evt-1", 2_000, false,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ).rejects.toThrow(PendingSessionGenerationConflictError);

    await expect(
      service.admit(sessionKey, "evt-1", 2_000, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ).rejects.toThrow(PendingSessionGenerationConflictError);
  });

  it("raw-message reconstruction is scoped by source_id AND sender — never mixes senders in the same group", async () => {
    const db = new IdentityDatabase();
    const now = Date.now();
    const header = U1_HEADER;

    // Seed raw_messages for two senders sharing the same group source_id.
    db.insert("raw_messages", {
      source_id: GROUP, user_id: U1, message_type: "text",
      raw_text: header, line_event_id: "u1-header",
      created_at: new Date(now).toISOString(),
      payload: { timestamp: now },
    }, "insert");
    db.insert("raw_messages", {
      source_id: GROUP, user_id: U1, message_type: "text",
      raw_text: "1.ทุเรียน100บาท\n2โล", line_event_id: "u1-item",
      created_at: new Date(now + 1000).toISOString(),
      payload: { timestamp: now + 1000 },
    }, "insert");
    db.insert("raw_messages", {
      source_id: GROUP, user_id: U2, message_type: "text",
      raw_text: "1.มะม่วง50บาท\n1โล", line_event_id: "u2-item",
      created_at: new Date(now + 1500).toISOString(),
      payload: { timestamp: now + 1500 },
    }, "insert");
    db.insert("raw_messages", {
      source_id: GROUP, user_id: U1, message_type: "text",
      raw_text: "จบรายการเบิก", line_event_id: "u1-close",
      created_at: new Date(now + 2000).toISOString(),
      payload: { timestamp: now + 2000 },
    }, "insert");

    const service = new PendingSessionService(db as never);
    const session: PendingSession = {
      id: "pending-1",
      session_key: `group:${GROUP}:user:${U1}`,
      source_id: GROUP,
      session_generation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      accumulated_text: header,
      latest_reply_token: null,
      line_user_id: U1,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      close_event_timestamp_ms: now + 2000,
      close_requested_at: new Date(now + 2000).toISOString(),
      close_line_event_id: "u1-close",
      close_finalize_started_at: null,
    };

    const rebuilt = await service.rebuildForFinalization(session, now + 2000);
    expect(rebuilt).toContain("ทุเรียน");
    expect(rebuilt).not.toContain("มะม่วง"); // U2's item must never leak into U1's reconstruction
  });

  it("legacy bare-key pending row is unreachable by the new composite-key lookup", async () => {
    const db = new IdentityDatabase();
    // Simulates a pre-rollout row using the old bare-source-id key format.
    db.insert("pending_sessions", {
      session_key: GROUP, // legacy bare key — no group:/room:/dm: prefix
      source_id: GROUP,
      accumulated_text: "old malformed accumulated text",
      line_user_id: U1,
    }, "insert");

    const replies = new Map<string, string[]>();
    const webhook = service(db, replies);
    await webhook.processEvents([
      textEvent(U1_HEADER, 1_000, { groupId: GROUP, userId: U1, replyToken: "u1-fresh" }),
    ], "destination");

    const rows = db.rows("pending_sessions");
    // A brand new composite-keyed row is created; the legacy row is untouched
    // and never looked up or appended into.
    const legacyRow = rows.find((r) => r.session_key === GROUP);
    const freshRow = rows.find((r) => r.session_key === `group:${GROUP}:user:${U1}`);
    expect(legacyRow?.accumulated_text).toBe("old malformed accumulated text");
    expect(freshRow?.accumulated_text).toBe(U1_HEADER);
  });
});
