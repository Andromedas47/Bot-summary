/**
 * P1 2026-08-22 — stale close-validation race and terminalized-review UX.
 *
 * Reproduces the Production จ๋า-ราชพฤก close: the gate validated revision N,
 * a concurrent pre-close ingest moved the row to N+1, and close mutation
 * still stamped the boundary. Also covers terminalized second-close reviews
 * and duplicate vs distinct close confirmation.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";

type Row = Record<string, unknown>;

const SESSION_KEY = "group:group-1:user:user-1";
const GENERATION = "4bbe8461-f8b0-481f-8d31-fec65a81e1ea";
const ROUND = "11111111-1111-4111-8111-111111111111";
const CLOSE_REVISION_CHANGED_REPLY = [
  "มีรายการเข้ามาเพิ่มระหว่างตรวจสอบ",
  'กรุณากด "จบรายการ" อีกครั้งเพื่อให้ระบบตรวจรายการล่าสุด',
].join("\n");
const STALE_PRODUCE_SESSION_REPLY =
  "พบรายการเดิมที่ยังปิดไม่สมบูรณ์ กรุณาให้ทีมงานเคลียร์รายการเดิมก่อนเริ่มรายการใหม่";
const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";

interface Review {
  digest: string;
  presented_line_event_id: string;
  confirmed_at: string | null;
  confirmed_line_event_id?: string | null;
}

class RaceDatabase {
  reviews: Review[] = [];
  admitted = new Set<string>();
  concurrentIngestOnClose = false;
  tables: Record<string, Row[]> = {
    pending_sessions: [],
    produce_transactions: [],
    raw_messages: [],
  };
  bindOutcome: Row = { outcome: "bound", accountability_round_id: ROUND };

  constructor(pending: Row, master: Row[] = []) {
    this.tables.pending_sessions = [pending];
    this.tables.produce_transactions = master;
  }

  get pending(): Row {
    return this.tables.pending_sessions[0]!;
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const source = () =>
      table === "produce_entry_validation_reviews"
        ? (this.reviews as unknown as Row[])
        : this.rows(table);
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      limit: () => builder,
      order: () => builder,
      maybeSingle: async () => ({
        data: source().filter((row) => filters.every((f) => f(row)))[0] ?? null,
        error: null,
      }),
      single: async () => ({
        data: source().filter((row) => filters.every((f) => f(row)))[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({
          data: source().filter((row) => filters.every((f) => f(row))),
          error: null,
        }).then(resolve),
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
    };
    return builder;
  }

  rpc = async (name: string, args: Row) => {
    if (name === "bind_plain_text_accountability_round") {
      return { data: this.bindOutcome, error: null };
    }
    if (name === "record_produce_validation_review") {
      if (this.pending.terminalized) {
        return {
          data: {
            recorded: false,
            reason: "terminalized",
            confirmed: false,
            presented_line_event_id: args.p_line_event_id,
          },
          error: null,
        };
      }
      const digest = args.p_validation_digest as string;
      let review = this.reviews.find((r) => r.digest === digest);
      if (!review) {
        review = {
          digest,
          presented_line_event_id: args.p_line_event_id as string,
          confirmed_at: null,
        };
        this.reviews.push(review);
      }
      return {
        data: {
          recorded: true,
          confirmed: review.confirmed_at !== null,
          presented_line_event_id: review.presented_line_event_id,
        },
        error: null,
      };
    }
    if (name === "confirm_produce_validation_review") {
      if (this.pending.terminalized) {
        return { data: { status: "terminalized" }, error: null };
      }
      const review = this.reviews.find((r) => r.digest === args.p_validation_digest);
      if (!review) return { data: { status: "not_found" }, error: null };
      if (review.confirmed_at) return { data: { status: "already_confirmed" }, error: null };
      review.confirmed_at = new Date().toISOString();
      review.confirmed_line_event_id = args.p_line_event_id as string;
      return { data: { status: "confirmed" }, error: null };
    }
    if (name === "mark_plain_text_close_refused") {
      return { data: { marked: true }, error: null };
    }
    if (name === "resume_pending_close_finalization") {
      if (this.pending.terminalized) {
        return { data: { accepted: false, reason: "terminalized" }, error: null };
      }
      this.pending.next_attempt_at = new Date().toISOString();
      return { data: { accepted: true, reason: "resumed", session: this.pending }, error: null };
    }
    if (name === "append_pending_session") {
      const pending = this.pending;
      const eventId = args.p_line_event_id as string | null;
      if (pending.terminalized) {
        return { data: { accepted: false, reason: "terminalized", session: pending }, error: null };
      }
      if (
        args.p_expected_session_generation != null
        && pending.session_generation !== args.p_expected_session_generation
      ) {
        return { data: { accepted: false, reason: "generation_conflict" }, error: null };
      }
      if (eventId && this.admitted.has(eventId)) {
        return { data: { accepted: true, reason: "duplicate_event", session: pending }, error: null };
      }
      if (pending.close_event_timestamp_ms != null && args.p_mark_close) {
        return {
          data: { accepted: true, reason: "close_already_requested", session: pending },
          error: null,
        };
      }
      if (
        args.p_mark_close
        && pending.close_event_timestamp_ms == null
        && this.concurrentIngestOnClose
      ) {
        pending.ingest_revision = Number(pending.ingest_revision ?? 0) + 1;
      }
      if (
        args.p_mark_close
        && pending.close_event_timestamp_ms == null
        && args.p_expected_ingest_revision != null
        && Number(pending.ingest_revision) !== Number(args.p_expected_ingest_revision)
      ) {
        return {
          data: {
            accepted: false,
            reason: "stale_validation_snapshot",
            current_revision: pending.ingest_revision,
            session: pending,
          },
          error: null,
        };
      }
      if (eventId) this.admitted.add(eventId);
      pending.accumulated_text = `${pending.accumulated_text}\n${args.p_new_text}`;
      pending.ingest_revision = Number(pending.ingest_revision ?? 0) + 1;
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_line_event_id = args.p_line_event_id;
        pending.close_session_generation = pending.session_generation;
        pending.close_requested_at = new Date().toISOString();
        pending.next_attempt_at = new Date(Date.now() + 8_000).toISOString();
      }
      return {
        data: {
          accepted: true,
          reason: args.p_mark_close ? "first_close" : "appended",
          session: pending,
        },
        error: null,
      };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };
}

function pendingRow(overrides: Partial<Row> = {}): Row {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    session_generation: GENERATION,
    accumulated_text: ["จ๋า-ราชพฤก เบิก 22/8/2569", "1.มังคุด45บาท", "10โล"].join("\n"),
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
    ingest_revision: 4,
    accountability_round_id: ROUND,
    entry_origin: null,
    ...overrides,
  };
}

function textEvent(text: string, eventId: string, timestamp = Date.now()): LineMessageEvent {
  return {
    type: "message",
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    replyToken: `reply-${eventId}`,
    webhookEventId: eventId,
    message: { id: `msg-${eventId}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function build(db: RaceDatabase, replies: string[]) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
  });
}

const SUSPICIOUS = ["จ๋า-ราชพฤก เบิก 22/8/2569", "25อะโวคาโด้70บาท", "19.4โล"].join("\n");

describe("TEST 1 — stale revision at first close", () => {
  it("rejects the close atomically, does not stamp a boundary, and asks for a fresh จบรายการ", async () => {
    const db = new RaceDatabase(pendingRow({ ingest_revision: 4 }));
    db.concurrentIngestOnClose = true;
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-stale")], "dest");

    expect(replies).toEqual([CLOSE_REVISION_CHANGED_REPLY]);
    expect(db.pending.close_event_timestamp_ms).toBeNull();
    expect(db.pending.close_line_event_id).toBeNull();
    expect(db.pending.terminalized).toBe(false);
    expect(db.pending.ingest_revision).toBe(5);
    expect(db.reviews).toHaveLength(0);
  });
});

describe("TEST 5 — terminalized generation must not grow a review", () => {
  it("replies stale-session and records nothing when another จบรายการ arrives", async () => {
    const db = new RaceDatabase(pendingRow({
      accumulated_text: SUSPICIOUS,
      terminalized: true,
      close_event_timestamp_ms: 1787394325632,
      close_line_event_id: "01M0MG1ZGK24NMV5NY3CP58Y6F",
      close_session_generation: GENERATION,
    }));
    const replies: string[] = [];
    await build(db, replies).processEvents(
      [textEvent("จบรายการ", "01M0MG3F3HBD3AG74CNREPR3J4")],
      "dest",
    );

    expect(replies).toEqual([STALE_PRODUCE_SESSION_REPLY]);
    expect(db.reviews).toHaveLength(0);
  });
});

describe("TEST 6 / 7 — duplicate close vs distinct confirmation", () => {
  it("the presenting close event id cannot confirm its own review", async () => {
    const db = new RaceDatabase(pendingRow({ accumulated_text: SUSPICIOUS }));
    const replies: string[] = [];
    const service = build(db, replies);
    await service.processEvents([textEvent("จบรายการเบิก", "close-1")], "dest");
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0].confirmed_at).toBeNull();
    expect(db.pending.close_event_timestamp_ms).toBeNull();

    await service.processEvents([textEvent("จบรายการเบิก", "close-1")], "dest");
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0].confirmed_at).toBeNull();
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("a distinct second close confirms the same digest and may establish the boundary", async () => {
    const db = new RaceDatabase(pendingRow({ accumulated_text: SUSPICIOUS }));
    const replies: string[] = [];
    const service = build(db, replies);
    await service.processEvents([textEvent("จบรายการเบิก", "close-1")], "dest");
    await service.processEvents([textEvent("จบรายการเบิก", "close-2")], "dest");

    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0].confirmed_at).not.toBeNull();
    expect(db.reviews[0].confirmed_line_event_id).toBe("close-2");
    expect(db.pending.close_line_event_id).toBe("close-2");
    expect(replies.at(-1)).toBe(PRODUCE_CLOSE_PENDING_REPLY);
  });
});

describe("post-boundary confirmation does not append จบรายการ", () => {
  it("TEST 6/7 — held generation: original close id cannot confirm; a distinct close confirms without mutating text", async () => {
    const originalClose = "01M0MG1ZGK24NMV5NY3CP58Y6F";
    const originalText = SUSPICIOUS;
    const db = new RaceDatabase(pendingRow({
      accumulated_text: originalText,
      ingest_revision: 37,
      close_event_timestamp_ms: 1787394325632,
      close_line_event_id: originalClose,
      close_session_generation: GENERATION,
      close_requested_at: new Date().toISOString(),
      close_deadline_at: new Date(Date.now() + 30_000).toISOString(),
      next_attempt_at: null,
    }));
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการ", "close-after-1")], "dest");
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0].confirmed_at).toBeNull();
    db.reviews[0].presented_line_event_id = originalClose;

    await service.processEvents([textEvent("จบรายการ", originalClose)], "dest");
    expect(db.reviews[0].confirmed_at).toBeNull();
    expect(db.pending.next_attempt_at).toBeNull();

    await service.processEvents(
      [textEvent("จบรายการ", "01M0MG3F3HBD3AG74CNREPR3J4")],
      "dest",
    );
    expect(db.reviews[0].confirmed_at).not.toBeNull();
    expect(db.reviews[0].confirmed_line_event_id).toBe("01M0MG3F3HBD3AG74CNREPR3J4");
    expect(db.pending.accumulated_text).toBe(originalText);
    expect(db.pending.close_line_event_id).toBe(originalClose);
    expect(db.pending.next_attempt_at).not.toBeNull();
    expect(replies.at(-1)).toBe(PRODUCE_CLOSE_PENDING_REPLY);
  });
});
