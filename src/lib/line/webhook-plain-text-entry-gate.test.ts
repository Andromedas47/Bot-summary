/**
 * P4A completion — the entry gate on the plain-text close, end to end through
 * the webhook.
 *
 * What matters here is the close BOUNDARY: a refused close must not write one,
 * because that is what keeps the session in capture where the corrected line is
 * still an ordinary item message and the original business date survives.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";

type Row = Record<string, unknown>;

const SESSION_KEY = "group:group-1:user:user-1";
const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUND = "11111111-1111-4111-8111-111111111111";
const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";

interface Review {
  digest: string;
  presented_line_event_id: string;
  confirmed_at: string | null;
}

class PlainTextGateDatabase {
  reviews: Review[] = [];
  tables: Record<string, Row[]> = {
    pending_sessions: [],
    produce_transactions: [],
    raw_messages: [],
  };
  /** Scripted answer for the round binding RPC. */
  bindOutcome: Row = { outcome: "bound", accountability_round_id: ROUND };

  constructor(pending: Row, master: Row[]) {
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
          confirmed: review.confirmed_at !== null,
          presented_line_event_id: review.presented_line_event_id,
        },
        error: null,
      };
    }
    if (name === "confirm_produce_validation_review") {
      const review = this.reviews.find((r) => r.digest === args.p_validation_digest);
      if (!review) return { data: { status: "not_found" }, error: null };
      if (review.confirmed_at) return { data: { status: "already_confirmed" }, error: null };
      review.confirmed_at = new Date().toISOString();
      return { data: { status: "confirmed" }, error: null };
    }
    if (name === "admit_pending_session_event" || name === "register_pending_session_ingest") {
      return { data: null, error: null };
    }
    if (name === "append_pending_session") {
      const pending = this.pending;
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_line_event_id = args.p_line_event_id;
        pending.close_session_generation = pending.session_generation;
      }
      pending.accumulated_text = `${pending.accumulated_text}\n${args.p_new_text}`;
      return { data: { accepted: true, reason: "appended", session: pending }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };
}

function pendingRow(accumulatedText: string): Row {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    session_generation: GENERATION,
    accumulated_text: accumulatedText,
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
    accountability_round_id: null,
    entry_origin: null,
  };
}

function master(rows: Array<Partial<Row>>): Row[] {
  return rows.map((row) => ({
    accountability_round_id: ROUND,
    product_name: "มังคุด",
    unit: "โล",
    quantity: 10,
    price_per_unit: 45,
    transaction_type: "เบิก",
    ...row,
  }));
}

function textEvent(text: string, eventId: string): LineMessageEvent {
  return {
    type: "message",
    timestamp: Date.now(),
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    replyToken: `reply-${eventId}`,
    webhookEventId: eventId,
    message: { id: `msg-${eventId}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function build(db: PlainTextGateDatabase, replies: string[]) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
  });
}

const RETURN_HEADER = "ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569";

describe("P4A on the plain-text close", () => {
  it("blocks an unknown unit and leaves the session in capture", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โลก"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-1")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("⛔");
    expect(replies[0]).toContain("โลก");
    expect(replies[0]).toContain("โล");
    // The whole point: no close boundary, so the round is still open for a fix.
    expect(db.pending.close_event_timestamp_ms).toBeNull();
    expect(db.pending.close_line_event_id).toBeNull();
  });

  it("accepts the close once the corrected line is sent into the same capture", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โล"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-2")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.pending.close_line_event_id).toBe("close-2");
    // The header, and therefore the original business date, never moved.
    expect(String(db.pending.accumulated_text)).toContain("11/8/2569");
  });

  it("blocks a return that exceeds what the round withdrew", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "12โล"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-3")], "dest");

    expect(replies[0]).toContain("⛔");
    expect(replies[0]).toContain("เกิน");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("shows a changed price for review, then accepts the second close as the acknowledgement", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด120บาท", "2โล"].join("\n")),
      master([{ price_per_unit: 100, quantity: 5 }]),
    );
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการชั่งคืน", "close-4a")], "dest");
    expect(replies[0]).toContain("⚠️");
    expect(replies[0]).toContain("120");
    expect(replies[0]).toContain("100");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0]!.confirmed_at).toBeNull();

    await service.processEvents([textEvent("จบรายการชั่งคืน", "close-4b")], "dest");
    expect(replies[1]).toBe(PRODUCE_CLOSE_PENDING_REPLY);
    expect(db.reviews[0]!.confirmed_at).not.toBeNull();
    expect(db.pending.close_line_event_id).toBe("close-4b");
  });

  it("never reads a duplicate delivery of the first close as the acknowledgement", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด120บาท", "2โล"].join("\n")),
      master([{ price_per_unit: 100, quantity: 5 }]),
    );
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการชั่งคืน", "close-5")], "dest");
    // Same LINE event id redelivered — the operator pressed nothing new.
    db.pending.accumulated_text = [RETURN_HEADER, "1.มังคุด120บาท", "2โล"].join("\n");
    await service.processEvents([textEvent("จบรายการชั่งคืน", "close-5")], "dest");

    expect(db.reviews[0]!.confirmed_at).toBeNull();
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("refuses a return with no withdrawal round rather than finalizing it unbound", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โล"].join("\n")),
      [],
    );
    db.bindOutcome = { outcome: "no_round" };
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-6")], "dest");

    expect(replies[0]).toContain("ไม่พบรอบเบิกของรายการนี้");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("refuses when two open rounds share the same seller, market and date", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โล"].join("\n")),
      [],
    );
    db.bindOutcome = { outcome: "ambiguous" };
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-7")], "dest");

    expect(replies[0]).toContain("มากกว่า 1 รอบ");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("lets a clean withdrawal close exactly as before", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow(["ดำ-ราชพฤกษ์ เบิก 11/8/2569", "1.มังคุด45บาท", "10โล"].join("\n")),
      [],
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-8")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.pending.close_line_event_id).toBe("close-8");
  });
});
