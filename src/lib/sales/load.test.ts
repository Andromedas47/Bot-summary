import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { bangkokBusinessDateWindow, loadSalesReport, SalesDataError } from "./load";

const DATE = "2026-07-25";
const SOURCE_A = "Csource000000aaaaaa";
const SOURCE_B = "Csource000000bbbbbb";

interface Fixture {
  produce?: Record<string, unknown>[];
  rawMessages?: Record<string, unknown>[];
  sessions?: Record<string, unknown>[];
  pending?: Record<string, unknown>[];
  parseErrors?: Record<string, unknown>[];
  centralPrices?: Record<string, unknown>[];
  errors?: Partial<Record<string, string>>;
}

/**
 * A fake PostgREST client: the P1 loader is the piece that has to read the
 * right tables and interpret their rows, so the tables are what get faked.
 * Filters are ignored except where a test depends on one, which keeps the
 * fixture readable — every table returns the rows the test declared.
 */
function fakeSupabase(fixture: Fixture): SupabaseClient<Database> {
  const rowsFor = (table: string): Record<string, unknown>[] => {
    switch (table) {
      case "produce_transactions": return fixture.produce ?? [];
      case "raw_messages": return fixture.rawMessages ?? [];
      case "produce_sessions": return fixture.sessions ?? [];
      case "pending_sessions": return fixture.pending ?? [];
      case "parse_errors": return fixture.parseErrors ?? [];
      case "central_selling_prices": return fixture.centralPrices ?? [];
      default: throw new Error(`Unexpected table: ${table}`);
    }
  };

  const client = {
    from(table: string) {
      const error = fixture.errors?.[table];
      const result = () => ({
        data: error ? null : rowsFor(table),
        error: error ? { message: error } : null,
        count: error ? null : rowsFor(table).length,
      });

      const node: Record<string, unknown> = {};
      const self = () => node;
      node.select = self;
      node.eq = self;
      node.in = self;
      node.gte = self;
      node.lt = self;
      node.order = self;
      node.range = () => Promise.resolve(result());
      node.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return node;
    },
  };

  return client as unknown as SupabaseClient<Database>;
}

function produceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
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
    ...overrides,
  };
}

function baseFixture(overrides: Fixture = {}): Fixture {
  return {
    produce: [
      produceRow({ id: "i1", quantity: 10, transaction_type: "เบิก" }),
      produceRow({ id: "i2", quantity: 4, transaction_type: "คืน" }),
    ],
    rawMessages: [{ id: "raw-1", source_id: SOURCE_A }],
    sessions: [{ id: "session-1", total_items: 2, parser_errors: null }],
    pending: [],
    parseErrors: [],
    centralPrices: [
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
    ...overrides,
  };
}

describe("P1 business-date window", () => {
  test("covers the Bangkok 04:00 business day in UTC", () => {
    // Business date 2026-07-25 runs 04:00 Bangkok 25/07 → 04:00 Bangkok 26/07,
    // which is 21:00Z on 24/07 → 21:00Z on 25/07.
    expect(bangkokBusinessDateWindow(DATE)).toEqual({
      start: "2026-07-24T21:00:00.000Z",
      end: "2026-07-25T21:00:00.000Z",
    });
  });
});

describe("P1 loader", () => {
  test("produces a trusted report from clean data", async () => {
    const report = await loadSalesReport(fakeSupabase(baseFixture()), DATE);

    expect(report.businessDate).toBe(DATE);
    expect(report.markets).toHaveLength(1);
    expect(report.markets[0].rows[0].soldQuantity).toBe(6);
    expect(report.markets[0].rows[0].expectedSalesSatang).toBe(72_000);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
    expect(report.blocked).toHaveLength(0);
  });

  test("keys the market on the LINE source, not the label alone", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          produce: [
            produceRow({ id: "i1", quantity: 10, transaction_type: "เบิก" }),
            produceRow({ id: "i2", quantity: 4, transaction_type: "คืน" }),
            produceRow({
              id: "i3",
              quantity: 8,
              transaction_type: "เบิก",
              session_id: "session-2",
              raw_message_id: "raw-2",
            }),
            produceRow({
              id: "i4",
              quantity: 3,
              transaction_type: "คืน",
              session_id: "session-2",
              raw_message_id: "raw-2",
            }),
          ],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A },
            { id: "raw-2", source_id: SOURCE_B },
          ],
          sessions: [
            { id: "session-1", total_items: 2, parser_errors: null },
            { id: "session-2", total_items: 2, parser_errors: null },
          ],
        }),
      ),
      DATE,
    );

    // Same label "ตลาดกี้" under two sources — two markets, never merged.
    expect(report.markets).toHaveLength(2);
    expect(new Set(report.markets.map((market) => market.marketKey)).size).toBe(2);
  });

  test("blocks a session whose parser reported errors", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          sessions: [{ id: "session-1", total_items: 2, parser_errors: ["unreadable line 3"] }],
        }),
      ),
      DATE,
    );

    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].reasons).toContain("session_parser_errors");
  });

  test("blocks a session whose persisted item count does not match", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ sessions: [{ id: "session-1", total_items: 5, parser_errors: null }] })),
      DATE,
    );

    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].reasons).toContain("session_item_count_mismatch");
  });

  test("an unresolved pending session demotes the day's totals", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [
            {
              id: "pending-1",
              finalized_at: null,
              finalized_produce_session_id: null,
              finalization_status: "pending",
            },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("a finalized pending row is not a blocker", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [
            {
              id: "pending-1",
              finalized_at: "2026-07-25T05:00:00.000Z",
              finalized_produce_session_id: "session-1",
              finalization_status: "finalized",
            },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toHaveLength(0);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });

  test("a crashed Produce parse demotes the day's totals", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [
            { id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-1" },
            { id: "pe-2", parser_name: "weigh-session", raw_message_id: "raw-1" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 2 }]);
    expect(report.allMarkets.quantityAuthoritative).toBe(false);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("a crash from an unrelated parser does not demote Sales", async () => {
    // parse_errors is generic. A slip/OCR/whatever parser blowing up cannot have
    // swallowed เบิก/คืน lines, and must not block the whole day's sales.
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "manual-slip-amount", raw_message_id: "raw-9" }],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A, raw_text: null },
            { id: "raw-9", source_id: SOURCE_A, raw_text: "โอนแล้วนะ 1200" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });

  test("a crash on a non-text message does not demote Sales", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "registry", raw_message_id: "raw-9" }],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A, raw_text: null },
            { id: "raw-9", source_id: SOURCE_A, raw_text: null },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
  });

  test("an unknown parser crashing on a weighing message stays fail-closed", async () => {
    // A parser P1 has never heard of still blocks when the raw message itself
    // carries produce evidence — that is how a future Produce parser is covered.
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "weigh-session-v2", raw_message_id: "raw-9" }],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A, raw_text: null },
            { id: "raw-9", source_id: SOURCE_A, raw_text: "เบิก 25/07/2569\n1.หมอนทอง 10 โล" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("a parse error whose raw message cannot be read stays fail-closed", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "mystery", raw_message_id: "raw-gone" }],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });

  test("a system-seeded price contradicted by a withdrawal blocks the value", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          centralPrices: [
            {
              product_key: "หมอนทอง",
              unit_key: "โล",
              business_date: DATE,
              price_satang: 11_000,
              set_by: "system:first-withdrawal",
              set_reason: null,
              created_at: "2026-07-25T01:00:00.000Z",
              updated_at: "2026-07-25T01:00:00.000Z",
            },
          ],
        }),
      ),
      DATE,
    );

    // The withdrawal row says 120.00 while the auto-seeded price says 110.00.
    expect(report.blocked[0].status).toBe("VALUE_BLOCKED");
    expect(report.blocked[0].reasons).toContain("central_price_conflict");
  });

  test("an admin-set price that a withdrawal contradicts is still authoritative", async () => {
    const report = await loadSalesReport(fakeSupabase(baseFixture()), DATE);
    // baseFixture: admin price 120.00 set_by admin:je, withdrawal also 120.00 —
    // and an admin decision is never treated as a conflict regardless.
    expect(report.markets[0].rows[0].centralPriceSatang).toBe(12_000);
    expect(report.markets[0].rows[0].status).toBe("TRUSTED");
  });

  test("a missing central price blocks value but keeps the quantity", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ centralPrices: [] })),
      DATE,
    );

    expect(report.blocked[0].status).toBe("VALUE_BLOCKED");
    expect(report.blocked[0].soldQuantity).toBe(6);
    expect(report.blocked[0].reasons).toContain("missing_central_price");
  });

  test("a row whose LINE source cannot be resolved is blocked, not merged", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ rawMessages: [] })),
      DATE,
    );

    expect(report.blocked[0].reasons).toContain("market_unresolved");
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("rejects a malformed business date", async () => {
    await expect(loadSalesReport(fakeSupabase(baseFixture()), "25/07/2026")).rejects.toThrow(
      SalesDataError,
    );
  });

  test("fails closed when the produce query errors", async () => {
    await expect(
      loadSalesReport(fakeSupabase(baseFixture({ errors: { produce_transactions: "boom" } })), DATE),
    ).rejects.toThrow("boom");
  });

  test("fails closed when the pending-session query errors", async () => {
    await expect(
      loadSalesReport(fakeSupabase(baseFixture({ errors: { pending_sessions: "nope" } })), DATE),
    ).rejects.toThrow("nope");
  });
});
