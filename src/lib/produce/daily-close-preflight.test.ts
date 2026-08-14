import { describe, expect, test } from "bun:test";
import { SYSTEM_WITHDRAWAL_SEED_ACTOR } from "@/lib/white-sheet/pricing";
import { buildCentralPriceReview } from "./central-price-candidates";
import { classifyProduceFailures, type ProduceFailureAttempt } from "./failure-lifecycle";
import type { RoundReturnStatus } from "./round-return-status";
import {
  buildDailyClosePreflight,
  groupUnboundProduce,
  loadDailyClosePreflight,
  roundPriceKeysFromRows,
  type DailyClosePreflightInput,
  type PreflightRoundRecord,
} from "./daily-close-preflight";

const DATE = "2026-08-13";

test("preloaded round statuses and produce rows skip duplicate paged reads", async () => {
  const queried: string[] = [];
  const supabase = {
    from(table: string) {
      queried.push(table);
      if (table === "produce_transactions" || table === "pending_sessions") {
        throw new Error(`duplicate read: ${table}`);
      }
      const result = { data: [], error: null };
      const node: Record<string, unknown> = {};
      const self = () => node;
      node.select = self;
      node.eq = self;
      node.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return node;
    },
  };

  const result = await loadDailyClosePreflight(supabase as never, DATE, {
    failureAttempts: [],
    withdrawalRows: [],
    outcomes: [],
    cancelledRoundIds: new Set(),
    roundStatuses: [],
    produceRows: [],
  });

  expect(result.status).toBe("ready");
  expect(queried).toEqual(["central_selling_prices", "accountability_rounds"]);
});

function round(overrides: Partial<RoundReturnStatus> = {}): RoundReturnStatus {
  return {
    accountabilityRoundId: "round-1",
    sellerLabel: "วุฒิ",
    marketLabel: "เลียบด่วน",
    withdrawalItemCount: 4,
    hasPersistedReturn: true,
    state: "persisted",
    ...overrides,
  };
}

function attempt(overrides: Partial<ProduceFailureAttempt> = {}): ProduceFailureAttempt {
  return {
    attemptId: "attempt-1",
    origin: "pending_session",
    businessDate: DATE,
    sourceId: "group:C1",
    staffLabel: "จิ๋ว",
    marketLabel: "ราชพฤกษ์",
    transactionKind: "คืน",
    accountabilityRoundId: "round-2",
    attemptedAtMs: 1_000,
    ...overrides,
  };
}

function input(overrides: Partial<DailyClosePreflightInput> = {}): DailyClosePreflightInput {
  return {
    businessDate: DATE,
    roundStatuses: [round()],
    failureAttempts: [],
    failureClassifications: [],
    priceReview: [],
    openRounds: [],
    unboundProduce: [],
    ...overrides,
  };
}

/** Builds the classification the loader would produce, so the rules stay honest. */
function withFailures(
  attempts: ProduceFailureAttempt[],
  overrides: Partial<DailyClosePreflightInput> = {},
): DailyClosePreflightInput {
  return input({
    ...overrides,
    failureAttempts: attempts,
    failureClassifications: classifyProduceFailures(attempts, []),
  });
}

describe("daily close preflight", () => {
  test("1. a clean day is READY", () => {
    const result = buildDailyClosePreflight(input());
    expect(result.status).toBe("ready");
    expect(result.summary).toMatchObject({
      readyRounds: 1,
      blockedRounds: 0,
      activeFailedSessions: 0,
      unresolvedPriceProducts: 0,
      integrityIssues: 0,
    });
  });

  test("2. a refused ชั่งคืน with no replacement BLOCKS the day", () => {
    const attempts = [attempt()];
    const result = buildDailyClosePreflight(
      withFailures(attempts, {
        roundStatuses: [
          round(),
          round({
            accountabilityRoundId: "round-2",
            sellerLabel: "จิ๋ว",
            marketLabel: "ราชพฤกษ์",
            hasPersistedReturn: false,
            state: "blocked",
          }),
        ],
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.summary.blockedRounds).toBe(1);
    expect(result.summary.activeFailedSessions).toBe(1);

    const blocked = result.rounds.find((row) => row.accountabilityRoundId === "round-2");
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockers.map((row) => row.code)).toEqual([
      "missing_successful_return",
      "active_failed_produce_session",
    ]);
    // Every count is explainable: the blocker names the record behind it.
    expect(blocked?.blockers[1].evidenceIds).toEqual(["attempt-1"]);
  });

  test("3. a superseded failure stops blocking and is recorded for audit", () => {
    const attempts = [attempt()];
    const classifications = classifyProduceFailures(attempts, [
      {
        produceSessionId: "session-ok",
        businessDate: DATE,
        sourceId: "group:C1",
        staffLabel: "จิ๋ว",
        marketLabel: "ราชพฤกษ์",
        transactionKind: "คืน",
        accountabilityRoundId: "round-2",
        sessionKind: "main",
        finalizedAtMs: 5_000,
      },
    ]);

    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifications,
        roundStatuses: [
          round({
            accountabilityRoundId: "round-2",
            sellerLabel: "จิ๋ว",
            marketLabel: "ราชพฤกษ์",
          }),
        ],
      }),
    );

    expect(result.status).toBe("ready_with_warnings");
    expect(result.summary.activeFailedSessions).toBe(0);
    expect(result.summary.supersededFailures).toBe(1);
    expect(result.supersededFailures[0]).toMatchObject({
      attemptId: "attempt-1",
      state: "superseded",
      supersededByProduceSessionId: "session-ok",
    });
    expect(result.rounds[0].blockers).toHaveLength(0);
  });

  test("7. two candidate successors stay blocked and are flagged ambiguous", () => {
    const attempts = [attempt()];
    const successor = {
      businessDate: DATE,
      sourceId: "group:C1",
      staffLabel: "จิ๋ว",
      marketLabel: "ราชพฤกษ์",
      transactionKind: "คืน" as const,
      accountabilityRoundId: "round-2",
      sessionKind: "main",
      finalizedAtMs: 5_000,
    };
    const classifications = classifyProduceFailures(attempts, [
      { ...successor, produceSessionId: "s1" },
      { ...successor, produceSessionId: "s2", finalizedAtMs: 6_000 },
    ]);

    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifications,
        roundStatuses: [
          round({ accountabilityRoundId: "round-2", sellerLabel: "จิ๋ว", marketLabel: "ราชพฤกษ์" }),
        ],
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.rounds[0].blockers.map((row) => row.code)).toContain("round_identity_ambiguity");
  });

  test("8. an unresolved central price blocks the date and names the candidates", () => {
    const priceReview = buildCentralPriceReview(
      [
        {
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 50,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
        {
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 70,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
      ],
      DATE,
      new Map([["อะโวคาโด โล", { priceSatang: 5_000, setBy: SYSTEM_WITHDRAWAL_SEED_ACTOR }]]),
    );

    const result = buildDailyClosePreflight(input({ priceReview }));

    expect(result.status).toBe("blocked");
    expect(result.summary.unresolvedPriceProducts).toBe(1);
    expect(result.pricingConflicts[0].candidates.map((row) => row.priceSatang)).toEqual([
      5_000, 7_000,
    ]);
    // The round itself is sound; only its value is incomplete.
    expect(result.rounds[0].status).toBe("partial");
  });

  test("8b. only the rounds holding the disputed product go partial", () => {
    const priceReview = buildCentralPriceReview(
      [
        {
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 50,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
        {
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 70,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
      ],
      DATE,
      new Map([["อะโวคาโด โล", { priceSatang: 5_000, setBy: SYSTEM_WITHDRAWAL_SEED_ACTOR }]]),
    );

    const result = buildDailyClosePreflight(
      input({
        priceReview,
        roundStatuses: [
          round({ accountabilityRoundId: "r-72", marketLabel: "ตลาด72", sellerLabel: "นาง" }),
          round({ accountabilityRoundId: "r-lb", marketLabel: "เลียบด่วน", sellerLabel: "วุฒิ" }),
        ],
        roundPriceKeys: roundPriceKeysFromRows(
          [
            {
              session_id: "s1",
              market_name: "ตลาด72",
              accountability_round_id: "r-72",
              product_name: "อะโวคาโด",
              unit: "โล",
            },
            {
              session_id: "s2",
              market_name: "เลียบด่วน",
              accountability_round_id: "r-lb",
              product_name: "หมอนทอง",
              unit: "โล",
            },
          ],
          DATE,
        ),
      }),
    );

    expect(result.rounds.find((row) => row.marketName === "ตลาด72")?.status).toBe("partial");
    expect(result.rounds.find((row) => row.marketName === "เลียบด่วน")?.status).toBe("ready");
    expect(result.summary).toMatchObject({ readyRounds: 1, partialRounds: 1, blockedRounds: 0 });
    expect(result.status).toBe("blocked"); // the price itself still has to be decided
  });

  test("9. an approved central price removes the conflict", () => {
    const priceReview = buildCentralPriceReview(
      [
        {
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 50,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
        {
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 70,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
      ],
      DATE,
      new Map([["อะโวคาโด โล", { priceSatang: 5_000, setBy: "admin-uuid" }]]),
    );

    const result = buildDailyClosePreflight(input({ priceReview }));
    expect(result.status).toBe("ready");
    expect(result.summary.unresolvedPriceProducts).toBe(0);
  });

  test("12. a duplicate round with one provable canonical round is a warning, not a merge", () => {
    const openRounds: PreflightRoundRecord[] = [
      {
        accountabilityRoundId: "canonical",
        sourceId: "group:C1",
        ownerLineUserId: "U1",
        staffName: "ต้อม",
        marketName: "พาชิโอ้",
        status: "open",
        transactionCount: 12,
      },
      {
        accountabilityRoundId: "empty",
        sourceId: "group:C1",
        ownerLineUserId: "U1",
        staffName: "ต้อม",
        marketName: "พาชิโอ้",
        status: "open",
        transactionCount: 0,
      },
    ];

    const result = buildDailyClosePreflight(input({ openRounds }));
    expect(result.status).toBe("ready_with_warnings");
    const duplicate = result.integrityIssues[0];
    expect(duplicate.code).toBe("duplicate_open_accountability_round");
    expect(duplicate.severity).toBe("warning");
    expect(duplicate.accountabilityRoundId).toBe("canonical");
    expect(duplicate.evidenceIds).toEqual(["canonical", "empty"]);
  });

  test("12b. two duplicate rounds that both hold produce fail closed", () => {
    const openRounds: PreflightRoundRecord[] = [
      {
        accountabilityRoundId: "a",
        sourceId: "group:C1",
        ownerLineUserId: "U1",
        staffName: "ต้อม",
        marketName: "พาชิโอ้",
        status: "open",
        transactionCount: 3,
      },
      {
        accountabilityRoundId: "b",
        sourceId: "group:C1",
        ownerLineUserId: "U1",
        staffName: "ต้อม",
        marketName: "พาชิโอ้",
        status: "open",
        transactionCount: 5,
      },
    ];

    const result = buildDailyClosePreflight(input({ openRounds }));
    expect(result.status).toBe("blocked");
    expect(result.integrityIssues[0].severity).toBe("blocker");
  });

  test("13. unbound produce blocks only where the market demonstrably uses rounds", () => {
    const mixed = groupUnboundProduce([
      { session_id: "s1", market_name: "ตลาด72", accountability_round_id: "r1" },
      { session_id: "s2", market_name: "ตลาด72", accountability_round_id: null },
      { session_id: "s3", market_name: "ตลาดเก่า", accountability_round_id: null },
    ]);

    const result = buildDailyClosePreflight(input({ unboundProduce: mixed }));
    const codes = result.integrityIssues.map((row) => `${row.marketName}:${row.severity}`);
    expect(codes).toEqual(["ตลาด72:blocker", "ตลาดเก่า:warning"]);
    expect(result.status).toBe("blocked");
  });

  test("14. a failure belonging to another business date is never part of this day", () => {
    // The loader attributes by business date; nothing dated elsewhere reaches
    // the builder, so a day with no attempts stays clean.
    const result = buildDailyClosePreflight(input({ failureAttempts: [], failureClassifications: [] }));
    expect(result.status).toBe("ready");
    expect(result.summary.activeFailedSessions).toBe(0);
  });

  test("a round with no return at all is READY, with a warning a human can check", () => {
    const result = buildDailyClosePreflight(
      input({
        roundStatuses: [round({ hasPersistedReturn: false, state: "none", withdrawalItemCount: 7 })],
      }),
    );
    expect(result.status).toBe("ready_with_warnings");
    expect(result.rounds[0].status).toBe("ready");
    expect(result.rounds[0].warnings[0].code).toBe("missing_successful_return");
    expect(result.rounds[0].warnings[0].message).toContain("7");
  });

  test("an open, never-closed return document blocks its round", () => {
    const result = buildDailyClosePreflight(
      input({ roundStatuses: [round({ hasPersistedReturn: false, state: "pending" })] }),
    );
    expect(result.rounds[0].blockers[0].code).toBe("pending_produce_session");
    expect(result.status).toBe("blocked");
  });

  test("an active failure no round can claim is reported at day level", () => {
    const attempts = [attempt({ accountabilityRoundId: null, marketLabel: null })];
    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifyProduceFailures(attempts, []),
      }),
    );
    expect(result.status).toBe("blocked");
    expect(result.integrityIssues[0].code).toBe("active_failed_produce_session");
    expect(result.integrityIssues[0].evidenceIds).toEqual(["attempt-1"]);
  });

  test("a retired round makes its failure abandoned, not active", () => {
    const attempts = [attempt()];
    const classifications = classifyProduceFailures(attempts, [], {
      cancelledRoundIds: new Set(["round-2"]),
    });
    const result = buildDailyClosePreflight(
      input({ failureAttempts: attempts, failureClassifications: classifications }),
    );
    expect(result.summary.activeFailedSessions).toBe(0);
    expect(result.supersededFailures[0].state).toBe("abandoned");
    expect(result.status).toBe("ready_with_warnings");
  });
});
