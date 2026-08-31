import { afterEach, describe, expect, it } from "bun:test";
import { finalizePendingGeneration, finalizeDuePendingGenerations } from "./pending-session-finalizer";
import type { PendingSession } from "./pending-session-service";

// Regression for a real cross-environment incident: Preview and Production
// share one Supabase project. Production's cron (finalize-pending-produce-sessions)
// polls pending_sessions with no environment scope at all, so it claimed and
// finalized a Preview-created UAT session with Production's own (older)
// parser code — a session that never should have been visible to it. See
// 20260806111646_pending_session_runtime_environment.sql and src/lib/runtime-environment.ts.

type Row = Record<string, unknown>;

const originalVercelEnv = process.env.VERCEL_ENV;

function setEnvironment(value: string | undefined) {
  if (value === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = value;
}

afterEach(() => {
  setEnvironment(originalVercelEnv);
});

const SESSION_KEY = "group:test-market-1:user:test-staff-1";
const GENERATION = "44444444-4444-4444-8444-444444444444";

// Deliberately fake, non-market names/dates per test-content requirements.
const MESSAGES = [
  "ทดสอบ-ตลาดทดสอบ เบิก 1/1/2560",
  "1ผลไม้ทดสอบเอ100บาท",
  "2ถุง",
];

function ingestRows(generation = GENERATION): Row[] {
  return MESSAGES.map((raw_text, index) => ({
    session_key: SESSION_KEY,
    session_generation: generation,
    line_event_id: `event-${index + 1}`,
    line_timestamp_ms: (index + 1) * 1_000,
    raw_text,
  }));
}

function snapshot(
  runtimeEnvironment: PendingSession["runtime_environment"],
  generation = GENERATION,
): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-env-1",
    session_key: SESSION_KEY,
    source_id: "test-market-1",
    accumulated_text: MESSAGES.join("\n"),
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: now,
    updated_at: now,
    session_generation: generation,
    close_event_timestamp_ms: (MESSAGES.length + 1) * 1_000,
    close_requested_at: now,
    close_line_event_id: "close-event-1",
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: now,
    close_deadline_at: now,
    close_session_generation: generation,
    expected_item_count: null,
    ingest_revision: MESSAGES.length + 1,
    runtime_environment: runtimeEnvironment,
  };
}

class FinalizerDouble {
  rpcCalls: Array<{ name: string; args: Row }> = [];
  rpcResult: Row = { status: "finalized", session_id: "produce-1", notification_id: "notify-1" };

  constructor(private readonly tables: Record<string, Row[]>) {}

  from = (table: string) => {
    const rows = this.tables[table] ?? [];
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
        filters.push((row) => {
          const rowValue = row[column];
          const rowTime = typeof rowValue === "string" ? Date.parse(rowValue) : Number(rowValue);
          const compareTime = typeof value === "string" ? Date.parse(value) : Number(value);
          return rowTime <= compareTime;
        });
        return builder;
      },
      // Only shape actually used by finalizeDuePendingGenerations:
      // "runtime_environment.eq.production,runtime_environment.is.null"
      or: (expr: string) => {
        const clauses = expr.split(",");
        filters.push((row) =>
          clauses.some((clause) => {
            const [column, op, value] = clause.split(".");
            if (op === "eq") return row[column] === value;
            if (op === "is" && value === "null") return row[column] == null;
            return false;
          }),
        );
        return builder;
      },
      not: () => builder,
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
    if (name === "try_finalize_pending_generation") {
      return { data: this.rpcResult, error: null };
    }
    return { data: null, error: null };
  };
}

function tables(): Record<string, Row[]> {
  return {
    pending_session_ingest: ingestRows(),
    raw_messages: [{ id: "raw-close-1", line_event_id: "close-event-1" }],
    produce_transactions: [],
    daily_summaries: [],
  };
}

describe("pending session finalization — runtime environment ownership", () => {
  it("Production finalizer skips a Preview-created session (wrong_environment, no RPC call)", async () => {
    setEnvironment("production");
    const db = new FinalizerDouble(tables());
    const snap = snapshot("preview");

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result).toEqual({ status: "skipped", reason: "wrong_environment" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("Preview finalizer skips a Production-created session (wrong_environment, no RPC call)", async () => {
    setEnvironment("preview");
    const db = new FinalizerDouble(tables());
    const snap = snapshot("production");

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result).toEqual({ status: "skipped", reason: "wrong_environment" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("same-environment finalization still works (Preview finalizing its own session)", async () => {
    setEnvironment("preview");
    const db = new FinalizerDouble(tables());
    const snap = snapshot("preview");

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result.status).toBe("finalized");
    expect(db.rpcCalls.some((c) => c.name === "try_finalize_pending_generation")).toBe(true);
  });

  it("same-environment finalization still works (Production finalizing its own session)", async () => {
    setEnvironment("production");
    const db = new FinalizerDouble(tables());
    const snap = snapshot("production");

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result.status).toBe("finalized");
  });

  it("legacy rows (runtime_environment null, predate 0061): Production may finalize them", async () => {
    setEnvironment("production");
    const db = new FinalizerDouble(tables());
    const snap = snapshot(null);

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result.status).toBe("finalized");
  });

  it("legacy rows (runtime_environment null): Preview must never finalize them", async () => {
    setEnvironment("preview");
    const db = new FinalizerDouble(tables());
    const snap = snapshot(null);

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result).toEqual({ status: "skipped", reason: "wrong_environment" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("sweep query itself excludes Preview-owned rows when running as Production", async () => {
    setEnvironment("production");
    const t = tables();
    t.pending_sessions = [
      snapshot("preview") as unknown as Row,
    ];
    const db = new FinalizerDouble(t);

    const run = await finalizeDuePendingGenerations(db as never, async () => ({}));

    expect(run.due).toBe(0);
    expect(run.finalized).toBe(0);
  });

  it("sweep query itself excludes Production-owned rows when running as Preview", async () => {
    setEnvironment("preview");
    const t = tables();
    t.pending_sessions = [
      snapshot("production") as unknown as Row,
    ];
    const db = new FinalizerDouble(t);

    const run = await finalizeDuePendingGenerations(db as never, async () => ({}));

    expect(run.due).toBe(0);
    expect(run.finalized).toBe(0);
  });

  it("sweep query includes legacy (null) rows when running as Production", async () => {
    setEnvironment("production");
    const t = tables();
    t.pending_sessions = [
      snapshot(null) as unknown as Row,
    ];
    const db = new FinalizerDouble(t);

    const run = await finalizeDuePendingGenerations(db as never, async () => ({}));

    expect(run.due).toBe(1);
    expect(run.finalized).toBe(1);
  });

  it("sweep query excludes legacy (null) rows when running as Preview", async () => {
    setEnvironment("preview");
    const t = tables();
    t.pending_sessions = [
      snapshot(null) as unknown as Row,
    ];
    const db = new FinalizerDouble(t);

    const run = await finalizeDuePendingGenerations(db as never, async () => ({}));

    expect(run.due).toBe(0);
  });
});
