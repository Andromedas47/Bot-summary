/**
 * P3 profitability service tests.
 *
 * Scope: what the SERVICE owns — argument validation before the call, argument
 * marshalling into each RPC, error mapping, and fail-closed handling of the
 * response, against a fake Supabase client. The profitability semantics
 * themselves (COGS residual, damage rate, reason derivation, revisioning,
 * dedupe, grants) live in SQL and belong in a PostgreSQL test. Re-implementing
 * those rules as a JS fake here would only test the fake.
 *
 * The through-line of every case below: money is a decimal string, `null` means
 * "not provable", and neither may be quietly converted into the other.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  mapProfitabilityRpcError,
  ProfitabilityAppendOnlyViolationError,
  ProfitabilityCrossRoundArtifactError,
  ProfitabilityInvalidAttributionError,
  ProfitabilityInvalidInputError,
  ProfitabilityInvalidSatangInputError,
  ProfitabilityMissingCalculationVersionError,
  ProfitabilityNegativeSoldQuantityError,
  ProfitabilityRequiredArtifactUnboundError,
  ProfitabilityRoundNotFoundError,
  ProfitabilityService,
} from "./profitability-service";
import {
  PROFITABILITY_CALCULATION_VERSION,
  PROFITABILITY_INCOMPLETE_REASONS,
  type ProfitabilityQuantityAttribution,
} from "./types";
import { ProfitabilityContractViolationError } from "./validate";

type RpcCall = { fn: string; args: Record<string, unknown> };

function makeStub(
  responses: Record<string, { data?: unknown; error?: { message: string } }>,
) {
  const calls: RpcCall[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      const response = responses[fn] ?? { data: null };
      return Promise.resolve({
        data: response.data ?? null,
        error: response.error ?? null,
      });
    },
  } as unknown as SupabaseClient<Database>;
  return { client, calls };
}

const ROUND_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCE_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCE_ITEM_ID_2 = "44444444-4444-4444-8444-444444444444";
const TRANSFER_SOURCE_ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT_ID = "66666666-6666-4666-8666-666666666666";
const PRIOR_SNAPSHOT_ID = "77777777-7777-4777-8777-777777777777";

const INPUT_HASH = "a".repeat(64);

// More precision than an IEEE-754 double can hold exactly (2^53 - 1 has 16
// digits). If any of these ever passed through a JS number, they would come
// back rounded and these string comparisons would fail.
const HUGE_SATANG = "123456789012345678901234";
const HUGE_NEGATIVE_SATANG = "-123456789012345678901234";

const ATTRIBUTION: ProfitabilityQuantityAttribution = {
  produceItemId: PRODUCE_ITEM_ID,
  locationCode: "MAIN",
  productKey: "mango",
  unitKey: "kg",
};

const POSTED_OK = {
  replayed: false,
  snapshot_id: SNAPSHOT_ID,
  accountability_round_id: ROUND_ID,
  revision: 1,
  certification_state: "CERTIFIED",
  incomplete_reasons: [],
};

const POSTED_INCOMPLETE = {
  replayed: false,
  snapshot_id: SNAPSHOT_ID,
  accountability_round_id: ROUND_ID,
  revision: 2,
  certification_state: "INCOMPLETE",
  incomplete_reasons: ["missing_central_price", "white_sheet_missing"],
};

/** A CERTIFIED snapshot: every term proven, no reasons, no nulls in the P/L set. */
const SNAPSHOT_OK = {
  snapshot_id: SNAPSHOT_ID,
  accountability_round_id: ROUND_ID,
  revision: 3,
  calculation_version: PROFITABILITY_CALCULATION_VERSION,
  input_hash: INPUT_HASH,
  certification_state: "CERTIFIED",
  incomplete_reasons: [],
  superseded_by_snapshot_id: null,
  created_at: "2026-08-08T03:00:00+00:00",
  issued_quantity: "120.500000",
  good_return_quantity: "10.000000",
  damaged_quantity: "0.500000",
  sold_quantity: "110.000000",
  issued_cost_satang: HUGE_SATANG,
  good_return_cost_satang: "1000",
  damage_loss_satang: "250",
  cogs_sold_satang: "98750",
  expected_money_satang: "150000",
  standard_margin_satang: "51250",
  approved_expenses_satang: "3000",
  approved_wages_satang: "5000",
  purchasing_expenses_satang: "2000",
  expected_operating_pl_satang: "41000",
  verified_transfers_satang: "40000",
  actual_cash_satang: "99000",
  shortage_overage_satang: HUGE_NEGATIVE_SATANG,
  realized_pl_satang: "-2000",
  lines: [
    {
      line_ordinal: 1,
      location_code: "MAIN",
      product_key: "mango",
      unit_key: "kg",
      issued_quantity: "120.500000",
      good_return_quantity: "10.000000",
      damaged_quantity: "0.500000",
      sold_quantity: "110.000000",
      issued_ledger_quantity: "120.500000",
      price_satang: "1500",
      issued_cost_satang: HUGE_SATANG,
      good_return_cost_satang: "1000",
      damage_loss_satang: "250",
      cogs_sold_satang: "98750",
      expected_money_satang: "150000",
      incomplete_reasons: [],
    },
  ],
  sources: [
    { artifact_kind: "produce_item", artifact_id: PRODUCE_ITEM_ID },
    { artifact_kind: "central_selling_price", artifact_id: RECEIPT_ID },
  ],
};

/** An INCOMPLETE snapshot: nothing provable, so every money term is null. */
const SNAPSHOT_INCOMPLETE = {
  ...SNAPSHOT_OK,
  revision: 4,
  certification_state: "INCOMPLETE",
  incomplete_reasons: ["missing_central_price", "white_sheet_missing"],
  superseded_by_snapshot_id: PRIOR_SNAPSHOT_ID,
  issued_cost_satang: null,
  good_return_cost_satang: null,
  damage_loss_satang: null,
  cogs_sold_satang: null,
  expected_money_satang: null,
  standard_margin_satang: null,
  approved_expenses_satang: null,
  approved_wages_satang: null,
  purchasing_expenses_satang: null,
  expected_operating_pl_satang: null,
  verified_transfers_satang: null,
  actual_cash_satang: null,
  shortage_overage_satang: null,
  realized_pl_satang: null,
  lines: [
    {
      ...SNAPSHOT_OK.lines[0],
      issued_ledger_quantity: null,
      price_satang: null,
      issued_cost_satang: null,
      good_return_cost_satang: null,
      damage_loss_satang: null,
      cogs_sold_satang: null,
      expected_money_satang: null,
      incomplete_reasons: ["issue_movement_unbound", "missing_central_price"],
    },
  ],
};

/**
 * Awaits a call that MUST reject and hands back what it threw.
 *
 * A resolved promise fails loudly here rather than yielding a value the
 * assertions would then quietly interrogate for a `path` it never had.
 */
async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function service(responses: Record<string, { data?: unknown; error?: { message: string } }>) {
  const stub = makeStub(responses);
  return { service: new ProfitabilityService(stub.client), calls: stub.calls };
}

describe("ProfitabilityService.recordSnapshot — argument marshalling", () => {
  test("marshals every argument into snake_case and parses the response", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });

    const result = await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
      verifiedTransfersSatang: "40000",
      verifiedTransferSourceIds: [TRANSFER_SOURCE_ID],
      purchasingExpensesSatang: "2000",
      purchasingExpenseReceiptIds: [RECEIPT_ID],
      actor: "staff-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("record_profitability_snapshot");
    expect(calls[0]!.args).toEqual({
      p_accountability_round_id: ROUND_ID,
      p_quantity_attributions: [
        {
          produce_item_id: PRODUCE_ITEM_ID,
          location_code: "MAIN",
          product_key: "mango",
          unit_key: "kg",
        },
      ],
      p_verified_transfers_satang: "40000",
      p_verified_transfer_source_ids: [TRANSFER_SOURCE_ID],
      p_purchasing_expenses_satang: "2000",
      p_purchasing_expense_receipt_ids: [RECEIPT_ID],
      p_calculation_version: PROFITABILITY_CALCULATION_VERSION,
      p_actor: "staff-1",
    });
    expect(result.snapshotId).toBe(SNAPSHOT_ID);
    expect(result.revision).toBe(1);
    expect(result.certificationState).toBe("CERTIFIED");
  });

  test("satang arguments stay decimal strings — never converted to numbers", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
      verifiedTransfersSatang: HUGE_SATANG,
      purchasingExpensesSatang: "2000",
    });
    expect(calls[0]!.args.p_verified_transfers_satang).toBe(HUGE_SATANG);
    expect(typeof calls[0]!.args.p_verified_transfers_satang).toBe("string");
  });

  test("omitted satang arguments are sent as null, never as 0", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_INCOMPLETE },
    });
    await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
    });
    expect(calls[0]!.args.p_verified_transfers_satang).toBeNull();
    expect(calls[0]!.args.p_purchasing_expenses_satang).toBeNull();
    expect(calls[0]!.args.p_verified_transfer_source_ids).toEqual([]);
    expect(calls[0]!.args.p_purchasing_expense_receipt_ids).toEqual([]);
    expect(calls[0]!.args.p_actor).toBeNull();
  });

  test("an explicit null satang argument is preserved as null, not defaulted", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_INCOMPLETE },
    });
    await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
      verifiedTransfersSatang: null,
      purchasingExpensesSatang: null,
    });
    expect(calls[0]!.args.p_verified_transfers_satang).toBeNull();
    expect(calls[0]!.args.p_purchasing_expenses_satang).toBeNull();
  });

  test("an empty attribution list is passed through — the RPC, not this client, judges it", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_INCOMPLETE },
    });
    await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [],
    });
    expect(calls[0]!.args.p_quantity_attributions).toEqual([]);
  });

  test("a caller-supplied calculation version overrides the default", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
      calculationVersion: "p3:v2",
    });
    expect(calls[0]!.args.p_calculation_version).toBe("p3:v2");
  });
});

describe("ProfitabilityService.recordSnapshot — accountabilityRoundId is the identity", () => {
  test("a missing round id is refused before any network call", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: undefined as unknown as string,
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
    expect(calls).toHaveLength(0);
  });

  test("a blank round id is refused — there is no legacy tuple path to fall back to", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: "   ",
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
    expect(calls).toHaveLength(0);
  });

  test("a non-UUID round id is refused", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: "round-2026-08-08-main",
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
  });
});

describe("ProfitabilityService.recordSnapshot — attribution shape", () => {
  const badAttributions: ReadonlyArray<[string, ProfitabilityQuantityAttribution]> = [
    ["non-UUID produceItemId", { ...ATTRIBUTION, produceItemId: "item-7" }],
    [
      "missing produceItemId",
      { ...ATTRIBUTION, produceItemId: undefined as unknown as string },
    ],
    ["blank locationCode", { ...ATTRIBUTION, locationCode: "  " }],
    ["blank productKey", { ...ATTRIBUTION, productKey: "" }],
    ["blank unitKey", { ...ATTRIBUTION, unitKey: "\t" }],
    ["numeric productKey", { ...ATTRIBUTION, productKey: 7 as unknown as string }],
  ];

  for (const [label, attribution] of badAttributions) {
    test(`refuses an attribution with a ${label}`, async () => {
      const { service: subject, calls } = service({
        record_profitability_snapshot: { data: POSTED_OK },
      });
      await expect(
        subject.recordSnapshot({
          accountabilityRoundId: ROUND_ID,
          quantityAttributions: [attribution],
        }),
      ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
      expect(calls).toHaveLength(0);
    });
  }

  test("the failing path names the offending index, not just the array", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    const error = await captureRejection(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [
          { ...ATTRIBUTION, produceItemId: PRODUCE_ITEM_ID_2 },
          { ...ATTRIBUTION, unitKey: "" },
        ],
      }),
    );
    expect(error).toBeInstanceOf(ProfitabilityInvalidInputError);
    expect((error as ProfitabilityInvalidInputError).path).toBe(
      "recordSnapshot.quantityAttributions[1].unitKey",
    );
  });

  test("a non-array attribution argument is refused", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: ATTRIBUTION as unknown as ProfitabilityQuantityAttribution[],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
  });
});

describe("ProfitabilityService.recordSnapshot — satang arguments are exact strings", () => {
  const badSatang: ReadonlyArray<[string, unknown]> = [
    ["a JS number", 40000],
    ["a large JS number", 123456789012345678901234],
    ["a fractional string", "150.5"],
    ["a fractional string ending in .0", "150.0"],
    ["a negative exact string", "-500"],
    ["exponent notation", "1e3"],
    ["a padded string", " 150 "],
    ["a non-numeric string", "40000บาท"],
    ["an empty string", ""],
    ["NaN", Number.NaN],
    ["a boolean", true],
  ];

  for (const [label, value] of badSatang) {
    test(`refuses verifiedTransfersSatang given ${label}`, async () => {
      const { service: subject, calls } = service({
        record_profitability_snapshot: { data: POSTED_OK },
      });
      await expect(
        subject.recordSnapshot({
          accountabilityRoundId: ROUND_ID,
          quantityAttributions: [ATTRIBUTION],
          verifiedTransfersSatang: value as string,
        }),
      ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
      expect(calls).toHaveLength(0);
    });

    test(`refuses purchasingExpensesSatang given ${label}`, async () => {
      const { service: subject } = service({
        record_profitability_snapshot: { data: POSTED_OK },
      });
      await expect(
        subject.recordSnapshot({
          accountabilityRoundId: ROUND_ID,
          quantityAttributions: [ATTRIBUTION],
          purchasingExpensesSatang: value as string,
        }),
      ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
    });
  }

  test("zero is accepted — a proven zero is not the same fact as an absent figure", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
      verifiedTransfersSatang: "0",
    });
    expect(calls[0]!.args.p_verified_transfers_satang).toBe("0");
  });
});

describe("ProfitabilityService.recordSnapshot — source id arrays", () => {
  test("a non-UUID transfer source id is refused", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [ATTRIBUTION],
        verifiedTransferSourceIds: [TRANSFER_SOURCE_ID, "slip-42"],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
    expect(calls).toHaveLength(0);
  });

  test("a non-UUID purchasing receipt id is refused", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: { data: POSTED_OK },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [ATTRIBUTION],
        purchasingExpenseReceiptIds: ["receipt-1"],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
  });
});

describe("ProfitabilityService.recordSnapshot — response handling", () => {
  test("an idempotent replay is returned faithfully, never retried into a new revision", async () => {
    const { service: subject, calls } = service({
      record_profitability_snapshot: {
        data: { ...POSTED_OK, replayed: true, revision: 5 },
      },
    });
    const result = await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
    });
    expect(result.replayed).toBe(true);
    expect(result.revision).toBe(5);
    expect(result.snapshotId).toBe(SNAPSHOT_ID);
    expect(calls).toHaveLength(1);
  });

  test("INCOMPLETE maps with its reasons intact", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: { data: POSTED_INCOMPLETE },
    });
    const result = await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
    });
    expect(result.certificationState).toBe("INCOMPLETE");
    expect(result.incompleteReasons).toEqual(["missing_central_price", "white_sheet_missing"]);
  });

  test("every incomplete reason the migration can emit round-trips", async () => {
    const allReasons = [...PROFITABILITY_INCOMPLETE_REASONS];
    const { service: subject } = service({
      record_profitability_snapshot: {
        data: {
          ...POSTED_INCOMPLETE,
          certification_state: "INCOMPLETE",
          incomplete_reasons: allReasons,
        },
      },
    });
    const result = await subject.recordSnapshot({
      accountabilityRoundId: ROUND_ID,
      quantityAttributions: [ATTRIBUTION],
    });
    expect(result.incompleteReasons).toEqual(allReasons);
    // Named explicitly so a reason silently dropped from the tuple still fails.
    expect(result.incompleteReasons).toContain("unsupported_round_movement");
    expect(result.incompleteReasons).toContain("no_round_activity");
    expect(result.incompleteReasons).toContain("purchasing_expenses_unattributable");
    // A cancelled round is terminal but is not a result; it must stay nameable
    // here, because a reason this client cannot name it cannot honestly render.
    expect(result.incompleteReasons).toContain("accountability_round_cancelled");
    expect(allReasons).toHaveLength(16);
  });

  test("an unknown reason string is refused rather than displayed as a blank", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: {
        data: { ...POSTED_INCOMPLETE, incomplete_reasons: ["moon_phase_unfavourable"] },
      },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityContractViolationError);
  });

  test("CERTIFIED carrying reasons is a corrupt payload, not a nuance", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: {
        data: {
          ...POSTED_OK,
          certification_state: "CERTIFIED",
          incomplete_reasons: ["white_sheet_missing"],
        },
      },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityContractViolationError);
  });

  test("INCOMPLETE carrying no reasons is equally refused", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: {
        data: { ...POSTED_OK, certification_state: "INCOMPLETE", incomplete_reasons: [] },
      },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityContractViolationError);
  });

  test("a malformed response with a missing key is a hard error, not a typed object", async () => {
    const withoutSnapshotId = {
      replayed: POSTED_OK.replayed,
      accountability_round_id: POSTED_OK.accountability_round_id,
      revision: POSTED_OK.revision,
      certification_state: POSTED_OK.certification_state,
      incomplete_reasons: POSTED_OK.incomplete_reasons,
    };
    const { service: subject } = service({
      record_profitability_snapshot: { data: withoutSnapshotId },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityContractViolationError);
  });

  test("a non-integer revision is refused", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: { data: { ...POSTED_OK, revision: 1.5 } },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityContractViolationError);
  });

  test("an RPC error maps to a typed error", async () => {
    const { service: subject } = service({
      record_profitability_snapshot: {
        error: {
          message: `P3: accountability_round_not_found (${ROUND_ID})`,
        },
      },
    });
    await expect(
      subject.recordSnapshot({
        accountabilityRoundId: ROUND_ID,
        quantityAttributions: [ATTRIBUTION],
      }),
    ).rejects.toBeInstanceOf(ProfitabilityRoundNotFoundError);
  });
});

describe("ProfitabilityService.getSnapshot", () => {
  test("passes the round id and a null revision by default", async () => {
    const { service: subject, calls } = service({
      get_profitability_snapshot: { data: SNAPSHOT_OK },
    });
    await subject.getSnapshot(ROUND_ID);
    expect(calls[0]!.fn).toBe("get_profitability_snapshot");
    expect(calls[0]!.args).toEqual({
      p_accountability_round_id: ROUND_ID,
      p_revision: null,
    });
  });

  test("passes an explicit revision through", async () => {
    const { service: subject, calls } = service({
      get_profitability_snapshot: { data: SNAPSHOT_OK },
    });
    await subject.getSnapshot(ROUND_ID, 3);
    expect(calls[0]!.args.p_revision).toBe(3);
  });

  test("returns null when no snapshot exists — never a zeroed placeholder", async () => {
    const { service: subject } = service({ get_profitability_snapshot: { data: null } });
    expect(await subject.getSnapshot(ROUND_ID)).toBeNull();
  });

  test("a missing round id is refused before any network call", async () => {
    const { service: subject, calls } = service({
      get_profitability_snapshot: { data: SNAPSHOT_OK },
    });
    await expect(
      subject.getSnapshot("" as unknown as string),
    ).rejects.toBeInstanceOf(ProfitabilityInvalidInputError);
    expect(calls).toHaveLength(0);
  });

  test("a non-UUID round id is refused", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: { data: SNAPSHOT_OK },
    });
    await expect(subject.getSnapshot("round-7")).rejects.toBeInstanceOf(
      ProfitabilityInvalidInputError,
    );
  });

  test("a non-positive or fractional revision is refused", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: { data: SNAPSHOT_OK },
    });
    await expect(subject.getSnapshot(ROUND_ID, 0)).rejects.toBeInstanceOf(
      ProfitabilityInvalidInputError,
    );
    await expect(subject.getSnapshot(ROUND_ID, 2.5)).rejects.toBeInstanceOf(
      ProfitabilityInvalidInputError,
    );
  });

  test("every money and quantity term survives as an exact decimal string", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: { data: SNAPSHOT_OK },
    });
    const snapshot = await subject.getSnapshot(ROUND_ID);
    expect(snapshot).not.toBeNull();
    // Byte-identical past Number.MAX_SAFE_INTEGER in both directions.
    expect(snapshot!.issuedCostSatang).toBe(HUGE_SATANG);
    expect(snapshot!.shortageOverageSatang).toBe(HUGE_NEGATIVE_SATANG);
    expect(snapshot!.cogsSoldSatang).toBe("98750");
    expect(snapshot!.standardMarginSatang).toBe("51250");
    expect(snapshot!.realizedPlSatang).toBe("-2000");
    expect(snapshot!.issuedQuantity).toBe("120.500000");
    expect(snapshot!.lines[0]!.priceSatang).toBe("1500");
    expect(snapshot!.lines[0]!.issuedCostSatang).toBe(HUGE_SATANG);
  });

  test("maps the header, lines and sources into camelCase", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: { data: SNAPSHOT_OK },
    });
    const snapshot = (await subject.getSnapshot(ROUND_ID))!;
    expect(snapshot.snapshotId).toBe(SNAPSHOT_ID);
    expect(snapshot.accountabilityRoundId).toBe(ROUND_ID);
    expect(snapshot.revision).toBe(3);
    expect(snapshot.calculationVersion).toBe(PROFITABILITY_CALCULATION_VERSION);
    expect(snapshot.certificationState).toBe("CERTIFIED");
    expect(snapshot.supersededBySnapshotId).toBeNull();
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]!.lineOrdinal).toBe(1);
    expect(snapshot.lines[0]!.locationCode).toBe("MAIN");
    expect(snapshot.lines[0]!.productKey).toBe("mango");
    expect(snapshot.lines[0]!.unitKey).toBe("kg");
    expect(snapshot.sources).toEqual([
      { artifactKind: "produce_item", artifactId: PRODUCE_ITEM_ID },
      { artifactKind: "central_selling_price", artifactId: RECEIPT_ID },
    ]);
  });

  test("an unprovable term stays null — never widened to 0", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: { data: SNAPSHOT_INCOMPLETE },
    });
    const snapshot = (await subject.getSnapshot(ROUND_ID))!;
    expect(snapshot.certificationState).toBe("INCOMPLETE");
    for (const value of [
      snapshot.cogsSoldSatang,
      snapshot.damageLossSatang,
      snapshot.standardMarginSatang,
      snapshot.expectedOperatingPlSatang,
      snapshot.shortageOverageSatang,
      snapshot.realizedPlSatang,
      snapshot.verifiedTransfersSatang,
      snapshot.purchasingExpensesSatang,
      snapshot.lines[0]!.issuedLedgerQuantity,
      snapshot.lines[0]!.priceSatang,
      snapshot.lines[0]!.cogsSoldSatang,
    ]) {
      expect(value).toBeNull();
      expect(value).not.toBe("0");
      expect(value).not.toBe(0);
    }
    expect(snapshot.supersededBySnapshotId).toBe(PRIOR_SNAPSHOT_ID);
    expect(snapshot.lines[0]!.incompleteReasons).toEqual([
      "issue_movement_unbound",
      "missing_central_price",
    ]);
  });

  test("a JSON number where a header money string belongs is refused, never coerced", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: {
        data: { ...SNAPSHOT_OK, realized_pl_satang: -2000 },
      },
    });
    await expect(subject.getSnapshot(ROUND_ID)).rejects.toBeInstanceOf(
      ProfitabilityContractViolationError,
    );
  });

  test("a JSON number on a LINE money field is refused too", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: {
        data: {
          ...SNAPSHOT_OK,
          lines: [{ ...SNAPSHOT_OK.lines[0], cogs_sold_satang: 98750 }],
        },
      },
    });
    await expect(subject.getSnapshot(ROUND_ID)).rejects.toBeInstanceOf(
      ProfitabilityContractViolationError,
    );
  });

  test("a JSON number on a quantity field is refused", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: {
        data: { ...SNAPSHOT_OK, sold_quantity: 110 },
      },
    });
    await expect(subject.getSnapshot(ROUND_ID)).rejects.toBeInstanceOf(
      ProfitabilityContractViolationError,
    );
  });

  test("a numeric price_satang is refused — a price is money", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: {
        data: { ...SNAPSHOT_OK, lines: [{ ...SNAPSHOT_OK.lines[0], price_satang: 1500 }] },
      },
    });
    await expect(subject.getSnapshot(ROUND_ID)).rejects.toBeInstanceOf(
      ProfitabilityContractViolationError,
    );
  });

  test("the contract violation names the failing path", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: {
        data: { ...SNAPSHOT_OK, realized_pl_satang: -2000 },
      },
    });
    const error = await captureRejection(subject.getSnapshot(ROUND_ID));
    expect(error).toBeInstanceOf(ProfitabilityContractViolationError);
    expect((error as ProfitabilityContractViolationError).path).toBe(
      "profitability_snapshot.realized_pl_satang",
    );
  });

  test("a certification_state / incomplete_reasons disagreement throws", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: {
        data: { ...SNAPSHOT_INCOMPLETE, certification_state: "CERTIFIED" },
      },
    });
    await expect(subject.getSnapshot(ROUND_ID)).rejects.toBeInstanceOf(
      ProfitabilityContractViolationError,
    );
  });

  test("an unknown artifact kind is refused", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: {
        data: {
          ...SNAPSHOT_OK,
          sources: [{ artifact_kind: "vibes", artifact_id: PRODUCE_ITEM_ID }],
        },
      },
    });
    await expect(subject.getSnapshot(ROUND_ID)).rejects.toBeInstanceOf(
      ProfitabilityContractViolationError,
    );
  });

  test("an empty round yields empty lines and sources, not an error", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: {
        data: {
          ...SNAPSHOT_OK,
          certification_state: "INCOMPLETE",
          incomplete_reasons: ["no_round_activity"],
          lines: [],
          sources: [],
        },
      },
    });
    const snapshot = (await subject.getSnapshot(ROUND_ID))!;
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.sources).toEqual([]);
  });

  test("an RPC error maps to a typed error", async () => {
    const { service: subject } = service({
      get_profitability_snapshot: { error: { message: "connection reset by peer" } },
    });
    await expect(subject.getSnapshot(ROUND_ID)).rejects.toBeInstanceOf(Error);
  });
});

describe("mapProfitabilityRpcError", () => {
  const cases: ReadonlyArray<[string, new (...args: never[]) => Error]> = [
    [
      "P3: accountability_round_not_found (11111111-1111-4111-8111-111111111111)",
      ProfitabilityRoundNotFoundError,
    ],
    [
      "P3: invalid_satang_input (verified transfers must be exact satang)",
      ProfitabilityInvalidSatangInputError,
    ],
    [
      "P3: invalid_satang_input (purchasing expenses must be exact non-negative satang)",
      ProfitabilityInvalidSatangInputError,
    ],
    [
      "P3: cross_round_artifact (2 transfer source id(s) do not belong to round x)",
      ProfitabilityCrossRoundArtifactError,
    ],
    [
      "P3: cross_round_artifact (1 attributed produce item(s) do not belong to round x)",
      ProfitabilityCrossRoundArtifactError,
    ],
    [
      "P3: required_artifact_unbound (1 purchasing-expense receipt id(s) are not confirmed receipts)",
      ProfitabilityRequiredArtifactUnboundError,
    ],
    [
      "P3: quantity attributions must be a JSON array",
      ProfitabilityInvalidAttributionError,
    ],
    [
      "P3: quantity attribution entries require produce_item_id, location_code, " +
        "product_key and unit_key",
      ProfitabilityInvalidAttributionError,
    ],
    [
      "P3: 2 produce item(s) attributed more than once",
      ProfitabilityInvalidAttributionError,
    ],
    [
      "P3: negative_sold_quantity (1 line(s) return more than was issued)",
      ProfitabilityNegativeSoldQuantityError,
    ],
    [
      "P3: profitability_ledger_is_append_only (profitability_snapshot_lines, UPDATE)",
      ProfitabilityAppendOnlyViolationError,
    ],
    [
      "P3: profitability_ledger_is_append_only (snapshot already superseded)",
      ProfitabilityAppendOnlyViolationError,
    ],
    [
      "P3: calculation_version is required",
      ProfitabilityMissingCalculationVersionError,
    ],
  ];

  for (const [message, expected] of cases) {
    test(`maps ${JSON.stringify(message.slice(0, 52))}`, () => {
      expect(mapProfitabilityRpcError(message)).toBeInstanceOf(expected);
    });
  }

  test("cross_round_artifact wins over the attribution patterns", () => {
    // The cross-round message also mentions attributed produce items. The
    // ordering in mapProfitabilityRpcError is deliberate and load-bearing:
    // a cross-round artifact is the more specific and more serious fact.
    const error = mapProfitabilityRpcError(
      "P3: cross_round_artifact (1 attributed produce item(s) do not belong to round x)",
    );
    expect(error).toBeInstanceOf(ProfitabilityCrossRoundArtifactError);
    expect(error).not.toBeInstanceOf(ProfitabilityInvalidAttributionError);
  });

  test("an unrecognised failure stays a plain Error rather than a business case", () => {
    const error = mapProfitabilityRpcError("connection reset by peer");
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe("connection reset by peer");
  });

  test("an empty failure message still yields an Error with a usable code", () => {
    expect(mapProfitabilityRpcError("").message).toBe("profitability_rpc_failed");
  });
});
