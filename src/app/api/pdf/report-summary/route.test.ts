import { describe, expect, test, mock } from "bun:test";
import { NextRequest } from "next/server";

// ── Supabase stub ──────────────────────────────────────────────────────────────
//
// report-summary/route.tsx calls createServiceClient() internally (not injected),
// so the module is mocked; each test points `currentSupabase` at its own fixture
// before invoking GET(). See src/lib/settlement-finalizer.test.ts for the same
// generic self-returning chain convention used elsewhere in this repo.

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

function chain(result: QueryResult): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.select = self;
  node.in     = self;
  node.order  = self;
  node.eq     = self;
  node.ilike  = self;
  node.range  = () => Promise.resolve(result);
  node.then   = (resolve: (v: QueryResult) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return node;
}

function makeSupabase(opts: {
  produceRows?:     unknown[];
  produceError?:    { message: string } | null;
  settlementRows?:  unknown[];
  settlementError?: { message: string } | null;
}) {
  const {
    produceRows = [], produceError = null,
    settlementRows = [], settlementError = null,
  } = opts;

  return {
    from(table: string) {
      if (table === "produce_transactions") return chain({ data: produceRows, error: produceError });
      if (table === "settlement_entries")    return chain({ data: settlementRows, error: settlementError });
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

let currentSupabase: unknown = makeSupabase({});

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => currentSupabase,
}));

const { GET } = await import("./route");

function request(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/pdf/report-summary${qs}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function produceRow(overrides: Record<string, unknown>) {
  return {
    transaction_date: "2026-07-21",
    market_name:      "ตลาดกี้",
    staff_name:       "กี้",
    product_name:     "แตงโม",
    quantity:         10,
    unit:             "ลูก",
    price_per_unit:   20,
    total_amount:     200,
    transaction_type: "คืน",
    item_number:      1,
    basis_quantity:   null,
    basis_unit:       null,
    basis_price:      null,
    session_kind:     "main",
    ...overrides,
  };
}

const MARKETS = [
  "เฉลิมฯ72", "วัดตะกล่ำ", "ตลาดราชพฤกษ์", "เฉลิม72 ผลไม้",
  "ทรัพย์พัน", "พาชิโอ้ ผลไม้", "วัดทุ่งลานนา", "วิหาร",
];
const STAFF = ["มิ้น", "กี้", "ปลา", "ขวัญ", "น้อย", "ดำ", "กี้", "เต้ย"];
const PRODUCTS = ["แตงโม", "มะม่วง", "ทุเรียนหมอนทอง", "เงาะ", "ลำไย", "มังคุด"];
const TX_TYPES = ["เบิก", "คืน", "คืนเสีย"] as const;

function largeMultiGroupRows(): unknown[] {
  const rows: unknown[] = [];
  MARKETS.forEach((market, gi) => {
    let itemNumber = 1;
    for (const type of TX_TYPES) {
      for (let i = 0; i < 4; i++) {
        rows.push(produceRow({
          market_name:       market,
          staff_name:        STAFF[gi],
          product_name:      PRODUCTS[(gi + i) % PRODUCTS.length],
          transaction_type:  type,
          item_number:       itemNumber++,
          quantity:           5 + i,
          total_amount:       (5 + i) * 20,
        }));
      }
    }
  });
  return rows;
}

async function isPdf(res: Response): Promise<boolean> {
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/pdf/report-summary", () => {
  test("400 when no filters are supplied", async () => {
    const res = await GET(request(""));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  test("returns a valid PDF for a normal single-group report", async () => {
    currentSupabase = makeSupabase({
      produceRows: [
        produceRow({ transaction_type: "เบิก", item_number: 1, product_name: "แตงโม" }),
        produceRow({ transaction_type: "คืน",  item_number: 1, product_name: "แตงโม" }),
      ],
    });

    const res = await GET(request("?date=2026-07-21"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain('filename="');
    expect(res.headers.get("Content-Disposition")).toContain("filename*=UTF-8''");
    expect(await isPdf(res)).toBe(true);
  });

  test("returns a valid PDF for a large 8-group report (2026-07-21 shape)", async () => {
    const rows = largeMultiGroupRows();
    currentSupabase = makeSupabase({ produceRows: rows });

    const res = await GET(request("?date=2026-07-21"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000);
    // 8 distinct market+staff groups, each forced onto its own page via break={idx>0}
    // — at minimum 8 page objects must appear in the PDF's object table.
    const text = Buffer.from(buf).toString("latin1");
    const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(MARKETS.length);
  });

  test("renders Thai product/market/staff text without throwing (font coverage)", async () => {
    currentSupabase = makeSupabase({
      produceRows: [
        produceRow({
          market_name: "วัดทุ่งลานนา", staff_name: "กี้",
          product_name: "ทุเรียนหมอนทอง", transaction_type: "คืน", item_number: 1,
        }),
      ],
    });

    const res = await GET(request("?date=2026-07-21"));
    expect(res.status).toBe(200);
    expect(await isPdf(res)).toBe(true);
  });

  test("no-data date still returns a valid (empty) PDF, not an error", async () => {
    currentSupabase = makeSupabase({ produceRows: [] });

    const res = await GET(request("?date=2026-01-01"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(await isPdf(res)).toBe(true);
  });

  test("generator failure (data fetch error) returns a controlled 500, no internal detail leaked", async () => {
    currentSupabase = makeSupabase({
      produceError: { message: "relation \"produce_transactions\" secret internal detail" },
    });

    const res = await GET(request("?date=2026-07-21"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("failed to generate report PDF");
    expect(JSON.stringify(body)).not.toContain("secret internal detail");
  });

  test("settlement lookup failure also returns a controlled 500", async () => {
    currentSupabase = makeSupabase({
      produceRows: [produceRow({})],
      settlementError: { message: "internal settlement query detail" },
    });

    const res = await GET(request("?date=2026-07-21"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("failed to generate report PDF");
    expect(JSON.stringify(body)).not.toContain("internal settlement query detail");
  });

  test("market/seller filters alone (no date) still work", async () => {
    currentSupabase = makeSupabase({ produceRows: [produceRow({})] });

    const res = await GET(request("?market=%E0%B8%81%E0%B8%B5%E0%B9%89"));

    expect(res.status).toBe(200);
    expect(await isPdf(res)).toBe(true);
  });
});
