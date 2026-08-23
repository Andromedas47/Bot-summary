/**
 * P1 2026-08-22 — late pre-close vocabulary must hold, not failed_close.
 *
 * Production generation 4bbe8461 reconstructed a document containing
 * `25อะโวคาโด้` after the close handler's stale snapshot. The finalizer then
 * terminalized as failed_closed / validation_failed. That is the wrong
 * outcome: the item's LINE timestamp was before close, so it is authoritative,
 * and review_required is recoverable by a distinct later จบรายการ.
 */
import { describe, expect, it } from "bun:test";
import { finalizePendingGeneration } from "./pending-session-finalizer";
import type { PendingSession } from "./pending-session-service";

type Row = Record<string, unknown>;

const ROUND = "11111111-1111-4111-8111-111111111111";

class FinalizerHoldDouble {
  rpcCalls: Array<{ name: string; args: Row }> = [];
  held = false;
  reviews: Row[] = [];

  constructor(private readonly tables: Record<string, Row[]>) {}

  from = (table: string) => {
    const rows = table === "produce_entry_validation_reviews"
      ? this.reviews
      : (this.tables[table] ?? []);
    const filters: Array<(row: Row) => boolean> = [];
    const builder = {
      select: () => builder,
      upsert: () => builder,
      update: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      lte: (column: string, value: unknown) => {
        filters.push((row) => Number(row[column]) <= Number(value));
        return builder;
      },
      not: () => builder,
      is: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({
        data: rows.filter((row) => filters.every((f) => f(row)))[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({
          data: rows.filter((row) => filters.every((f) => f(row))),
          error: null,
        }).then(resolve),
    };
    return builder;
  };

  rpc = async (name: string, args: Row) => {
    this.rpcCalls.push({ name, args });
    if (name === "bind_plain_text_accountability_round") {
      return {
        data: { outcome: "bound", accountability_round_id: ROUND },
        error: null,
      };
    }
    if (name === "record_produce_validation_review") {
      this.reviews.push({
        session_key: args.p_session_key,
        session_generation: args.p_session_generation,
        validation_digest: args.p_validation_digest,
        presented_line_event_id: args.p_line_event_id,
        confirmed_at: null,
      });
      return {
        data: {
          recorded: true,
          confirmed: false,
          presented_line_event_id: args.p_line_event_id,
        },
        error: null,
      };
    }
    if (name === "hold_pending_validation_review") {
      this.held = true;
      return { data: { accepted: true, reason: "held" }, error: null };
    }
    if (name === "try_finalize_pending_generation") {
      return {
        data: {
          status: "failed_closed",
          reason: "validation_failed",
          validation_errors: args.p_session && (args.p_session as Row).validation_errors,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  };
}

const SESSION_KEY = "group:group-1:user:user-1";
const GENERATION = "4bbe8461-f8b0-481f-8d31-fec65a81e1ea";
const HEADER = "จ๋า-ราชพฤก เบิก 22/8/2569";
const AVOCADO_TYPO = "25อะโวคาโด้70บาท\n19.4โล";
const CLOSE_TS = 1_787_394_325_632;
const ITEM_TS = 1_787_394_314_135;

function snapshot(overrides: Partial<PendingSession> = {}): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    accumulated_text: `${HEADER}\n1.มังคุด45บาท\n10โล\n${AVOCADO_TYPO}\nจบรายการเบิก`,
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: now,
    updated_at: now,
    session_generation: GENERATION,
    close_event_timestamp_ms: CLOSE_TS,
    close_requested_at: now,
    close_line_event_id: "01M0MG1ZGK24NMV5NY3CP58Y6F",
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: now,
    close_deadline_at: now,
    close_session_generation: GENERATION,
    expected_item_count: null,
    ingest_revision: 37,
    runtime_environment: "development",
    ...overrides,
  };
}

describe("TEST 2 — Production avocado vocabulary race holds instead of failed_closed", () => {
  it("records the review, parks the sweep, and never calls try_finalize", async () => {
    const pushes: string[] = [];
    const db = new FinalizerHoldDouble({
      pending_session_ingest: [
        {
          session_key: SESSION_KEY,
          session_generation: GENERATION,
          line_event_id: "header",
          line_timestamp_ms: ITEM_TS - 10_000,
          raw_text: HEADER,
        },
        {
          session_key: SESSION_KEY,
          session_generation: GENERATION,
          line_event_id: "01M0MG1MCK2WPDWFN8BN5SHN2S",
          line_timestamp_ms: ITEM_TS,
          raw_text: AVOCADO_TYPO,
        },
        {
          session_key: SESSION_KEY,
          session_generation: GENERATION,
          line_event_id: "01M0MG1ZGK24NMV5NY3CP58Y6F",
          line_timestamp_ms: CLOSE_TS,
          raw_text: "จบรายการเบิก",
        },
      ],
      raw_messages: [{ id: "raw-close-1", line_event_id: "01M0MG1ZGK24NMV5NY3CP58Y6F" }],
      produce_transactions: [],
      daily_summaries: [],
      produce_entry_validation_reviews: [],
    });

    const result = await finalizePendingGeneration(
      db as never,
      snapshot(),
      async (_to, text) => { pushes.push(text); },
    );

    expect(result.status).toBe("pending");
    expect(result.reason).toBe("awaiting_validation_review");
    expect(db.held).toBe(true);
    expect(db.rpcCalls.map((c) => c.name)).not.toContain("try_finalize_pending_generation");
    expect(db.held).toBe(true);
    expect(db.rpcCalls.map((c) => c.name)).not.toContain("try_finalize_pending_generation");
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0].presented_line_event_id).toBe("01M0MG1ZGK24NMV5NY3CP58Y6F");
    expect(pushes[0]).toContain("อะโวคาโด้");
    expect(pushes[0]).toContain("จบรายการ");
  });
});

describe("TEST 3 — delayed legitimate pre-close item is in the reconstructed document", () => {
  it("includes the late avocado item whose LINE timestamp precedes close", async () => {
    const db = new FinalizerHoldDouble({
      pending_session_ingest: [
        {
          session_key: SESSION_KEY,
          session_generation: GENERATION,
          line_event_id: "header",
          line_timestamp_ms: ITEM_TS - 10_000,
          raw_text: HEADER,
        },
        {
          session_key: SESSION_KEY,
          session_generation: GENERATION,
          line_event_id: "01M0MG1MCK2WPDWFN8BN5SHN2S",
          line_timestamp_ms: ITEM_TS,
          raw_text: AVOCADO_TYPO,
        },
        {
          session_key: SESSION_KEY,
          session_generation: GENERATION,
          line_event_id: "01M0MG1ZGK24NMV5NY3CP58Y6F",
          line_timestamp_ms: CLOSE_TS,
          raw_text: "จบรายการเบิก",
        },
      ],
      raw_messages: [{ id: "raw-close-1", line_event_id: "01M0MG1ZGK24NMV5NY3CP58Y6F" }],
      produce_transactions: [],
      daily_summaries: [],
      produce_entry_validation_reviews: [],
    });

    await finalizePendingGeneration(db as never, snapshot(), async () => ({}));
    const recorded = db.rpcCalls.find((c) => c.name === "record_produce_validation_review");
    const exceptions = recorded?.args.p_exceptions as Array<{ productName?: string }>;
    expect(exceptions?.some((row) => row.productName === "อะโวคาโด้")).toBe(true);
  });
});
