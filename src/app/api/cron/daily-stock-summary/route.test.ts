import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// ── Stubs ──────────────────────────────────────────────────────────────────
//
// The route calls createServiceClient() and pushLineMessage() internally, so
// both modules are mocked. Each test points the fixtures at its own data
// before invoking GET(). Same convention as api/pdf/report-summary/route.test.ts.

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

let produceResult: QueryResult = { data: [], error: null };
let sessionResult: QueryResult = { data: [], error: null };
let messageResult: QueryResult = { data: [], error: null };

function chain(result: () => QueryResult): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.select = self;
  node.in = self;
  node.eq = self;
  node.ilike = self;
  node.order = self;
  node.range = () => Promise.resolve(result());
  node.then = (resolve: (v: QueryResult) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return node;
}

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === "produce_transactions") return chain(() => produceResult);
      if (table === "produce_sessions") return chain(() => sessionResult);
      if (table === "raw_messages") return chain(() => messageResult);
      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

interface PushCall {
  to: string;
  text: string;
  retryKey?: string;
}

let pushCalls: PushCall[] = [];
let pushBehavior: (call: PushCall) => { status: string } = () => ({ status: "delivered" });

mock.module("@/lib/line/reply", () => ({
  pushLineMessage: async (to: string, text: string, retryKey?: string) => {
    const call = { to, text, retryKey };
    pushCalls.push(call);
    return pushBehavior(call);
  },
}));

const { GET } = await import("./route");

const TX_RETURN = "คืน";
const TX_WITHDRAW = "เบิก";

const originalSecret = process.env.CRON_SECRET;
const originalTargets = process.env.STOCK_SUMMARY_LINE_TARGETS;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  pushCalls = [];
  pushBehavior = () => ({ status: "delivered" });
  produceResult = { data: [], error: null };
  sessionResult = { data: [], error: null };
  messageResult = { data: [], error: null };
  process.env.CRON_SECRET = "stock-secret";
  delete process.env.STOCK_SUMMARY_LINE_TARGETS;
});

afterEach(() => {
  restore("CRON_SECRET", originalSecret);
  restore("STOCK_SUMMARY_LINE_TARGETS", originalTargets);
});

// `null` means "send no authorization header" — an undefined default would
// silently fall back to the valid secret.
function request(query = "", authorization: string | null = "Bearer stock-secret"): NextRequest {
  return new NextRequest(`http://localhost/api/cron/daily-stock-summary${query}`, {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

function produceRows() {
  return [
    {
      market_name: "ตลาดกี้",
      product_name: "หมอนทอง",
      quantity: 281.1,
      unit: "โล",
      transaction_type: TX_RETURN,
    },
    {
      market_name: "เฉลิม72 ผลไม้",
      product_name: "แก้วมังกร",
      quantity: 9,
      unit: "โล",
      transaction_type: TX_WITHDRAW,
    },
  ];
}

describe("daily stock summary cron — authentication", () => {
  test("rejects a request with no authorization header", async () => {
    expect((await GET(request("", null))).status).toBe(401);
    expect(pushCalls).toHaveLength(0);
  });

  test("rejects a wrong secret", async () => {
    expect((await GET(request("", "Bearer nope"))).status).toBe(401);
    expect(pushCalls).toHaveLength(0);
  });

  test("fails closed when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(pushCalls).toHaveLength(0);
  });
});

describe("daily stock summary cron — delivery", () => {
  test("does nothing when no LINE targets are configured", async () => {
    produceResult = { data: produceRows(), error: null };

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(false);
    expect(body.reason).toBe("no_targets_configured");
    expect(pushCalls).toHaveLength(0);
  });

  test("pushes the shared StockSummary content to each configured target", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1,Cgroup2";

    const res = await GET(request("?date=2026-07-25"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.sentCount).toBe(2);
    expect(body.businessDate).toBe("2026-07-25");
    expect(body.isComplete).toBe(false);
    expect(body.incompleteCount).toBe(1);

    expect(pushCalls.map((c) => c.to)).toEqual(["Cgroup1", "Cgroup2"]);
    expect(pushCalls[0].text).toContain("📦 สรุปคงเหลือทุกตลาด");
    expect(pushCalls[0].text).toContain("หมอนทอง — 281.1 กก.");
    expect(pushCalls[0].text).toContain("⚠️ ข้อมูลชั่งคืนยังไม่ครบ");
    expect(pushCalls[0].text).toContain("เฉลิม72 ผลไม้: แก้วมังกร");
  });

  test("repeat scheduler calls reuse the same retry keys — no duplicate LINE spam", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request("?date=2026-07-25"));
    const firstKeys = pushCalls.map((c) => c.retryKey);

    pushCalls = [];
    // Second run: LINE answers 409 for the already-accepted key.
    pushBehavior = () => ({ status: "already_accepted" });
    const res = await GET(request("?date=2026-07-25"));

    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);
    expect(pushCalls.map((c) => c.retryKey)).toEqual(firstKeys);
    for (const key of firstKeys) expect(key).toBeTruthy();
  });

  test("a different business date produces different retry keys", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request("?date=2026-07-25"));
    const day1 = pushCalls.map((c) => c.retryKey);

    pushCalls = [];
    await GET(request("?date=2026-07-26"));
    const day2 = pushCalls.map((c) => c.retryKey);

    expect(day2).not.toEqual(day1);
  });
});

describe("daily stock summary cron — failure behavior", () => {
  test("returns 500 when the summary cannot be built", async () => {
    produceResult = { data: null, error: { message: "boom" } };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request("?date=2026-07-25"));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
    expect(pushCalls).toHaveLength(0);
  });

  test("isolates a failing target and reports 500 so the scheduler retries", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgood,Cbad";
    pushBehavior = (call) => {
      if (call.to === "Cbad") throw new Error("LINE push HTTP 429");
      return { status: "delivered" };
    };

    const res = await GET(request("?date=2026-07-25"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.sentCount).toBe(1);
    expect(body.failedCount).toBe(1);
    expect(pushCalls.some((c) => c.to === "Cgood")).toBe(true);
  });
});

describe("daily stock summary cron — debug mode", () => {
  test("previews without pushing", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request("?date=2026-07-25&debug=1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.debug).toBe(true);
    expect(body.wouldSendLine).toBe(true);
    expect(body.productCount).toBe(1);
    expect(body.messages[0]).toContain("📦 สรุปคงเหลือทุกตลาด");
    expect(pushCalls).toHaveLength(0);
  });
});
