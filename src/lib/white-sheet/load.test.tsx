import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DigitalWhiteSheetSummary as DashboardSummary } from "@/components/white-sheet/DigitalWhiteSheetSummary";
import { buildWhiteSheetSummaryMessage } from "@/lib/line/white-sheet-summary";
import type { Database } from "@/types/database";
import {
  fetchProduceRows,
  loadDigitalWhiteSheetCalculation,
  toDigitalWhiteSheetSummary,
} from "./load";

const BUSINESS_DATE = "2026-07-23";
const MARKET_LABEL = "ตลาดกี้";
const SOURCE_ID = "C-market-1";
type ProduceRow = Database["public"]["Views"]["produce_transactions"]["Row"];

function makeIntegrationDatabase(options?: {
  checks?: Array<{
    id: string;
    transfer_amount: number;
    reference_id: string | null;
  }>;
  globalWinners?: Array<{
    id: string;
    reference_id: string;
    created_at: string;
  }>;
}) {
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
  const checks = options?.checks ?? [
    {
      id: "check-duplicate",
      transfer_amount: 400,
      reference_id: "DUP-REF-001",
    },
    {
      id: "check-original",
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
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          range: async () => ({
            data: produceRows,
            error: null,
            count: produceRows.length,
          }),
        };
        return builder;
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
          select: (columns: string) => {
            const scoped = columns.includes("transfer_amount");
            const builder = {
              in: () => builder,
              not: () => builder,
              order: () => builder,
              then: (resolve: (value: unknown) => void) => resolve({
                data: scoped
                  ? checks
                  : (options?.globalWinners ?? [
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
                    ]),
                error: null,
              }),
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { database, produceRows, rawMessages, checks };
}

function makeProduceLoaderDatabase(
  produceRows: readonly ProduceRow[],
  rawMessages: ReadonlyArray<{ id: string; source_id: string }>,
  serverMaxRows = Number.POSITIVE_INFINITY,
) {
  const orderColumns: string[] = [];
  const requestedRanges: Array<[number, number]> = [];

  const database = {
    from(table: string) {
      if (table === "produce_transactions") {
        let selectedBusinessDate = "";
        const builder = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            if (column === "transaction_date") selectedBusinessDate = String(value);
            return builder;
          },
          in: () => builder,
          order: (column: string) => {
            orderColumns.push(column);
            return builder;
          },
          range: async (start: number, end: number) => {
            requestedRanges.push([start, end]);
            const matchingRows = produceRows
              .filter((row) => row.transaction_date === selectedBusinessDate)
              .sort((left, right) =>
                left.item_created_at.localeCompare(right.item_created_at)
                  || left.id.localeCompare(right.id));
            const returnedLength = Math.min(end - start + 1, serverMaxRows);
            return {
              data: matchingRows.slice(start, start + returnedLength),
              error: null,
              count: matchingRows.length,
            };
          },
        };
        return builder;
      }
      if (table === "raw_messages") {
        return {
          select: () => ({
            in: async (_column: string, ids: string[]) => ({
              data: rawMessages.filter((row) => ids.includes(row.id)),
              error: null,
            }),
          }),
        };
      }
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { database, orderColumns, requestedRanges };
}

describe("produce transaction pagination", () => {
  test("loads tied timestamps exactly once across a truncated page boundary", async () => {
    const { produceRows } = makeIntegrationDatabase();
    const baseRow = produceRows[0] as ProduceRow;
    const persistedRows = Array.from({ length: 1005 }, (_, index) => ({
      ...baseRow,
      id: `item-${String(index).padStart(4, "0")}`,
      item_created_at: "2026-07-23T01:00:00Z",
      raw_message_id: `raw-${String(index).padStart(4, "0")}`,
    })).reverse();
    const { database, orderColumns, requestedRanges } = makeProduceLoaderDatabase(
      persistedRows,
      [],
      600,
    );

    const loadedRows = await fetchProduceRows(database, BUSINESS_DATE);
    const loadedIds = loadedRows.map((row) => row.id);
    const expectedIds = persistedRows.map((row) => row.id).sort();

    expect(loadedIds).toEqual(expectedIds);
    expect(new Set(loadedIds).size).toBe(persistedRows.length);
    expect(orderColumns.slice(0, 2)).toEqual(["item_created_at", "id"]);
    expect(requestedRanges).toEqual([
      [0, 999],
      [600, 1599],
    ]);
  });
});

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

  test("filters mixed dates and sources while warning on mixed or unresolved markets", async () => {
    const { produceRows } = makeIntegrationDatabase();
    const baseRow = produceRows[0] as ProduceRow;
    const scopedRows: ProduceRow[] = [
      {
        ...baseRow,
        id: "target-row",
        raw_message_id: "raw-target",
      },
      {
        ...baseRow,
        id: "other-date-row",
        transaction_date: "2026-07-22",
        raw_message_id: "raw-other-date",
      },
      {
        ...baseRow,
        id: "other-market-row",
        market_name: "Other Market",
        raw_message_id: "raw-other-market",
      },
      {
        ...baseRow,
        id: "unresolved-market-row",
        market_name: null,
        raw_message_id: "raw-unresolved-market",
      },
      {
        ...baseRow,
        id: "other-source-row",
        raw_message_id: "raw-other-source",
      },
    ];
    const { database } = makeProduceLoaderDatabase(scopedRows, [
      { id: "raw-target", source_id: SOURCE_ID },
      { id: "raw-other-date", source_id: SOURCE_ID },
      { id: "raw-other-market", source_id: SOURCE_ID },
      { id: "raw-unresolved-market", source_id: SOURCE_ID },
      { id: "raw-other-source", source_id: "C-market-other" },
    ]);

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
          labor: 0,
          locationFee: 0,
          bag: 0,
          snack: 0,
          other: 0,
          otherNote: "",
        },
        actualCashSubmitted: 1050,
      },
    );

    expect(calculation.expectedSales).toBe(1050);
    expect(calculation.items).toHaveLength(1);
    const exclusionWarning = calculation.warnings.find((warning) =>
      warning.startsWith("Excluded 2 produce row(s)"));
    expect(exclusionWarning).toBeDefined();
    expect(exclusionWarning).not.toContain("Other Market");
    expect(exclusionWarning).not.toContain("raw-");
  });

  test("excludes a scoped slip when its global winner belongs to another source", async () => {
    const { database } = makeIntegrationDatabase({
      checks: [
        {
          id: "check-local-duplicate",
          transfer_amount: 400,
          reference_id: "CROSS-SOURCE-REF",
        },
        {
          id: "check-without-reference",
          transfer_amount: 100,
          reference_id: null,
        },
      ],
      globalWinners: [
        {
          id: "check-other-source-winner",
          reference_id: "CROSS-SOURCE-REF",
          created_at: "2026-07-22T00:00:00Z",
        },
      ],
    });

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
          labor: 0,
          locationFee: 0,
          bag: 0,
          snack: 0,
          other: 0,
          otherNote: "",
        },
        actualCashSubmitted: 875,
      },
    );

    expect(calculation.verifiedTransfers).toBe(100);
  });
});
