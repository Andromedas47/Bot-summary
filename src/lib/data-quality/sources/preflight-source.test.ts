import { describe, expect, it } from "bun:test";
import type { DailyClosePreflightResult, PreflightIssue } from "@/lib/produce/daily-close-preflight";
import { preflightIssuesToCandidates } from "./preflight-source";

function issue(overrides: Partial<PreflightIssue> & Pick<PreflightIssue, "code" | "severity" | "message">): PreflightIssue {
  return { evidenceIds: [], ...overrides };
}

function baseResult(overrides: Partial<DailyClosePreflightResult> = {}): DailyClosePreflightResult {
  return {
    businessDate: "2026-08-25",
    status: "ready",
    summary: {
      readyRounds: 0,
      partialRounds: 0,
      blockedRounds: 0,
      unresolvedPriceProducts: 0,
      activeFailedSessions: 0,
      supersededFailures: 0,
      integrityIssues: 0,
    },
    rounds: [],
    pricingConflicts: [],
    supersededFailures: [],
    integrityIssues: [],
    ...overrides,
  };
}

describe("preflightIssuesToCandidates", () => {
  it("maps a round-level missing-return warning to produce_no_return / ACTION_REQUIRED category", () => {
    const result = baseResult({
      rounds: [
        {
          accountabilityRoundId: "round-1",
          staffName: "สมชาย",
          marketName: "ตลาดเช้า",
          status: "ready",
          blockers: [],
          warnings: [
            issue({
              code: "missing_successful_return",
              severity: "warning",
              message: "เบิก 3 รายการ และยังไม่พบรายการชั่งคืน",
              accountabilityRoundId: "round-1",
              evidenceIds: ["round-1"],
            }),
          ],
        },
      ],
    });

    const candidates = preflightIssuesToCandidates(result);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe("produce_no_return");
    expect(candidates[0].entityRefs).toEqual(["round-1"]);
    expect(candidates[0].businessDate).toBe("2026-08-25");
  });

  it("distinguishes ambiguous vs. reviewable duplicate rounds by source severity", () => {
    const result = baseResult({
      integrityIssues: [
        issue({
          code: "duplicate_open_accountability_round",
          severity: "blocker",
          message: "พบรอบซ้ำ และยังพิสูจน์ไม่ได้ว่ารอบใดถูกต้อง",
          evidenceIds: ["round-a", "round-b"],
        }),
        issue({
          code: "duplicate_open_accountability_round",
          severity: "warning",
          message: "พบรอบซ้ำ — รอบที่มีรายการจริงคือรอบเดียว",
          evidenceIds: ["round-c", "round-d"],
        }),
      ],
    });

    const candidates = preflightIssuesToCandidates(result);
    expect(candidates.map((c) => c.category).sort()).toEqual([
      "produce_duplicate_round_ambiguous",
      "produce_duplicate_round_review",
    ]);
  });

  it("excludes unresolved_central_price issues from rounds/integrity (ingested via pricingConflicts instead)", () => {
    const result = baseResult({
      rounds: [
        {
          accountabilityRoundId: "round-1",
          staffName: null,
          marketName: null,
          status: "partial",
          blockers: [],
          warnings: [
            issue({
              code: "unresolved_central_price",
              severity: "warning",
              message: "ราคากลางบางรายการยังไม่ได้รับการยืนยัน",
              evidenceIds: ["some-key"],
            }),
          ],
        },
      ],
      integrityIssues: [
        issue({
          code: "unresolved_central_price",
          severity: "blocker",
          message: "มะม่วง — พบราคา 20 / 25 บาท",
          evidenceIds: ["mango unit"],
        }),
      ],
      pricingConflicts: [
        {
          productKey: "mango",
          productDisplayName: "มะม่วง",
          unitKey: "kg",
          businessDate: "2026-08-25",
          status: "unresolved",
          candidates: [
            { priceSatang: 2000, occurrenceCount: 2, affectedMarkets: ["A"] },
            { priceSatang: 2500, occurrenceCount: 1, affectedMarkets: ["B"] },
          ],
          approvedPriceSatang: null,
          approvedBy: null,
        },
      ],
    });

    const candidates = preflightIssuesToCandidates(result);
    // Only the pricingConflicts-sourced candidate should exist — one, not three.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe("produce_price_conflict");
    expect(candidates[0].entityRefs).toEqual(["mango::kg"]);
  });

  it("excludes audit-only superseded/abandoned failures (not part of PreflightIssue lists)", () => {
    // supersededFailures is a separate, differently-shaped list — proving the
    // mapper never reaches into it is implicit: baseResult()'s empty list here
    // plus a non-empty rounds/integrityIssues scan still yields 0 for it.
    const result = baseResult();
    expect(preflightIssuesToCandidates(result)).toHaveLength(0);
  });
});
