import { describe, expect, test } from "bun:test";
import type {
  ProduceFailureAttempt,
  ProduceFailureClassification,
} from "@/lib/produce/failure-lifecycle";
import { collectUnattributableWithdrawalScopes } from "./unattributable-withdrawal";

const DATE = "2026-08-21";
const ROUND = "11111111-1111-4111-8111-111111111111";

function attempt(
  overrides: Partial<ProduceFailureAttempt> = {},
): ProduceFailureAttempt {
  return {
    attemptId: "attempt-1",
    origin: "raw_message",
    businessDate: DATE,
    sourceId: "Csource",
    staffLabel: null,
    marketLabel: null,
    transactionKind: "เบิก",
    accountabilityRoundId: null,
    attemptedAtMs: 1_000,
    sourceText: "1.ทับทิม25บาท\n26ลูก",
    ...overrides,
  };
}

function active(attemptId = "attempt-1"): ProduceFailureClassification {
  return {
    attemptId,
    state: "active_failed",
    supersededByProduceSessionId: null,
    ambiguousSuccessor: false,
  };
}

function superseded(attemptId = "attempt-1"): ProduceFailureClassification {
  return {
    attemptId,
    state: "superseded",
    supersededByProduceSessionId: "session-1",
    ambiguousSuccessor: false,
  };
}

describe("collectUnattributableWithdrawalScopes", () => {
  test("an item-only เบิก with a canonical product+unit scopes that identity", () => {
    const scopes = collectUnattributableWithdrawalScopes([attempt()], [active()]);
    expect(scopes).toEqual([
      { kind: "product_unit", productName: "ทับทิม", unit: "ลูก" },
    ]);
  });

  test("a named product with no unit poisons the whole product, not a guessed unit", () => {
    const scopes = collectUnattributableWithdrawalScopes([
      attempt({
        sourceText: ["โอม-ตลาด72 เบิก 21/8/2569", "15ปลาหวานงา", "100บาท", "จบรายการเบิก"].join("\n"),
      }),
    ], [active()]);
    expect(scopes).toEqual([{ kind: "product", productName: "ปลาหวานงา" }]);
    expect(scopes.some((scope) => scope.kind === "product_unit")).toBe(false);
  });

  test("a เบิก with no recoverable product falls back to its bound round", () => {
    const scopes = collectUnattributableWithdrawalScopes([
      attempt({ sourceText: "จบรายการเบิก", accountabilityRoundId: ROUND }),
    ], [active()]);
    expect(scopes).toEqual([{ kind: "round", roundId: ROUND }]);
  });

  test("a เบิก with neither product nor round fails closed at report level", () => {
    const scopes = collectUnattributableWithdrawalScopes([
      attempt({ sourceText: "สวัสดีครับ" }),
    ], [active()]);
    expect(scopes).toEqual([{ kind: "report" }]);
  });

  test("an unresolved คืน does not produce a เบิก scope", () => {
    const scopes = collectUnattributableWithdrawalScopes([
      attempt({
        transactionKind: "คืน",
        sourceText: ["โอม-ตลาด72 คืน 21/8/2569", "1.แอปเปิ้ล10บาท", "5ลูก", "จบรายการคืน"].join("\n"),
      }),
    ], [active()]);
    expect(scopes).toEqual([]);
  });

  test("a superseded เบิก does not double-poison a persisted equivalent", () => {
    const scopes = collectUnattributableWithdrawalScopes([attempt()], [superseded()]);
    expect(scopes).toEqual([]);
  });

  test("an attempt that is not in the day's classifications is ignored", () => {
    const scopes = collectUnattributableWithdrawalScopes(
      [attempt({ attemptId: "other-date", businessDate: "2026-08-20" })],
      [active("attempt-1")],
    );
    expect(scopes).toEqual([]);
  });
});
