import { describe, expect, it } from "bun:test";
import { PendingSessionService, type PendingSession } from "./pending-session-service";
import {
  WebhookService,
  requiresFreshPendingGeneration,
} from "./webhook-service";
import type { LineMessageEvent } from "./types";

type Row = Record<string, unknown>;
type QueryMode = "select" | "insert" | "update" | "delete" | "upsert";

class MemoryQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private maxRows: number | null = null;
  private returning = false;

  constructor(
    private readonly db: BoundaryDatabase,
    private readonly table: string,
    private readonly mode: QueryMode,
    private readonly payload?: Row | Row[],
  ) {}

  select(): this {
    this.returning = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column]) >= String(value));
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push((row) => Number(row[column]) <= Number(value));
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): this {
    this.maxRows = count;
    return this;
  }

  async single() {
    const result = this.execute();
    return {
      data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
      error: result.error,
    };
  }

  async maybeSingle() {
    return this.single();
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | Row | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: Row[] | Row | null; error: null } {
    const rows = this.db.rows(this.table);
    const matches = () => rows.filter((row) => this.filters.every((filter) => filter(row)));

    if (this.mode === "select") {
      const selected = matches();
      return { data: this.maxRows === null ? selected : selected.slice(0, this.maxRows), error: null };
    }

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

class BoundaryDatabase {
  private readonly tables = new Map<string, Row[]>();
  appendCalls = 0;
  generationSequence = 0;

  constructor(pending?: PendingSession) {
    if (pending) this.tables.set("pending_sessions", [pending as unknown as Row]);
  }

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  insert(table: string, payload: Row, mode: QueryMode): Row {
    const rows = this.rows(table);
    if (mode === "upsert" && table === "pending_sessions") {
      const existing = rows.find((row) => row.session_key === payload.session_key);
      if (existing) {
        Object.assign(existing, payload);
        return existing;
      }
    }

    const row = { ...payload };
    if (table === "raw_messages") {
      row.id = row.id ?? `raw-${rows.length + 1}`;
      row.created_at = row.created_at ?? new Date().toISOString();
    }
    if (table === "pending_sessions") {
      row.id = row.id ?? `pending-${rows.length + 1}`;
      row.session_generation =
        row.session_generation ?? `00000000-0000-4000-8000-${String(++this.generationSequence).padStart(12, "0")}`;
      row.created_at = row.created_at ?? new Date().toISOString();
      row.updated_at = row.updated_at ?? new Date().toISOString();
      row.close_event_timestamp_ms = row.close_event_timestamp_ms ?? null;
      row.close_requested_at = row.close_requested_at ?? null;
      row.close_line_event_id = row.close_line_event_id ?? null;
      row.close_finalize_started_at = row.close_finalize_started_at ?? null;
      row.terminalized = row.terminalized ?? false;
      row.next_attempt_at = row.next_attempt_at ?? null;
      row.close_deadline_at = row.close_deadline_at ?? null;
      row.close_session_generation = row.close_session_generation ?? null;
      row.expected_item_count = row.expected_item_count ?? null;
      row.ingest_revision = row.ingest_revision ?? 0;
    }
    if (table === "produce_sessions") row.id = row.id ?? `produce-${rows.length + 1}`;
    rows.push(row);
    return row;
  }

  remove(table: string, removed: Set<Row>): void {
    this.tables.set(
      table,
      this.rows(table).filter((row) => !removed.has(row)),
    );
  }

  from = (table: string) => ({
    select: () => new MemoryQuery(this, table, "select"),
    insert: (payload: Row | Row[]) => new MemoryQuery(this, table, "insert", payload),
    upsert: (payload: Row | Row[]) => new MemoryQuery(this, table, "upsert", payload),
    update: (payload: Row) => new MemoryQuery(this, table, "update", payload),
    delete: () => new MemoryQuery(this, table, "delete"),
  });

  rpc = async (name: string, args: Row) => {
    const pending = this.rows("pending_sessions")
      .find((row) => row.session_key === args.p_session_key);

    if (name === "admit_pending_session_event") {
      if (pending) {
        this.insert("pending_session_admission", {
          session_key: pending.session_key,
          session_generation: pending.session_generation,
          line_event_id: args.p_line_event_id,
          line_timestamp_ms: args.p_line_timestamp_ms,
        }, "insert");
      }
      return { data: null, error: null };
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
      this.appendCalls += 1;
      if (!pending) {
        return { data: { accepted: false, reason: "not_found" }, error: null };
      }
      if (
        args.p_expected_session_generation != null
        && pending.session_generation !== args.p_expected_session_generation
      ) {
        return { data: { accepted: false, reason: "generation_conflict" }, error: null };
      }
      if (
        pending.close_event_timestamp_ms != null
        && !args.p_mark_close
        && Number(args.p_line_timestamp_ms) > Number(pending.close_event_timestamp_ms)
      ) {
        return {
          data: { accepted: false, reason: "after_close_boundary", session: pending },
          error: null,
        };
      }
      pending.accumulated_text = `${pending.accumulated_text}\n${args.p_new_text}`;
      pending.latest_reply_token = args.p_reply_token;
      pending.ingest_revision = Number(pending.ingest_revision ?? 0) + 1;
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_requested_at = new Date().toISOString();
        pending.close_line_event_id = args.p_line_event_id;
        pending.close_session_generation = pending.session_generation;
        pending.close_deadline_at = new Date(Date.now() + 30_000).toISOString();
        pending.next_attempt_at = new Date(Date.now() + 8_000).toISOString();
        pending.expected_item_count = args.p_expected_item_count;
      } else if (pending.close_event_timestamp_ms != null) {
        pending.next_attempt_at = new Date(Date.now() + 8_000).toISOString();
      }
      this.insert("pending_session_admission", {
        session_key: pending.session_key,
        session_generation: pending.session_generation,
        line_event_id: args.p_line_event_id,
        line_timestamp_ms: args.p_line_timestamp_ms,
      }, "insert");
      this.insert("pending_session_ingest", {
        session_key: pending.session_key,
        session_generation: pending.session_generation,
        line_event_id: args.p_line_event_id,
        line_timestamp_ms: args.p_line_timestamp_ms,
        raw_text: args.p_new_text,
      }, "insert");
      return { data: { accepted: true, reason: "appended", session: pending }, error: null };
    }

    if (name === "claim_pending_close_finalize") {
      if (!pending) return { data: { claimed: false, reason: "gone" }, error: null };
      pending.close_finalize_started_at = new Date().toISOString();
      return {
        data: {
          claimed: true,
          session: { ...pending },
          admission_count: this.rows("pending_session_admission").length,
          ingest_count: this.rows("pending_session_ingest").length,
        },
        error: null,
      };
    }

    throw new Error(`Unexpected RPC: ${name}`);
  };
}

const SESSION_KEY = "group:group-1:user:user-1";

function pendingSession(accumulatedText: string, generation = "11111111-1111-4111-8111-111111111111"): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    session_generation: generation,
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
  };
}

let eventSequence = 0;
function textEvent(text: string, timestamp: number, replyToken?: string): LineMessageEvent {
  eventSequence += 1;
  return {
    type: "message",
    webhookEventId: `boundary-event-${eventSequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `boundary-message-${eventSequence}`, type: "text", text },
  } as LineMessageEvent;
}

function service(db: BoundaryDatabase, replies: string[] = []) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
  });
}

describe("produce pending-session generation boundary", () => {
  it("does not append a new header to stale text that already contains SESSION_END", async () => {
    const oldText = [
      "โอม-พาซิโอ้ผลไม้ คืนเสีย 29/06/2569",
      "1.ทุเรียน100บาท",
      "1โล",
      "จบรายการคืนเสีย",
    ].join("\n");
    const oldGeneration = "11111111-1111-4111-8111-111111111111";
    const db = new BoundaryDatabase(pendingSession(oldText, oldGeneration));
    const newHeader = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";

    await service(db).processEvents([textEvent(newHeader, 2_000)], "destination");

    const [current] = db.rows("pending_sessions");
    expect(current.accumulated_text).toBe(newHeader);
    expect(current.accumulated_text).not.toContain("29/06/2569");
    expect(current.session_generation).not.toBe(oldGeneration);
    expect(db.appendCalls).toBe(0);
    expect(db.rows("pending_session_ingest")[0].session_generation)
      .toBe(current.session_generation);
  });

  it("rotates generation when an old คืนเสีย session is followed by a เบิก header", async () => {
    const oldHeader = "โอม-พาซิโอ้ผลไม้ คืนเสีย 29/06/2569";
    const oldGeneration = "22222222-2222-4222-8222-222222222222";
    const db = new BoundaryDatabase(pendingSession(`${oldHeader}\n1.ทุเรียน100บาท\n1โล`, oldGeneration));
    const newHeader = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";

    expect(requiresFreshPendingGeneration(oldHeader, newHeader)).toBe(true);
    await service(db).processEvents([textEvent(newHeader, 3_000)], "destination");

    const [current] = db.rows("pending_sessions");
    expect(current.session_generation).not.toBe(oldGeneration);
    expect(current.accumulated_text).toBe(newHeader);
    expect(db.appendCalls).toBe(0);
  });

  it("does not treat an in-session คืนเสีย section as a different session header", () => {
    const header = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";
    const currentText = [
      header,
      "1.ทุเรียน100บาท",
      "1โล",
      "คืนเสีย",
      "2.มังคุด50บาท",
      "1โล",
    ].join("\n");

    expect(requiresFreshPendingGeneration(currentText, header)).toBe(false);
  });

  it("generation-pinned cleanup cannot delete a concurrent replacement", async () => {
    const replacementGeneration = "33333333-3333-4333-8333-333333333333";
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569",
      replacementGeneration,
    ));
    const pendingService = new PendingSessionService(db as never);

    const deleted = await pendingService.deleteGeneration(
      SESSION_KEY,
      "11111111-1111-4111-8111-111111111111",
    );

    expect(deleted).toBe(false);
    expect(db.rows("pending_sessions")[0].session_generation)
      .toBe(replacementGeneration);
  });

  it("accepts an eligible middle item that reaches the app after close and rearms quiet time", async () => {
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569",
    ));
    const webhook = service(db);

    await webhook.processEvents(
      [textEvent("จบรายการ 1 รายการ", 5_000, "close-reply")],
      "destination",
    );
    const pending = db.rows("pending_sessions")[0];
    const originalBoundary = pending.close_event_timestamp_ms;
    pending.next_attempt_at = "2000-01-01T00:00:00.000Z";

    await webhook.processEvents(
      [textEvent("1.ทุเรียน100บาท\n2โล", 3_000, "late-item-reply")],
      "destination",
    );

    expect(pending.close_event_timestamp_ms).toBe(originalBoundary);
    expect(pending.accumulated_text).toContain("ทุเรียน");
    expect(pending.ingest_revision).toBe(2);
    expect(String(pending.next_attempt_at)).not.toBe("2000-01-01T00:00:00.000Z");
    expect(db.rows("pending_session_ingest").some((row) =>
      String(row.raw_text).includes("ทุเรียน"),
    )).toBe(true);
  });

  it("rejects an item beyond the first close timestamp without touching old-generation ledgers", async () => {
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569",
    ));
    const replies: string[] = [];
    const webhook = service(db, replies);

    await webhook.processEvents(
      [textEvent("จบรายการ 1 รายการ", 3_000, "close-reply")],
      "destination",
    );
    const pending = db.rows("pending_sessions")[0];
    const revisionAfterClose = pending.ingest_revision;
    const ingestCountAfterClose = db.rows("pending_session_ingest").length;
    const admissionCountAfterClose = db.rows("pending_session_admission").length;

    await webhook.processEvents(
      [textEvent("1.ทุเรียน100บาท\n2โล", 4_000, "after-reply")],
      "destination",
    );

    expect(pending.accumulated_text).not.toContain("ทุเรียน");
    expect(pending.ingest_revision).toBe(revisionAfterClose);
    expect(db.rows("pending_session_ingest")).toHaveLength(ingestCountAfterClose);
    expect(db.rows("pending_session_admission")).toHaveLength(admissionCountAfterClose);
    expect(replies.at(-1)).toContain("ไม่ถูกรวม");
  });

  it("close request performs no produce writes in the webhook request", async () => {
    const stale = pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 29/06/2569\n1.ทุเรียน100บาท\n1โล",
    );
    const db = new BoundaryDatabase(stale);

    const [result] = await service(db).processEvents(
      [textEvent("จบรายการเบิก", 4_000)],
      "destination",
    );

    expect(result.parsed).toBe(false);
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.rows("produce_items")).toHaveLength(0);
    expect(db.rows("pending_sessions")).toHaveLength(1);
    expect(db.rows("pending_sessions")[0].next_attempt_at).not.toBeNull();
  });

  it("normal header → items → close is deferred for the cron finalizer", async () => {
    const db = new BoundaryDatabase();
    const webhook = service(db);

    const results = await webhook.processEvents([
      textEvent("โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569", 1_000),
      textEvent("1.ทุเรียน100บาท\n2โล", 2_000),
      textEvent("จบรายการเบิก", 3_000),
    ], "destination");

    expect(results.at(-1)?.parsed).toBe(false);
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.rows("produce_items")).toHaveLength(0);
    expect(db.rows("pending_sessions")).toHaveLength(1);
    expect(db.rows("pending_sessions")[0].close_event_timestamp_ms).toBe(3_000);
  });
});
