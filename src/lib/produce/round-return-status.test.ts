/**
 * Missing-return classification — the four states Production 2026-08-10 held
 * at once and every report flattened into one silence.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyRoundReturns,
  hasCloserLine,
  pendingRowCanBeReturn,
  roundsWithIncompleteReturn,
  roundsWithPersistedReturn,
  type RoundReturnEvidence,
  type RoundWithdrawal,
} from "./round-return-status";

function round(overrides: Partial<RoundWithdrawal> = {}): RoundWithdrawal {
  return {
    accountabilityRoundId: "round-1",
    sellerLabel: "ต้อม",
    marketLabel: "พาชิโอ้",
    withdrawalItemCount: 19,
    hasPersistedReturn: false,
    ...overrides,
  };
}

function evidence(overrides: Partial<RoundReturnEvidence> = {}): RoundReturnEvidence {
  return {
    accountabilityRoundId: "round-1",
    finalizationStatus: "pending",
    closeAttempted: false,
    ...overrides,
  };
}

describe("closer detection", () => {
  test("recognises a closer line anywhere in the accumulated document", () => {
    expect(hasCloserLine("มิ้น-ทรัพย์พัน2 ชั่งคืน\n1.แอปเปิ้ล8บาท\nจบรายการชั่งคืน")).toBe(true);
    expect(hasCloserLine(" จบรายการ ")).toBe(true);
  });

  test("an open document is not a close attempt", () => {
    expect(hasCloserLine("ขวัญ-ราชพฤกษ์ ชั่งคืน\n1.แก้วมังกร35บาท")).toBe(false);
    expect(hasCloserLine(null)).toBe(false);
  });
});

test("a pending withdrawal in the round is not mistaken for missing return evidence", () => {
  expect(pendingRowCanBeReturn("เบิก", "เสือ ตลาดกี้ เบิก\n1.หมอนทอง\n10 โล")).toBe(false);
  expect(pendingRowCanBeReturn(null, "เสือ ตลาดกี้ คืน\n1.หมอนทอง\n2 โล")).toBe(true);
  expect(pendingRowCanBeReturn(null, null)).toBe(true);
});

describe("round return classification", () => {
  test("Test 3 — withdrawal with no return evidence at all stays the sold-out case", () => {
    // ต้อม / พาชิโอ้ทุเรียน: nothing was ever sent. The legitimate business
    // reading is unchanged; this classifier does not decide it was sold, only
    // that nothing is known to be missing.
    expect(classifyRoundReturns([round()], [])).toEqual([{ ...round(), state: "none" }]);
    expect(roundsWithIncompleteReturn(classifyRoundReturns([round()], []))).toEqual(new Set());
  });

  test("Test 4 — a closed-and-refused return is blocked, never absent", () => {
    // มิ้น / ทรัพย์พัน2: the full ชั่งคืน document carried its closer, P4A
    // refused it, and the pending row stayed unfinalized.
    const statuses = classifyRoundReturns(
      [round({ marketLabel: "ทรัพย์พัน2", sellerLabel: "มิ้น", withdrawalItemCount: 33 })],
      [evidence({ closeAttempted: true })],
    );
    expect(statuses[0]!.state).toBe("blocked");
    expect(roundsWithIncompleteReturn(statuses)).toEqual(new Set(["round-1"]));
  });

  test("a failed_closed finalization is blocked even with no closer text", () => {
    const statuses = classifyRoundReturns(
      [round()],
      [evidence({ finalizationStatus: "failed_closed" })],
    );
    expect(statuses[0]!.state).toBe("blocked");
  });

  test("Test 5 — an open, unclosed return document is pending", () => {
    // ขวัญ / ราชพฤกษ์ before the operator retried: the document existed and
    // had not been closed.
    const statuses = classifyRoundReturns([round()], [evidence()]);
    expect(statuses[0]!.state).toBe("pending");
    expect(roundsWithIncompleteReturn(statuses)).toEqual(new Set(["round-1"]));
  });

  test("Test 6 — a persisted return outranks any leftover evidence", () => {
    // ดำ / ทุ่งลานนา: the return landed. A stale pending row from a previous
    // document must not demote a round whose evidence is actually complete.
    const statuses = classifyRoundReturns(
      [round({ hasPersistedReturn: true })],
      [evidence({ closeAttempted: true })],
    );
    expect(statuses[0]!.state).toBe("persisted");
    expect(roundsWithIncompleteReturn(statuses)).toEqual(new Set());
    expect(roundsWithPersistedReturn(statuses)).toEqual(new Set(["round-1"]));
  });

  test("evidence is attributed per round, never day-wide", () => {
    const statuses = classifyRoundReturns(
      [round(), round({ accountabilityRoundId: "round-2", marketLabel: "ราชพฤกษ์" })],
      [evidence({ accountabilityRoundId: "round-2", closeAttempted: true })],
    );
    expect(statuses.map((row) => row.state)).toEqual(["none", "blocked"]);
  });

  test("blocked outranks pending when a round holds both kinds of evidence", () => {
    const statuses = classifyRoundReturns(
      [round()],
      [evidence(), evidence({ closeAttempted: true })],
    );
    expect(statuses[0]!.state).toBe("blocked");
  });
});
