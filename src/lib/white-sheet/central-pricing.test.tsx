import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { DigitalWhiteSheetSummary } from "@/components/white-sheet/DigitalWhiteSheetSummary";
import { buildWhiteSheetSummaryMessagesFromPageModel } from "@/lib/line/white-sheet-summary";
import { requireTrustedWhiteSheetSummary, WhiteSheetHardStopError } from "./compose";
import { loadDigitalWhiteSheetCalculation } from "./load";

const SOURCE_ID = "group-central-pricing";
const BUSINESS_DATE = "2026-07-24";

interface ProduceRowInput {
  id: string;
  product_name: string;
  quantity: number;
  unit: string;
  price_per_unit: number;
  market_name: string;
  session_id: string;
  raw_message_id: string;
  transaction_date?: string;
}

function makeDatabase(options: {
  produceRows: ProduceRowInput[];
  centralPrices: Array<{ product_key: string; unit_key: string; price_satang: number }>;
}) {
  const produceRows = options.produceRows.map((row) => ({
    transaction_type: "เบิก",
    base_transaction_type: "เบิก",
    item_created_at: "2026-07-24T01:00:00Z",
    transaction_date: BUSINESS_DATE,
    basis_quantity: null,
    basis_price: null,
    session_kind: "main",
    ...row,
  }));
  const rawMessageIds = [...new Set(produceRows.map((r) => r.raw_message_id))];
  const rawMessages = rawMessageIds.map((id) => ({ id, source_id: SOURCE_ID }));

  const database = {
    from(table: string) {
      if (table === "produce_transactions") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          range: async () => ({ data: produceRows, error: null, count: produceRows.length }),
        };
        return builder;
      }
      if (table === "raw_messages") {
        return { select: () => ({ in: async () => ({ data: rawMessages, error: null }) }) };
      }
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }),
          }),
        };
      }
      if (table === "central_selling_prices") {
        return { select: () => ({ eq: async () => ({ data: options.centralPrices, error: null }) }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return database as unknown as SupabaseClient<Database>;
}

const ZERO_EXPENSES = { expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 }, actualCashSubmitted: 0 };

describe("Phase 12: cross-market central price", () => {
  it("Market A and Market B both use the single central price, not their own historical withdrawal lot price", async () => {
    const MARKET_A = "ตลาดเอ";
    const MARKET_B = "ตลาดบี";
    const centralPrices = [{ product_key: "ทุเรียน", unit_key: "โล", price_satang: 2500 }]; // 25 baht

    const databaseA = makeDatabase({
      produceRows: [
        { id: "item-a", product_name: "ทุเรียน", quantity: 10, unit: "โล", price_per_unit: 20, market_name: MARKET_A, session_id: "sess-a", raw_message_id: "raw-a" },
      ],
      centralPrices,
    });
    const databaseB = makeDatabase({
      produceRows: [
        { id: "item-b", product_name: "ทุเรียน", quantity: 10, unit: "โล", price_per_unit: 30, market_name: MARKET_B, session_id: "sess-b", raw_message_id: "raw-b" },
      ],
      centralPrices,
    });

    const calcA = await loadDigitalWhiteSheetCalculation(
      databaseA,
      { sourceId: SOURCE_ID, marketKey: "a", marketLabel: MARKET_A, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );
    const calcB = await loadDigitalWhiteSheetCalculation(
      databaseB,
      { sourceId: SOURCE_ID, marketKey: "b", marketLabel: MARKET_B, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    // 10 โล × 25 (central) = 250 for both markets, despite historical lot
    // prices of 20 and 30 respectively — no market-specific central price
    // is ever created.
    expect(calcA.expectedSales).toBe(250);
    expect(calcB.expectedSales).toBe(250);
  });
});

describe("Phase 13: old/carried stock vs current business date", () => {
  it("a withdrawal recorded under the current business_date uses the CURRENT date's central price, not any prior date's", async () => {
    // This repo's schema has no field distinguishing "acquired on an earlier
    // date, sold today" from "acquired and sold today" — every produce_items
    // row carries exactly one business_date (the session's transaction_date),
    // which is what the White Sheet loader scopes by. There is no separate
    // "stock acquisition date" to model carried-over inventory independently.
    // Documented limitation: if a market genuinely carries physical stock
    // across days, this schema cannot distinguish it from same-day stock —
    // both are priced at the CURRENT business_date's central price, which is
    // the correct, safe default per BR-01 (never use yesterday's historical
    // lot price) but cannot be verified against a truly independent
    // "carried stock" flag because none exists.
    const MARKET = "ตลาดเก่า";
    const database = makeDatabase({
      produceRows: [
        {
          id: "item-old-stock",
          product_name: "ทุเรียน",
          quantity: 5,
          unit: "โล",
          price_per_unit: 15, // yesterday's historical lot price, if it were carried
          market_name: MARKET,
          session_id: "sess-old",
          raw_message_id: "raw-old",
          transaction_date: BUSINESS_DATE,
        },
      ],
      centralPrices: [{ product_key: "ทุเรียน", unit_key: "โล", price_satang: 2200 }], // today's central price = 22
    });

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "old", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      ZERO_EXPENSES,
    );

    // 5 โล × 22 (today's central price) = 110 — never 5 × 15 (the old lot price).
    expect(calculation.expectedSales).toBe(110);
  });
});

describe("Phase 14: missing central price fails closed", () => {
  it("known sold quantity with no central price blocks trusted matched/short/over and the LINE formatter", async () => {
    const MARKET = "ตลาดไม่มีราคา";
    const database = makeDatabase({
      produceRows: [
        { id: "item-1", product_name: "ทุเรียน", quantity: 10, unit: "โล", price_per_unit: 20, market_name: MARKET, session_id: "sess-1", raw_message_id: "raw-1" },
      ],
      centralPrices: [], // no central price set for this product/unit/date
    });

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      { sourceId: SOURCE_ID, marketKey: "no-price", marketLabel: MARKET, businessDate: BUSINESS_DATE },
      { expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 }, actualCashSubmitted: 500 },
    );

    expect(calculation.expectedSales).toBe(0); // never a guessed price
    expect(calculation.warnings).toContain("ไม่พบราคากลางสำหรับ ทุเรียน (โล) วันที่ 2026-07-24");

    const pageModel = { entryStatus: "submitted" as const, summary: calculation };
    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(WhiteSheetHardStopError);
    expect(() => buildWhiteSheetSummaryMessagesFromPageModel(pageModel)).toThrow(WhiteSheetHardStopError);

    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={calculation} entryStatus="submitted" />,
    );
    expect(html).toContain("white-sheet-hard-stop");
    expect(html).toContain("white-sheet-status-blocked");
  });
});
