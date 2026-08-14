import { describe, expect, test } from "bun:test";
import {
  activeFailureIds,
  classifyProduceFailure,
  classifyProduceFailures,
  type FinalizedProduceOutcome,
  type ProduceFailureAttempt,
} from "./failure-lifecycle";

function attempt(overrides: Partial<ProduceFailureAttempt> = {}): ProduceFailureAttempt {
  return {
    attemptId: "attempt-a",
    origin: "pending_session",
    businessDate: "2026-08-13",
    sourceId: "group:C1",
    staffLabel: "เมย์",
    marketLabel: "ทรัพย์พัน",
    transactionKind: "คืน",
    accountabilityRoundId: null,
    attemptedAtMs: 1_000,
    ...overrides,
  };
}

function outcome(overrides: Partial<FinalizedProduceOutcome> = {}): FinalizedProduceOutcome {
  return {
    produceSessionId: "session-b",
    businessDate: "2026-08-13",
    sourceId: "group:C1",
    staffLabel: "เมย์",
    marketLabel: "ทรัพย์พัน",
    transactionKind: "คืน",
    accountabilityRoundId: null,
    sessionKind: "main",
    finalizedAtMs: 2_000,
    ...overrides,
  };
}

describe("produce failure lifecycle", () => {
  test("a failure with no replacement stays active", () => {
    const result = classifyProduceFailure(attempt(), []);
    expect(result.state).toBe("active_failed");
    expect(result.supersededByProduceSessionId).toBeNull();
    expect(result.ambiguousSuccessor).toBe(false);
  });

  test("a later successful document with the same intent supersedes it", () => {
    const result = classifyProduceFailure(attempt(), [outcome()]);
    expect(result.state).toBe("superseded");
    expect(result.supersededByProduceSessionId).toBe("session-b");
  });

  test("several failed attempts are all superseded by the one success", () => {
    const results = classifyProduceFailures(
      [
        attempt({ attemptId: "a", attemptedAtMs: 1_000 }),
        attempt({ attemptId: "b", attemptedAtMs: 1_500 }),
      ],
      [outcome({ finalizedAtMs: 2_000 })],
    );
    expect(results.map((row) => row.state)).toEqual(["superseded", "superseded"]);
    expect(activeFailureIds(results).size).toBe(0);
  });

  test("a success in another market never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ marketLabel: "ราชพฤกษ์" })]);
    expect(result.state).toBe("active_failed");
  });

  test("a success by another seller never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ staffLabel: "จิ๋ว" })]);
    expect(result.state).toBe("active_failed");
  });

  test("a success from another LINE source never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ sourceId: "group:C2" })]);
    expect(result.state).toBe("active_failed");
  });

  test("a success on another business date never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ businessDate: "2026-08-12" })]);
    expect(result.state).toBe("active_failed");
  });

  test("a success of a different transaction kind never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ transactionKind: "เบิก" })]);
    expect(result.state).toBe("active_failed");
  });

  test("an earlier success never supersedes a later failure", () => {
    const result = classifyProduceFailure(
      attempt({ attemptedAtMs: 5_000 }),
      [outcome({ finalizedAtMs: 2_000 })],
    );
    expect(result.state).toBe("active_failed");
  });

  test("an additional batch is additive, never a replacement", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ sessionKind: "additional" })]);
    expect(result.state).toBe("active_failed");
  });

  test("two candidate successors fail closed and are flagged ambiguous", () => {
    const result = classifyProduceFailure(attempt(), [
      outcome({ produceSessionId: "s1", finalizedAtMs: 2_000 }),
      outcome({ produceSessionId: "s2", finalizedAtMs: 3_000 }),
    ]);
    expect(result.state).toBe("active_failed");
    expect(result.ambiguousSuccessor).toBe(true);
  });

  test("an unknown transaction kind can never be superseded", () => {
    const result = classifyProduceFailure(attempt({ transactionKind: null }), [outcome()]);
    expect(result.state).toBe("active_failed");
  });

  test("a missing identity dimension can never be superseded", () => {
    for (const missing of ["sourceId", "businessDate", "marketLabel", "staffLabel"] as const) {
      const result = classifyProduceFailure(attempt({ [missing]: null }), [outcome()]);
      expect(result.state).toBe("active_failed");
    }
  });

  test("an unprovable ordering can never be superseded", () => {
    expect(classifyProduceFailure(attempt({ attemptedAtMs: null }), [outcome()]).state)
      .toBe("active_failed");
    expect(classifyProduceFailure(attempt(), [outcome({ finalizedAtMs: null })]).state)
      .toBe("active_failed");
  });

  describe("round path", () => {
    const bound = attempt({ accountabilityRoundId: "round-1" });

    test("the same round and kind, later, is proof", () => {
      const result = classifyProduceFailure(bound, [
        outcome({ accountabilityRoundId: "round-1", marketLabel: "อะไรก็ได้" }),
      ]);
      expect(result.state).toBe("superseded");
    });

    test("another round never supersedes, however similar the labels", () => {
      const result = classifyProduceFailure(bound, [
        outcome({ accountabilityRoundId: "round-2" }),
      ]);
      expect(result.state).toBe("active_failed");
    });

    test("a bound attempt is never rescued by the label identity path", () => {
      // Same seller/market/date, but the success belongs to no round at all.
      const result = classifyProduceFailure(bound, [outcome({ accountabilityRoundId: null })]);
      expect(result.state).toBe("active_failed");
    });

    test("a retired round is abandoned, not an active failure", () => {
      const result = classifyProduceFailure(bound, [], {
        cancelledRoundIds: new Set(["round-1"]),
      });
      expect(result.state).toBe("abandoned");
      expect(result.ambiguousSuccessor).toBe(false);
    });
  });

  test("label comparison is normalized, not fuzzy", () => {
    expect(
      classifyProduceFailure(attempt({ marketLabel: " ทรัพย์พัน  " }), [outcome()]).state,
    ).toBe("superseded");
    // พุทรา and พุทราไทย are NOT the same identity — no silent aliasing here.
    expect(
      classifyProduceFailure(attempt({ marketLabel: "ทรัพย์พัน2" }), [outcome()]).state,
    ).toBe("active_failed");
  });
});
