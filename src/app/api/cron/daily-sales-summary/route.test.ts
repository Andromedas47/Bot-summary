import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { LATEST_DATA_UNAVAILABLE_NOTICE } from "@/lib/summary/latest-data-hint";

// ── Stubs ──────────────────────────────────────────────────────────────────
//
// The route calls createServiceClient() and pushLineMessage() internally, so
// both modules are mocked. Same convention as the daily-stock-summary route
// test — the P1 route must follow the proven P0 scheduler contract exactly.

type QueryResult = { data: unknown[] | null; error: { message: string } | null; count: number | null };

let tables: Record<string, unknown[]> = {};
let tableErrors: Record<string, string> = {};

/**
 * Answer produce_transactions per query rather than per table.
 *
 * The empty-state path issues THREE reads against that view — the requested
 * date, the latest-date probe, and that date's markets — and a table-keyed
 * fixture cannot tell them apart. Null keeps every existing test on `tables`.
 */
let produceByQuery: ((filters: Record<string, unknown>) => QueryResult | null) | null = null;

function chain(table: string): Record<string, unknown> {
  const filters: Record<string, unknown> = {};

  const result = (): QueryResult => {
    if (table === "produce_transactions" && produceByQuery) {
      const answer = produceByQuery(filters);
      if (answer) return answer;
    }
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
  const record = (column: string, value: unknown, op: string) => {
    filters[`${op}:${column}`] = value;
    return node;
  };
  node.select = self;
  node.in = self;
  node.not = self;
  node.or = self;
  node.gte = self;
  node.is = self;
  node.eq = (column: string, value: unknown) => record(column, value, "eq");
  node.lt = (column: string, value: unknown) => record(column, value, "lt");
  node.order = self;
  node.limit = () => Promise.resolve(result());
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
  produceByQuery = null;
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

  test("isolates a failing target and reports 500 for monitoring", async () => {
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
    // A return row with no withdrawal of its own: still fail-closed under the
    // "no return rows means sold out" rule — a withdrawal alone would now be
    // a trusted sold-out row instead of a blocker.
    tables.produce_transactions = [tables.produce_transactions[1]]; // return only
    tables.produce_sessions = [{ id: "session-1", total_items: 1, parser_errors: null }];
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const body = await (await GET(request(`?date=${DATE}&debug=1`))).json();

    expect(body.blockedCount).toBe(1);
    expect(body.valueAuthoritative).toBe(false);
    expect(body.messages.join("\n")).toContain("มีคืนแต่ไม่มีเบิก");
  });
});

describe("daily sales summary cron — explicit date validation", () => {
  test("a valid explicit date is used exactly as given", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";
    const body = await (await GET(request(`?date=${DATE}`))).json();
    expect(body.businessDate).toBe(DATE);
  });

  test("a malformed date is a 400 and sends nothing", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    for (const bad of ["25-07-2026", "2026-7-5", "yesterday", "2026-07-25T00:00:00Z", ""]) {
      const res = await GET(request(`?date=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(400);
      expect(pushCalls).toHaveLength(0);
    }
  });

  test("a malformed date never falls back to the previous business date", async () => {
    const body = await (await GET(request("?date=31/02/2026"))).json();
    expect(body.businessDate).toBeUndefined();
    expect(body.error).toContain("ISO business date");
  });
});

describe("daily sales summary cron — corrected resend", () => {
  async function retryKeys(query: string): Promise<(string | undefined)[]> {
    pushCalls = [];
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";
    await GET(request(query));
    return pushCalls.map((call) => call.retryKey);
  }

  test("a repeated scheduled run reuses the same retry keys", async () => {
    const first = await retryKeys(`?date=${DATE}`);
    const second = await retryKeys(`?date=${DATE}`);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  test("an explicit revision mints new keys for the same day", async () => {
    const scheduled = await retryKeys(`?date=${DATE}`);
    const corrected = await retryKeys(`?date=${DATE}&revision=correction-1`);

    expect(corrected).toHaveLength(scheduled.length);
    for (const key of corrected) expect(scheduled).not.toContain(key);
  });

  test("re-running the same revision stays idempotent", async () => {
    const first = await retryKeys(`?date=${DATE}&revision=correction-1`);
    const again = await retryKeys(`?date=${DATE}&revision=correction-1`);
    expect(again).toEqual(first);
  });

  test("a malformed revision is a 400 and sends nothing", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";
    pushCalls = [];

    const res = await GET(request(`?date=${DATE}&revision=bad%20revision`));
    expect(res.status).toBe(400);
    expect(pushCalls).toHaveLength(0);
  });
});

describe("daily sales summary cron — impossible dates", () => {
  test("a well-shaped date that never existed is a 400 with zero sends", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";
    pushCalls = [];

    for (const bad of ["2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2027-02-29"]) {
      const res = await GET(request(`?date=${bad}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ date: bad });
    }

    expect(pushCalls).toHaveLength(0);
  });

  test("a real leap day is accepted", async () => {
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";
    const body = await (await GET(request("?date=2028-02-29"))).json();
    expect(body.businessDate).toBe("2028-02-29");
  });
});

describe("daily sales summary cron — empty business date", () => {
  const REQUESTED = "2026-07-27";

  /** Nothing on the requested date; `latest` is what history holds. */
  function emptyDayWith(latest: { date: string; markets: string[] } | null) {
    tables = { ...salesDay(), produce_transactions: [], produce_sessions: [] };
    produceByQuery = (filters) => {
      if (filters["lt:transaction_date"] === REQUESTED) {
        return {
          data: latest ? [{ transaction_date: latest.date }] : [],
          error: null,
          count: latest ? 1 : 0,
        };
      }
      if (latest && filters["eq:transaction_date"] === latest.date) {
        const rows = latest.markets.map((market_name) => ({ market_name }));
        return { data: rows, error: null, count: rows.length };
      }
      return { data: [], error: null, count: 0 };
    };
  }

  test("found: states the requested date is empty and points at the latest date", async () => {
    emptyDayWith({ date: "2026-07-26", markets: ["ตลาดกี้", "เฉลิม72 ผลไม้", "ตลาดกี้"] });
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${REQUESTED}`));
    const body = await res.json();
    const text = pushCalls.map((call) => call.text).join("\n\n");

    expect(res.status).toBe(200);
    expect(text).toContain("ยังไม่พบรายการขายประจำวันที่ 27 กรกฎาคม 2569");
    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 26 กรกฎาคม 2569");
    expect(text).toContain("พบข้อมูล 2 ตลาด");
    // The requested date keeps the report, and no prior-date revenue appears.
    expect(text).toContain("ข้อมูลวันที่ 27 กรกฎาคม 2569");
    expect(text).not.toContain("บาท");
    expect(body.businessDate).toBe(REQUESTED);
    expect(body.latestLookupStatus).toBe("found");
    expect(body.latestDataDate).toBe("2026-07-26");
    expect(body.latestDataMarketCount).toBe(2);
    expect(body.expectedSalesSatang).toBe(0);
  });

  test("none: says no sales exist when the query PROVED history is empty", async () => {
    emptyDayWith(null);
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${REQUESTED}`));
    const body = await res.json();
    const text = pushCalls.map((call) => call.text).join("\n\n");

    expect(body.latestLookupStatus).toBe("none");
    expect(res.status).toBe(200);
    expect(text).toContain("ยังไม่พบรายการขายในระบบ");
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
    expect(text).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });

  test("unavailable: a failed date probe never becomes a 'no history' claim", async () => {
    tables = { ...salesDay(), produce_transactions: [], produce_sessions: [] };
    produceByQuery = (filters) =>
      filters["lt:transaction_date"] === REQUESTED
        ? { data: null, error: { message: "probe exploded" }, count: null }
        : null;
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${REQUESTED}`));
    const body = await res.json();
    const text = pushCalls.map((call) => call.text).join("\n\n");

    // The empty state is still delivered in full …
    expect(res.status).toBe(200);
    expect(pushCalls).toHaveLength(1);
    expect(body.latestLookupStatus).toBe("unavailable");
    expect(text).toContain("ยังไม่พบรายการขายประจำวันที่ 27 กรกฎาคม 2569");
    expect(text).toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
    // … without claiming the business has never sold anything, and without
    // leaking the error text to LINE.
    expect(text).not.toContain("ยังไม่พบรายการขายในระบบ");
    expect(text).not.toContain("probe exploded");
  });

  test("unavailable: a date found but a failed market count is not a latest-date claim", async () => {
    tables = { ...salesDay(), produce_transactions: [], produce_sessions: [] };
    produceByQuery = (filters) => {
      if (filters["lt:transaction_date"] === REQUESTED) {
        return { data: [{ transaction_date: "2026-07-26" }], error: null, count: 1 };
      }
      if (filters["eq:transaction_date"] === "2026-07-26") {
        return { data: null, error: { message: "count exploded" }, count: null };
      }
      return null;
    };
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${REQUESTED}`));
    const body = await res.json();
    const text = pushCalls.map((call) => call.text).join("\n\n");

    expect(res.status).toBe(200);
    expect(body.latestLookupStatus).toBe("unavailable");
    expect(body.latestDataDate).toBeNull();
    expect(text).toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
    // Half an answer is not offered as a whole one.
    expect(text).not.toContain("26 กรกฎาคม 2569");
    expect(text).not.toContain("ยังไม่พบรายการขายในระบบ");
  });

  test("a date WITH sales never runs the lookup", async () => {
    let probed = false;
    produceByQuery = (filters) => {
      if (filters["lt:transaction_date"] !== undefined) probed = true;
      return null;
    };
    process.env.SALES_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${DATE}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(probed).toBe(false);
    // null status = never attempted, distinct from all three real outcomes.
    expect(body.latestLookupStatus).toBeNull();
    expect(body.latestDataDate).toBeNull();
    expect(pushCalls[0].text).toContain("บาท");
    expect(pushCalls[0].text).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });
});
