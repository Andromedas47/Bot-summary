import { describe, expect, it } from "bun:test";
import type {
  DailyClosePreflightResult,
  PreflightRoundStatus,
} from "@/lib/produce/daily-close-preflight";
import { settlementProduceValueStatus } from "./produce-value-status";

function preflight(
  rounds: Array<{
    accountabilityRoundId: string;
    staffName: string;
    marketName: string;
    status: PreflightRoundStatus;
  }>,
  integrityIssues: DailyClosePreflightResult["integrityIssues"] = [],
): DailyClosePreflightResult {
  return {
    businessDate: "2026-08-24",
    status: rounds.some((round) => round.status === "blocked")
      ? "blocked"
      : rounds.some((round) => round.status === "partial")
        ? "ready_with_warnings"
        : "ready",
    summary: {
      readyRounds: rounds.filter((round) => round.status === "ready").length,
      partialRounds: rounds.filter((round) => round.status === "partial").length,
      blockedRounds: rounds.filter((round) => round.status === "blocked").length,
      unresolvedPriceProducts: 0,
      activeFailedSessions: 0,
      supersededFailures: 0,
      integrityIssues: 0,
    },
    rounds: rounds.map((round) => ({ ...round, blockers: [], warnings: [] })),
    pricingConflicts: [],
    supersededFailures: [],
    integrityIssues,
  };
}

const IDENTITY = {
  accountabilityRoundId: "round-a",
  staffName: "ป้อม",
  marketName: "วัดทุ่งลานนา2",
};

describe("settlement Produce value confidence", () => {
  it.each([
    ["ready", "complete"],
    ["partial", "partial"],
    ["blocked", "blocked"],
  ] as const)("maps a %s round without recalculating its money", (roundStatus, expected) => {
    const result = settlementProduceValueStatus(preflight([{
      ...IDENTITY,
      accountabilityRoundId: "round-a",
      status: roundStatus,
    }]), IDENTITY, 3);
    expect(result).toBe(expected);
  });

  it("treats no effective rows as missing rather than a genuine zero", () => {
    expect(settlementProduceValueStatus(preflight([{
      ...IDENTITY,
      accountabilityRoundId: "round-a",
      status: "ready",
    }]), IDENTITY, 0)).toBe("missing");
  });

  it("does not let another market's blocked round leak into a ready round", () => {
    const result = settlementProduceValueStatus(preflight([
      { ...IDENTITY, accountabilityRoundId: "round-a", status: "ready" },
      {
        accountabilityRoundId: "round-b",
        staffName: "ดา",
        marketName: "ตลาดอื่น",
        status: "blocked",
      },
    ]), IDENTITY, 4);
    expect(result).toBe("complete");
  });

  it("blocks an exact duplicate integrity issue on the matched ready round", () => {
    const result = settlementProduceValueStatus(preflight([{
      ...IDENTITY,
      accountabilityRoundId: "round-a",
      status: "ready",
    }], [{
      code: "exact_duplicate_withdrawal",
      severity: "blocker",
      message: "duplicate",
      accountabilityRoundId: "round-a",
      staffName: "ป้อม",
      marketName: "วัดทุ่งลานนา2",
    }]), IDENTITY, 6);
    expect(result).toBe("blocked");
  });

  it("does not leak another market's integrity blocker into the matched round", () => {
    const result = settlementProduceValueStatus(preflight([{
      ...IDENTITY,
      accountabilityRoundId: "round-a",
      status: "ready",
    }], [{
      code: "exact_duplicate_withdrawal",
      severity: "blocker",
      message: "duplicate elsewhere",
      accountabilityRoundId: "round-b",
      staffName: "ดา",
      marketName: "ตลาดอื่น",
    }]), IDENTITY, 4);
    expect(result).toBe("complete");
  });

  it("keeps a truly unattributed active failure fail-closed", () => {
    const result = settlementProduceValueStatus(preflight([{
      ...IDENTITY,
      accountabilityRoundId: "round-a",
      status: "ready",
    }], [{
      code: "active_failed_produce_session",
      severity: "blocker",
      message: "unattributed",
    }]), IDENTITY, 4);
    expect(result).toBe("blocked");
  });

  it("fails closed when rows cannot be matched to exactly one trusted round", () => {
    expect(settlementProduceValueStatus(preflight([]), IDENTITY, 1)).toBe("blocked");
  });
});
