import { describe, expect, it, mock } from "bun:test";
import type { FinancialSettlementSignal } from "./adapters/financial-settlement-port";
import { financialSettlementSignalsToCandidates } from "./scan";

describe("financialSettlementSignalsToCandidates", () => {
  it("never drops a signal — N signals in, N candidates out", () => {
    const signals: FinancialSettlementSignal[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "mismatch",
      businessDate: "2026-08-25",
      entityRefs: [`round-${i}`],
      summaryTh: `ปิดยอดไม่ตรง #${i}`,
    }));

    const candidates = financialSettlementSignalsToCandidates(signals);
    expect(candidates).toHaveLength(5);
    expect(candidates.every((c) => c.category === "financial_settlement_mismatch")).toBe(true);
  });

  it("maps incomplete_evidence to financial_evidence_incomplete without dropping any", () => {
    const signals: FinancialSettlementSignal[] = [
      { kind: "mismatch", businessDate: "2026-08-25", entityRefs: ["a"], summaryTh: "x" },
      { kind: "incomplete_evidence", businessDate: "2026-08-25", entityRefs: ["b"], summaryTh: "y" },
    ];
    const candidates = financialSettlementSignalsToCandidates(signals);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.category)).toEqual([
      "financial_settlement_mismatch",
      "financial_evidence_incomplete",
    ]);
  });

  it("mismatch signals are never silently downgraded — every one stays CRITICAL via severity.ts", async () => {
    const { severityForCategory } = await import("./severity");
    const signals: FinancialSettlementSignal[] = [
      { kind: "mismatch", businessDate: "2026-08-25", entityRefs: ["a"], summaryTh: "x" },
    ];
    const [candidate] = financialSettlementSignalsToCandidates(signals);
    expect(severityForCategory(candidate.category)).toBe("CRITICAL");
  });
});

// ── Full wiring: preflight + reconciliation + settlement port all reach the
// store through the single scan/upsert entrypoint. ─────────────────────────
mock.module("@/lib/produce/preflight-service", () => ({
  runDailyClosePreflight: async () => ({
    businessDate: "2026-08-25",
    status: "ready_with_warnings",
    summary: {
      readyRounds: 0, partialRounds: 0, blockedRounds: 0,
      unresolvedPriceProducts: 0, activeFailedSessions: 0,
      supersededFailures: 0, integrityIssues: 0,
    },
    rounds: [
      {
        accountabilityRoundId: "round-1",
        staffName: "สมชาย",
        marketName: "ตลาดเช้า",
        status: "ready",
        blockers: [],
        warnings: [
          {
            code: "missing_successful_return",
            severity: "warning",
            message: "เบิก 3 รายการ และยังไม่พบรายการชั่งคืน",
            accountabilityRoundId: "round-1",
            evidenceIds: ["round-1"],
          },
        ],
      },
    ],
    pricingConflicts: [],
    supersededFailures: [],
    integrityIssues: [],
  }),
}));

mock.module("@/lib/reconciliation-report-service", () => ({
  fetchReconciliationReport: async () => ({
    rows: [
      {
        source_id: "source-1",
        business_date: "2026-08-25",
        market: "ตลาดเช้า",
        submitted_transfer_total: 1000,
        ai_verified_total: 900,
        manual_slip_total: 0,
        checked_slip_total: 900,
        difference: 100,
        status: "transfer_over",
        has_open_manual_session: false,
      },
    ],
    summary: {
      submitted_transfer_total: 1000, checked_slip_total: 900,
      difference_total: 100, needs_review_count: 1, total_count: 1,
    },
    markets: ["ตลาดเช้า"],
  }),
}));

describe("scanDataQualityIssues — full wiring", () => {
  it("assembles candidates from every source and upserts each exactly once", async () => {
    const { scanDataQualityIssues } = await import("./scan");

    const rpcCalls: Array<Record<string, unknown>> = [];
    const fakeSupabase = {
      async rpc(_name: string, args: Record<string, unknown>) {
        rpcCalls.push(args);
        return { data: [], error: null };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await scanDataQualityIssues(fakeSupabase, "2026-08-25", {
      financialSettlementPort: {
        async getSignals() {
          return [
            {
              kind: "mismatch",
              businessDate: "2026-08-25",
              entityRefs: ["settlement-round-1"],
              summaryTh: "ปิดยอดไม่ตรง",
            },
          ];
        },
      },
    });

    // 1 produce candidate + 1 reconciliation candidate + 1 settlement candidate.
    expect(result.candidateCount).toBe(3);
    expect(rpcCalls).toHaveLength(1);
    const payload = rpcCalls[0].p_candidates as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(3);
    expect(payload.map((r) => r.category).sort()).toEqual(
      [
        "produce_no_return",
        "financial_reconciliation_mismatch",
        "financial_settlement_mismatch",
      ].sort(),
    );
  });
});
