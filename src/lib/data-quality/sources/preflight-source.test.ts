import { describe, expect, it } from "bun:test";
import type { DailyClosePreflightResult, PreflightIssue } from "@/lib/produce/daily-close-preflight";
import type { DataQualityCategory } from "../severity";
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
  it("does not create a candidate for a clean whole-round no-return warning", () => {
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
    expect(candidates).toEqual([]);
  });

  it("does not create a candidate when a persisted-return round has no omission issue", () => {
    const result = baseResult({
      rounds: [
        {
          accountabilityRoundId: "round-persisted",
          staffName: "สมชาย",
          marketName: "ตลาดเช้า",
          status: "ready",
          blockers: [],
          warnings: [],
        },
      ],
    });

    expect(preflightIssuesToCandidates(result)).toEqual([]);
  });

  it("keeps blocked, failed, pending, unattributable, and integrity findings actionable", () => {
    const result = baseResult({
      rounds: [
        {
          accountabilityRoundId: "round-blocked",
          staffName: "สมชาย",
          marketName: "ตลาดเช้า",
          status: "blocked",
          blockers: [
            issue({
              code: "missing_successful_return",
              severity: "blocker",
              message: "พบการส่งชั่งคืน แต่ยังบันทึกไม่สำเร็จ",
              accountabilityRoundId: "round-blocked",
              evidenceIds: ["round-blocked"],
            }),
          ],
          warnings: [],
        },
        {
          accountabilityRoundId: "round-failed",
          staffName: "สมชาย",
          marketName: "ตลาดเช้า",
          status: "blocked",
          blockers: [
            issue({
              code: "active_failed_produce_session",
              severity: "blocker",
              message: "มีรายการที่บันทึกไม่สำเร็จ",
              accountabilityRoundId: "round-failed",
              evidenceIds: ["attempt-1"],
            }),
          ],
          warnings: [],
        },
        {
          accountabilityRoundId: "round-pending",
          staffName: "สมชาย",
          marketName: "ตลาดเช้า",
          status: "blocked",
          blockers: [
            issue({
              code: "pending_produce_session",
              severity: "blocker",
              message: "มีรายการชั่งคืนที่ยังปิดไม่สำเร็จ",
              accountabilityRoundId: "round-pending",
              evidenceIds: ["round-pending"],
            }),
          ],
          warnings: [],
        },
      ],
      integrityIssues: [
        issue({
          code: "unbound_produce_transaction",
          severity: "warning",
          message: "มีรายการที่ไม่ได้ผูกกับรอบ",
          evidenceIds: ["session-unbound"],
        }),
        issue({
          code: "round_identity_ambiguity",
          severity: "blocker",
          message: "พบรายการที่อาจมาแทนกันมากกว่า 1 ชุด",
          evidenceIds: ["attempt-ambiguous"],
        }),
      ],
    });

    const expected: DataQualityCategory[] = [
      "produce_lifecycle_ambiguity",
      "produce_no_return",
      "produce_stale_failed_session",
      "produce_stale_failed_session",
      "produce_unattributable",
    ];
    expect(preflightIssuesToCandidates(result).map((candidate) => candidate.category).sort()).toEqual(expected.sort());
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

  it("keeps superseded success audit-only and does not create a candidate", () => {
    const result = baseResult({
      supersededFailures: [
        {
          attemptId: "attempt-superseded",
          origin: "pending_session",
          supersededByProduceSessionId: "session-success",
          state: "superseded",
          marketName: "ตลาดเช้า",
          staffName: "สมชาย",
        },
      ],
    });

    expect(preflightIssuesToCandidates(result)).toHaveLength(0);
  });
});
