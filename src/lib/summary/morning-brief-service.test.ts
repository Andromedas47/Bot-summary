import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { FakeDatabase, type Row } from "./test-fake-supabase";
import { loadMorningBriefReport } from "./morning-brief-service";
import type { ActionableIssueCountSource } from "./morning-brief";

const BUSINESS_DATE = "2026-08-22";
const ROUND = "11111111-1111-4111-8111-111111111111";

const client = (db: FakeDatabase): SupabaseClient<Database> =>
  db as unknown as SupabaseClient<Database>;

function produceRow(overrides: Row = {}): Row {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    session_id: "session-1",
    market_name: "ตลาดกลาง",
    staff_name: "โอม",
    product_name: "แอปเปิ้ล",
    quantity: 100,
    unit: "ลูก",
    transaction_type: "เบิก",
    base_transaction_type: "เบิก",
    price_per_unit: 20,
    raw_message_id: "raw-1",
    session_kind: "main",
    item_created_at: "2026-08-22T02:00:00.000Z",
    accountability_round_id: ROUND,
    transaction_date: BUSINESS_DATE,
    ...overrides,
  };
}

function cashEntry(sourceId: string, market: string, overrides: Row = {}): Row {
  return {
    id: `entry-${sourceId}-${market}`,
    source_id: sourceId,
    market_label_normalized: market,
    business_date: BUSINESS_DATE,
    labor: 0,
    location_fee: 0,
    bag: 0,
    snack: 0,
    other: 0,
    other_note: null,
    actual_cash_submitted: 1000,
    white_sheet_sales: 2000,
    owner_cash: 0,
    finalized_at: null,
    finalized_by: null,
    accountability_round_id: null,
    created_at: `${BUSINESS_DATE}T00:00:00Z`,
    updated_at: `${BUSINESS_DATE}T00:00:00Z`,
    ...overrides,
  };
}

function baseDb(): FakeDatabase {
  return new FakeDatabase()
    .seed("produce_sessions", [{ id: "session-1", total_items: 1, parser_errors: [] }])
    .seed("accountability_rounds", [{ id: ROUND, seller_label: "โอม", market_label: "ตลาดกลาง" }]);
}

describe("loadMorningBriefReport — financial identity resolution", () => {
  test("resolves one financial entry per active (source, market) pair, and never reimplements the formula", async () => {
    const db = baseDb()
      .seed("produce_transactions", [produceRow()])
      .seed("raw_messages", [{ id: "raw-1", source_id: "group-A" }])
      .seed("digital_white_sheet_cash_entries", [
        cashEntry("group-A", "ตลาดกลาง", { white_sheet_sales: 2000, actual_cash_submitted: 2000 }),
      ]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    expect(report.financial).toHaveLength(1);
    expect(report.financial[0]!.marketLabelNormalized).toBe("ตลาดกลาง");
    // The result is exactly what getDailyFinancialSettlement/computeDailyFinancialSettlement
    // produced — this module supplies none of these numbers itself.
    expect(report.financial[0]!.result.whiteSheetSales).toBe(2000);
    expect(report.financial[0]!.result.status).toBe("CLOSED_MATCHED");
  });

  test("two sources active the same day each get their own financial block", async () => {
    const db = baseDb()
      .seed("produce_transactions", [
        produceRow({ raw_message_id: "raw-1", market_name: "ตลาดเอ" }),
        produceRow({ raw_message_id: "raw-2", market_name: "ตลาดบี", id: "item-2" }),
      ])
      .seed("raw_messages", [
        { id: "raw-1", source_id: "group-A" },
        { id: "raw-2", source_id: "group-B" },
      ])
      .seed("digital_white_sheet_cash_entries", [
        cashEntry("group-A", "ตลาดเอ"),
        cashEntry("group-B", "ตลาดบี"),
      ]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    const markets = new Set(report.financial.map((entry) => entry.marketLabelNormalized));
    expect(markets).toEqual(new Set(["ตลาดเอ", "ตลาดบี"]));
  });

  test("a market with no cash entry submitted yet still resolves — as INCOMPLETE, not omitted", async () => {
    const db = baseDb()
      .seed("produce_transactions", [produceRow()])
      .seed("raw_messages", [{ id: "raw-1", source_id: "group-A" }]);
    // No digital_white_sheet_cash_entries row at all for this source/market/date.

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    expect(report.financial).toHaveLength(1);
    expect(report.financial[0]!.result.status).toBe("INCOMPLETE");
  });

  test("a QA test market is never resolved into a financial entry", async () => {
    const db = baseDb().seed("produce_transactions", [
      produceRow({ market_name: "ทดสอบ" }),
    ]).seed("raw_messages", [{ id: "raw-1", source_id: "group-A" }]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    expect(report.financial).toHaveLength(0);
  });

  test("a date with no produce activity resolves zero financial entries, not an error", async () => {
    const db = baseDb();
    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);
    expect(report.financial).toEqual([]);
  });
});

describe("loadMorningBriefReport — purchase planning counts", () => {
  test("counts come from the existing Purchase Planning classification, not a new calculation", async () => {
    const db = baseDb()
      .seed("produce_transactions", [produceRow()])
      .seed("raw_messages", [{ id: "raw-1", source_id: "group-A" }])
      .seed("digital_white_sheet_cash_entries", [cashEntry("group-A", "ตลาดกลาง")]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);
    const total =
      report.purchaseCounts.strong
      + report.purchaseCounts.surplus
      + report.purchaseCounts.reduce
      + report.purchaseCounts.unknown;
    // One product withdrawn with no house-stock snapshot and no return yet →
    // exactly one classified item for the day.
    expect(total).toBe(1);
  });
});

describe("loadMorningBriefReport — actionable issue port", () => {
  test("defaults to zero of both when no issue source is wired in", async () => {
    const db = baseDb();
    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);
    expect(report.issues).toEqual({ critical: 0, actionRequired: 0 });
  });

  test("honours a supplied ActionableIssueCountSource", async () => {
    const db = baseDb();
    const calls: Array<{ businessDate: string }> = [];
    const issueSource: ActionableIssueCountSource = {
      async load(_supabase, businessDate) {
        calls.push({ businessDate });
        return { critical: 3, actionRequired: 5 };
      },
    };

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE, { issueSource });

    expect(report.issues).toEqual({ critical: 3, actionRequired: 5 });
    expect(calls).toEqual([{ businessDate: BUSINESS_DATE }]);
  });
});
