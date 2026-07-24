import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import type { Database } from "@/types/database";
import { DigitalWhiteSheetSummary } from "@/components/white-sheet/DigitalWhiteSheetSummary";
import {
  buildWhiteSheetSummaryMessagesFromPageModel,
} from "@/lib/line/white-sheet-summary";
import {
  aggregateGloballyAcceptedVerifiedTransfers,
  loadAiVerifiedTransferTotal,
  loadMarketScopedAiVerifiedTransfers,
} from "@/lib/reconciliation";
import { normalizedMarketLabel } from "@/lib/white-sheet/load";
import { loadDigitalWhiteSheetCalculation } from "@/lib/white-sheet/load";
import {
  requireTrustedWhiteSheetSummary,
  WhiteSheetHardStopError,
} from "@/lib/white-sheet/compose";
import {
  hasHardStopWarning,
  UNATTRIBUTED_VERIFIED_TRANSFER_WARNING,
} from "@/lib/white-sheet/warnings";

const SOURCE_ID = "group-market-scope";
const BUSINESS_DATE = "2026-07-23";
const MARKET_A = "ตลาด A";
const MARKET_B = "ตลาด B";
const MARKET_A_NORM = normalizedMarketLabel(MARKET_A);
const MARKET_B_NORM = normalizedMarketLabel(MARKET_B);

type SlipEvidenceRow = {
  id: string;
  market_label_normalized: string | null;
};

type SlipCheckRow = {
  id: string;
  evidence_id: string;
  transfer_amount: number;
  reference_id: string | null;
  created_at: string;
};

function makeTransferDatabase(options: {
  evidences: SlipEvidenceRow[];
  checks: SlipCheckRow[];
  globalWinners?: Array<{ id: string; reference_id: string; created_at: string }>;
}) {
  return {
    from(table: string) {
      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: async () => ({ data: options.evidences, error: null }),
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
                  ? options.checks
                  : (options.globalWinners ?? options.checks
                      .filter((c) => c.reference_id !== null)
                      .map((c) => ({
                        id: c.id,
                        reference_id: c.reference_id as string,
                        created_at: c.created_at,
                      }))),
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
}

describe("aggregateGloballyAcceptedVerifiedTransfers", () => {
  const evidenceMarket = new Map<string, string | null>([
    ["ev-a", MARKET_A_NORM],
    ["ev-b", MARKET_B_NORM],
  ]);
  const checks = [
    { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" },
    { id: "c-b", evidence_id: "ev-b", transfer_amount: 200, reference_id: "REF-B", created_at: "2026-07-23T02:00:00Z" },
  ];
  const globalWinners = new Set(["c-a", "c-b"]);

  it("scopes attributed totals per market after global dedupe", () => {
    expect(aggregateGloballyAcceptedVerifiedTransfers(
      checks,
      evidenceMarket,
      globalWinners,
      { marketLabelNormalized: MARKET_A_NORM },
    ).attributedTotal).toBe(100);

    expect(aggregateGloballyAcceptedVerifiedTransfers(
      checks,
      evidenceMarket,
      globalWinners,
      { marketLabelNormalized: MARKET_B_NORM },
    ).attributedTotal).toBe(200);
  });

  it("preserves source-wide totals when no market filter is provided", () => {
    expect(aggregateGloballyAcceptedVerifiedTransfers(
      checks,
      evidenceMarket,
      globalWinners,
    ).attributedTotal).toBe(300);
  });
});

describe("market-scoped verified transfer loading", () => {
  it("isolates transfers per market under the same source/date", async () => {
    const db = makeTransferDatabase({
      evidences: [
        { id: "ev-a", market_label_normalized: MARKET_A_NORM },
        { id: "ev-b", market_label_normalized: MARKET_B_NORM },
      ],
      checks: [
        { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" },
        { id: "c-b", evidence_id: "ev-b", transfer_amount: 200, reference_id: "REF-B", created_at: "2026-07-23T02:00:00Z" },
      ],
    });

    await expect(
      loadMarketScopedAiVerifiedTransfers(db, SOURCE_ID, BUSINESS_DATE, MARKET_A_NORM),
    ).resolves.toMatchObject({ attributedTotal: 100, unresolvedAcceptedCount: 0 });

    await expect(
      loadMarketScopedAiVerifiedTransfers(db, SOURCE_ID, BUSINESS_DATE, MARKET_B_NORM),
    ).resolves.toMatchObject({ attributedTotal: 200, unresolvedAcceptedCount: 0 });

    await expect(
      loadAiVerifiedTransferTotal(db, SOURCE_ID, BUSINESS_DATE),
    ).resolves.toBe(300);
  });

  it("counts only the global winner for cross-market duplicate references", async () => {
    const db = makeTransferDatabase({
      evidences: [
        { id: "ev-a", market_label_normalized: MARKET_A_NORM },
        { id: "ev-b", market_label_normalized: MARKET_B_NORM },
      ],
      checks: [
        { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-X", created_at: "2026-07-23T01:00:00Z" },
        { id: "c-b", evidence_id: "ev-b", transfer_amount: 100, reference_id: "REF-X", created_at: "2026-07-23T02:00:00Z" },
      ],
      globalWinners: [
        { id: "c-a", reference_id: "REF-X", created_at: "2026-07-23T01:00:00Z" },
      ],
    });

    await expect(
      loadMarketScopedAiVerifiedTransfers(db, SOURCE_ID, BUSINESS_DATE, MARKET_A_NORM),
    ).resolves.toMatchObject({ attributedTotal: 100, unresolvedAcceptedCount: 0 });

    await expect(
      loadMarketScopedAiVerifiedTransfers(db, SOURCE_ID, BUSINESS_DATE, MARKET_B_NORM),
    ).resolves.toMatchObject({ attributedTotal: 0, unresolvedAcceptedCount: 0 });
  });

  it("reports unattributed accepted winners without assigning them to any market", async () => {
    const db = makeTransferDatabase({
      evidences: [
        { id: "ev-a", market_label_normalized: MARKET_A_NORM },
        { id: "ev-u", market_label_normalized: null },
      ],
      checks: [
        { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" },
        { id: "c-u", evidence_id: "ev-u", transfer_amount: 50, reference_id: "REF-U", created_at: "2026-07-23T02:00:00Z" },
      ],
    });

    const marketA = await loadMarketScopedAiVerifiedTransfers(
      db, SOURCE_ID, BUSINESS_DATE, MARKET_A_NORM,
    );
    const marketB = await loadMarketScopedAiVerifiedTransfers(
      db, SOURCE_ID, BUSINESS_DATE, MARKET_B_NORM,
    );

    expect(marketA.attributedTotal).toBe(100);
    expect(marketA.unresolvedAcceptedCount).toBe(1);
    expect(marketA.unresolvedAcceptedAmount).toBe(50);
    expect(marketB.attributedTotal).toBe(0);
    expect(marketB.unresolvedAcceptedCount).toBe(1);
  });
});

describe("legacy backfill attribution semantics", () => {
  it("A: batch market_name present → attribution backfillable", () => {
    const rawMarket = "ตลาด A";
    const normalized = normalizedMarketLabel(rawMarket);
    expect(normalized).toBe(MARKET_A_NORM);
    expect(
      aggregateGloballyAcceptedVerifiedTransfers(
        [{ id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" }],
        new Map([["ev-a", normalized]]),
        new Set(["c-a"]),
        { marketLabelNormalized: MARKET_A_NORM },
      ).attributedTotal,
    ).toBe(100);
  });

  it("B: batch_id present but market_name NULL → remains unresolved", () => {
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [{ id: "c-u", evidence_id: "ev-u", transfer_amount: 50, reference_id: "REF-U", created_at: "2026-07-23T01:00:00Z" }],
      new Map([["ev-u", null]]),
      new Set(["c-u"]),
      { marketLabelNormalized: MARKET_A_NORM },
    );
    expect(result.attributedTotal).toBe(0);
    expect(result.unresolvedAcceptedCount).toBe(1);
  });

  it("C: batch_id NULL → remains unresolved", () => {
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [{ id: "c-u", evidence_id: "ev-null", transfer_amount: 75, reference_id: null, created_at: "2026-07-23T01:00:00Z" }],
      new Map([["ev-null", null]]),
      new Set<string>(),
      { marketLabelNormalized: MARKET_A_NORM },
    );
    expect(result.attributedTotal).toBe(0);
    expect(result.unresolvedAcceptedCount).toBe(1);
    expect(result.unresolvedAcceptedAmount).toBe(75);
  });
});

describe("White Sheet fail-closed for unattributed verified transfers", () => {
  function makeWhiteSheetDatabase() {
    const produceRows = [{
      id: "item-1",
      product_name: "ทุเรียน",
      quantity: 10,
      unit: "โล",
      price_per_unit: 100,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-07-23T01:00:00Z",
      session_id: "main-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_A,
      raw_message_id: "raw-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    }];

    const db = makeTransferDatabase({
      evidences: [
        { id: "ev-a", market_label_normalized: MARKET_A_NORM },
        { id: "ev-u", market_label_normalized: null },
      ],
      checks: [
        { id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-23T01:00:00Z" },
        { id: "c-u", evidence_id: "ev-u", transfer_amount: 50, reference_id: "REF-U", created_at: "2026-07-23T02:00:00Z" },
      ],
    });

    const combined = {
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
          return {
            select: () => ({
              in: async () => ({ data: [{ id: "raw-1", source_id: SOURCE_ID }], error: null }),
            }),
          };
        }
        if (table === "slip_evidences" || table === "slip_checks") {
          return db.from(table);
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };

    return combined as unknown as SupabaseClient<Database>;
  }

  it("adds a hard-stop warning and blocks trusted LINE summary", async () => {
    const database = makeWhiteSheetDatabase();
    const calculation = await loadDigitalWhiteSheetCalculation(
      database,
      {
        sourceId: SOURCE_ID,
        marketKey: "market-a",
        marketLabel: MARKET_A,
        businessDate: BUSINESS_DATE,
      },
      {
        expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0, otherNote: "" },
        actualCashSubmitted: 900,
      },
    );

    expect(calculation.verifiedTransfers).toBe(100);
    expect(hasHardStopWarning(calculation.warnings)).toBe(true);
    expect(calculation.warnings.some((w) => w.startsWith(UNATTRIBUTED_VERIFIED_TRANSFER_WARNING))).toBe(true);

    const pageModel = {
      entryStatus: "submitted" as const,
      summary: {
        marketKey: "market-a",
        marketLabel: MARKET_A,
        businessDate: BUSINESS_DATE,
        expectedSales: calculation.expectedSales,
        verifiedTransfers: calculation.verifiedTransfers,
        expenses: calculation.expenses,
        expenseTotal: calculation.expenseTotal,
        expectedCash: calculation.expectedCash,
        actualCashSubmitted: calculation.actualCashSubmitted,
        difference: calculation.difference,
        status: calculation.status,
        warnings: calculation.warnings,
      },
    };

    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(WhiteSheetHardStopError);
    expect(() => buildWhiteSheetSummaryMessagesFromPageModel(pageModel)).toThrow(WhiteSheetHardStopError);

    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={pageModel.summary} entryStatus="submitted" />,
    );
    expect(html).toContain(UNATTRIBUTED_VERIFIED_TRANSFER_WARNING);
    expect(html).toContain("white-sheet-hard-stop");
    expect(html).toContain("white-sheet-status-blocked");
  });
});
