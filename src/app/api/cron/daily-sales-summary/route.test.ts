import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// ── Stubs ──────────────────────────────────────────────────────────────────
//
// The route calls createServiceClient() and pushLineMessage() internally, so
// both modules are mocked. Same convention as the daily-stock-summary route
// test — the P1 route must follow the proven P0 scheduler contract exactly.

type QueryResult = { data: unknown[] | null; error: { message: string } | null; count: number | null };

let tables: Record<string, unknown[]> = {};
let tableErrors: Record<string, string> = {};

function chain(table: string): Record<string, unknown> {
  const result = (): QueryResult => {
    const error = tableErrors[table];
    const rows = tables[table] ?? [];
    return {
      data: error ? null : rows,
      error: error ? { message: error } : null,
      count: error ? null : rows.length,
    };
  };

  const node: Record<string, unknown> = {};
  const self = () => node;
  node.select = self;
  node.eq = self;
  node.in = self;
  node.gte = self;
  node.lt = self;
  node.order = self;
  node.range = () => Promise.resolve(result());
  node.then = (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return node;
}

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      return chain(table);
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

const DATE = "2026-07-25";
const originalSecret = process.env.CRON_SECRET;
const originalTargets = process.env.SALES_SUMMARY_LINE_TARGETS;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function salesDay() {
  return {
    produce_transactions: [
      {
        id: "i1",
        session_id: "session-1",
        market_name: "ตลาดกี้",
        product_name: "หมอนทอง",
        quantity: 10,
        unit: "โล",
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        price_per_unit: 120,
        basis_quantity: null,
        raw_message_id: "raw-1",
        session_kind: "main",
        item_created_at: "2026-07-25T03:00:00.000Z",
      },
      {
        id: "i2",
        session_id: "session-1",
        market_name: "ตลาดกี้",
        product_name: "หมอนทอง",
        quantity: 4,
        unit: "โล",
        transaction_type: "คืน",
        base_transaction_type: "คืน",
        price_per_unit: null,
        basis_quantity: null,
        raw_message_id: "raw-1",
        session_kind: "main",
        item_created_at: "2026-07-25T09:00:00.000Z",
      },
    ],
    raw_messages: [{ id: "raw-1", source_id: "Csource000000aaaaaa" }],
    produce_sessions: [{ id: "session-1", total_items: 2, parser_errors: null }],
    pending_sessions: [],
    parse_errors: [],
    central_selling_prices: [
      {
        product_key: "หมอนทอง",
        unit_key: "โล",
        business_date: DATE,
        price_satang: 12_000,
        set_by: "admin:je",
        set_reason: null,
        created_at: "2026-07-25T01:00:00.000Z",
        updated_at: "2026-07-25T01:00:00.000Z",
      },
    ],
  };
}

beforeEach(() => {
  pushCalls = [];
  pushBehavior = () => ({ status: "delivered" });
  tables = salesDay();
  tableErrors = {};
  process.env.CRON_SECRET = "sales-secret";
  delete process.env.SALES_SUMMARY_LINE_TARGETS;
});

afterEach(() => {
  restore("CRON_SECRET", originalSecret);
  restore("SALES_SUMMARY_LINE_TARGETS", originalTargets);
});

// `null` means "send no authorization header" — an undefined default would
// silently fall back to the valid secret.
function request(query = "", authorization: string | null = "Bearer sales-secret"): NextRequest {
  return new NextRequest(`http://localhost/api/cron/daily-sales-summary${query}`, {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

describe("daily sales summary cron — authentication", () => {
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
    expect((await GET(request())).status).toBe(500);
    expect(pushCalls).toHaveLength(0);
  });
});

describe("daily sales summary cron — delivery", () => {
  test("does nothing when no LINE targets are configured", async () => {
    const res = await GET(request(`?date=${DATE}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(false);
    expect(body.reason).toBe("no_targets_configured");
    expect(pushCalls).toHaveLength(0);
  });

  test("uses its own target list, independent of the Stock report", async () => {
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cstock";
    const res = await GET(request(`?date=${DATE}`));

    expect((await res.json()).sent).toBe(false);
    expect(pushCalls).toHaveLength(0);
    delete process.env.STOCK_SUMMARY_LINE_TARGETS;
  });

  test("pushes the sales report to each configured target", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1,Cgroup2";

    const res = await GET(request(`?date=${DATE}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.sentCount).toBe(2);
    expect(body.businessDate).toBe(DATE);
    expect(body.valueAuthoritative).toBe(true);
    expect(body.expectedSalesSatang).toBe(72_000);

    expect(pushCalls.map((call) => call.to)).toEqual(["Cgroup1", "Cgroup2"]);
    expect(pushCalls[0].text).toContain("💰 สรุปยอดขายประจำวัน");
    expect(pushCalls[0].text).toContain("720.00 บาท");
  });

  test("repeat scheduler calls reuse the same retry keys — no duplicate LINE spam", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request(`?date=${DATE}`));
    const firstKeys = pushCalls.map((call) => call.retryKey);

    pushCalls = [];
    pushBehavior = () => ({ status: "already_accepted" });
    const res = await GET(request(`?date=${DATE}`));

    expect(res.status).toBe(200);
    expect(pushCalls.map((call) => call.retryKey)).toEqual(firstKeys);
    for (const key of firstKeys) expect(key).toBeTruthy();
  });

  test("a different business date produces different retry keys", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request(`?date=${DATE}`));
    const day1 = pushCalls.map((call) => call.retryKey);

    pushCalls = [];
    await GET(request("?date=2026-07-26"));

    expect(pushCalls.map((call) => call.retryKey)).not.toEqual(day1);
  });

  test("P1 retry keys never collide with the P0 Stock keys for the same day", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";
    await GET(request(`?date=${DATE}`));

    const { stockSummaryRetryKey } = await import("@/lib/summary/daily-stock-cron");
    const { salesSummaryRetryKey } = await import("@/lib/sales/cron");

    expect(salesSummaryRetryKey(DATE, "Cgroup1", 0)).not.toBe(
      stockSummaryRetryKey(DATE, "Cgroup1", 0),
    );
    expect(pushCalls[0].retryKey).toBe(salesSummaryRetryKey(DATE, "Cgroup1", 0));
  });
});

describe("daily sales summary cron — scheduled report date", () => {
  test("a scheduled run with no date param reports the previous business date", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";
    const body = await (await GET(request())).json();

    const { previousBangkokBusinessDate } = await import("@/lib/sales/cron");
    expect(body.businessDate).toBe(previousBangkokBusinessDate());
  });
});

describe("daily sales summary cron — failure behavior", () => {
  test("returns 500 when the report cannot be built", async () => {
    tableErrors = { produce_transactions: "boom" };
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${DATE}`));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("boom");
    expect(pushCalls).toHaveLength(0);
  });

  test("isolates a failing target and reports 500 so the scheduler retries", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgood,Cbad";
    pushBehavior = (call) => {
      if (call.to === "Cbad") throw new Error("LINE push HTTP 429");
      return { status: "delivered" };
    };

    const res = await GET(request(`?date=${DATE}`));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.sentCount).toBe(1);
    expect(body.failedCount).toBe(1);
    expect(pushCalls.some((call) => call.to === "Cgood")).toBe(true);
  });
});

describe("daily sales summary cron — debug mode", () => {
  test("previews the exact messages without pushing", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${DATE}&debug=1`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.debug).toBe(true);
    expect(body.wouldSendLine).toBe(true);
    expect(body.messages[0]).toContain("💰 สรุปยอดขายประจำวัน");
    expect(pushCalls).toHaveLength(0);
  });

  test("reports blocked entries instead of hiding them", async () => {
    tables.produce_transactions = [tables.produce_transactions[0]]; // withdrawal only
    tables.produce_sessions = [{ id: "session-1", total_items: 1, parser_errors: null }];
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const body = await (await GET(request(`?date=${DATE}&debug=1`))).json();

    expect(body.blockedCount).toBe(1);
    expect(body.valueAuthoritative).toBe(false);
    expect(body.messages.join("\n")).toContain("ยังไม่มีข้อมูลชั่งคืน");
  });
});
