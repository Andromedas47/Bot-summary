import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DigitalWhiteSheetSummary as DashboardSummary } from "@/components/white-sheet/DigitalWhiteSheetSummary";
import { buildWhiteSheetSummaryMessage } from "@/lib/line/white-sheet-summary";
import type { Database } from "@/types/database";
import {
  loadDigitalWhiteSheetCalculation,
  toDigitalWhiteSheetSummary,
} from "./load";

const BUSINESS_DATE = "2026-07-23";
const MARKET_LABEL = "ตลาดกี้";
const SOURCE_ID = "C-market-1";

function makeIntegrationDatabase() {
  const produceRows = [
    {
      id: "item-1",
      product_name: "ทุเรียนหมอนทอง",
      quantity: 10.5,
      unit: "โล",
      price_per_unit: 100,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-07-23T01:00:00Z",
      session_id: "main-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    {
      id: "item-2",
      product_name: "ทุเรียนหมอนทอง",
      quantity: 1.25,
      unit: "โล",
      price_per_unit: null,
      transaction_type: "คืน",
      base_transaction_type: "คืน",
      item_created_at: "2026-07-23T02:00:00Z",
      session_id: "main-session-2",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-2",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    {
      id: "item-3",
      product_name: "ทุเรียนหมอนทอง",
      quantity: 0.25,
      unit: "โล",
      price_per_unit: null,
      transaction_type: "คืนเสีย",
      base_transaction_type: "คืนเสีย",
      item_created_at: "2026-07-23T03:00:00Z",
      session_id: "main-session-2",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-2",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    {
      id: "item-4",
      product_name: "มะพร้าวพิเศษ",
      quantity: 4,
      unit: "ลูก",
      price_per_unit: 25,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-07-23T04:00:00Z",
      session_id: "additional-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-3",
      basis_quantity: null,
      basis_price: null,
      session_kind: "additional",
    },
    {
      id: "item-5",
      product_name: "มะพร้าวพิเศษ",
      quantity: 1,
      unit: "ลูก",
      price_per_unit: null,
      transaction_type: "คืน",
      base_transaction_type: "คืน",
      item_created_at: "2026-07-23T05:00:00Z",
      session_id: "additional-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-3",
      basis_quantity: null,
      basis_price: null,
      session_kind: "additional",
    },
  ];
  const rawMessages = [
    { id: "raw-1", source_id: SOURCE_ID },
    { id: "raw-2", source_id: SOURCE_ID },
    { id: "raw-3", source_id: SOURCE_ID },
  ];
  const checks = [
    {
      id: "check-original",
      transfer_amount: 400,
      reference_id: "DUP-REF-001",
    },
    {
      id: "check-duplicate",
      transfer_amount: 400,
      reference_id: "DUP-REF-001",
    },
    {
      id: "check-without-reference",
      transfer_amount: 100,
      reference_id: null,
    },
  ];

  const database = {
    from(table: string) {
      if (table === "produce_transactions") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => ({
                  range: async () => ({ data: produceRows, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "raw_messages") {
        return {
          select: () => ({
            in: async () => ({ data: rawMessages, error: null }),
          }),
        };
      }
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({
                  data: [{ id: "evidence-1" }, { id: "evidence-2" }, { id: "evidence-3" }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "slip_checks") {
        return {
          select: (columns: string) => ({
            in: () => ({
              in: () =>
                columns.includes("transfer_amount")
                  ? {
                      not: async () => ({ data: checks, error: null }),
                    }
                  : {
                      order: async () => ({
                        data: [
                          {
                            id: "check-original",
                            reference_id: "DUP-REF-001",
                            created_at: "2026-07-23T00:00:00Z",
                          },
                          {
                            id: "check-duplicate",
                            reference_id: "DUP-REF-001",
                            created_at: "2026-07-23T00:01:00Z",
                          },
                        ],
                        error: null,
                      }),
                    },
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { database, produceRows, rawMessages, checks };
}

describe("digital white-sheet real-data integration", () => {
  test("loads one market/date and feeds the same canonical summary to Dashboard and LINE", async () => {
    const { database, produceRows, rawMessages, checks } = makeIntegrationDatabase();
    const sourceSnapshot = structuredClone({ produceRows, rawMessages, checks });

    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "talad-kee",
        marketLabel: MARKET_LABEL,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: {
          labor: 50,
          locationFee: 20,
          bag: 5,
          snack: 5,
          other: 10,
          otherNote: "น้ำแข็ง",
        },
        actualCashSubmitted: 375,
      },
    );

    expect(calculation.items).toEqual([
      expect.objectContaining({
        normalizedProduct: "ทุเรียนหมอนทอง",
        normalizedUnit: "โล",
        withdrawnQuantity: 10.5,
        goodReturnQuantity: 1.25,
        damagedReturnQuantity: 0.25,
        soldQuantity: 9,
        expectedSales: 900,
      }),
      expect.objectContaining({
        normalizedProduct: "มะพร้าวพิเศษ",
        normalizedUnit: "ลูก",
        withdrawnQuantity: 4,
        goodReturnQuantity: 1,
        damagedReturnQuantity: 0,
        soldQuantity: 3,
        expectedSales: 75,
        category: "uncategorized",
      }),
    ]);
    expect(calculation).toMatchObject({
      expectedSales: 975,
      verifiedTransfers: 500,
      expenseTotal: 90,
      expectedCash: 385,
      actualCashSubmitted: 375,
      difference: -10,
      status: "shortage",
    });
    expect(calculation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Uncategorized product: มะพร้าวพิเศษ (ลูก)"),
        expect.stringContaining("Multiple completed main produce sessions (2)"),
      ]),
    );

    const summary = toDigitalWhiteSheetSummary(calculation);
    const dashboardHtml = renderToStaticMarkup(
      <DashboardSummary viewModel={summary} />,
    );
    const lineMessage = buildWhiteSheetSummaryMessage(summary);

    for (const expectedValue of ["975.00", "500.00", "90.00", "385.00", "375.00", "10.00"]) {
      expect(dashboardHtml).toContain(expectedValue);
      expect(lineMessage).toContain(expectedValue);
    }
    expect(dashboardHtml).toContain("เงินขาด");
    expect(lineMessage).toContain("เงินขาด");
    expect({ produceRows, rawMessages, checks }).toEqual(sourceSnapshot);
  });
});
