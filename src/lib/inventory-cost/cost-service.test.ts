/**
 * P2D inventory cost valuation service tests.
 *
 * Scope: what the SERVICE owns — argument marshalling into each RPC, error
 * mapping, and fail-closed handling of the response, against a fake Supabase
 * client. The valuation semantics themselves (weighted average, exact-drain,
 * exact-negation, concurrency, grants) live in SQL and are covered against a
 * real PostgreSQL in migration-0054.pg.test.ts. Re-implementing those rules as
 * a JS fake here would only test the fake.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  InventoryCostAlreadyValuedError,
  InventoryCostAppendOnlyViolationError,
  InventoryCostInsufficientInventoryError,
  InventoryCostInvalidBindingError,
  InventoryCostMissingUnitCostError,
  InventoryCostNotFoundError,
  InventoryCostService,
  InventoryCostSignConflictError,
  InventoryCostUnprovableReturnError,
  InventoryCostUnsupportedMovementTypeError,
  InventoryCostUnvaluedSourceError,
  mapInventoryCostRpcError,
} from "./cost-service";
import { InventoryCostContractViolationError } from "./validate";

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

const MOVEMENT_ID = "33333333-3333-4333-8333-333333333333";
const COST_MOVEMENT_ID = "55555555-5555-4555-8555-555555555555";
const REVERSAL_MOVEMENT_ID = "66666666-6666-4666-8666-666666666666";
const REVERSAL_COST_MOVEMENT_ID = "77777777-7777-4777-8777-777777777777";
const MOVEMENT_LINE_ID = "88888888-8888-4888-8888-888888888888";
const SOURCE_COST_LINE_ID = "99999999-9999-4999-8999-999999999999";
const SOURCE_COST_LINE_ID_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// More precision than an IEEE754 double can hold exactly (2^53 - 1 has 16
// digits). If this ever silently passed through a JS number, it would come
// back rounded and this string comparison would fail.
const HUGE_SATANG = "123456789012345678901234";

const PURCHASE_RECEIPT_OK = {
  cost_movement_id: COST_MOVEMENT_ID,
  movement_id: MOVEMENT_ID,
  cost_event_type: "PURCHASE_RECEIPT",
  valuation_basis: "SOURCE_UNIT_COST",
  dedupe_key: `inventory-cost:purchase_receipt:v1:${MOVEMENT_ID}`,
  line_count: 1,
  replayed: false,
  lines: [
    {
      movement_line_id: MOVEMENT_LINE_ID,
      signed_value_satang: HUGE_SATANG,
      unit_cost_satang_snapshot: "1000.5000000000",
      source_cost_line_id: null,
    },
  ],
};

const ISSUE_OK = {
  cost_movement_id: COST_MOVEMENT_ID,
  movement_id: MOVEMENT_ID,
  cost_event_type: "ISSUE",
  valuation_basis: "MOVING_AVERAGE",
  dedupe_key: `inventory-cost:issue:v1:${MOVEMENT_ID}`,
  line_count: 1,
  replayed: false,
  lines: [
    {
      movement_line_id: MOVEMENT_LINE_ID,
      signed_value_satang: "-500",
      unit_cost_satang_snapshot: "50.0000000000",
      source_cost_line_id: null,
    },
  ],
};

const GOOD_RETURN_OK = {
  cost_movement_id: COST_MOVEMENT_ID,
  movement_id: MOVEMENT_ID,
  cost_event_type: "GOOD_RETURN",
  valuation_basis: "SOURCE_ISSUE_SNAPSHOT",
  dedupe_key: `inventory-cost:good_return:v1:${MOVEMENT_ID}`,
  line_count: 1,
  replayed: false,
  lines: [
    {
      movement_line_id: MOVEMENT_LINE_ID,
      signed_value_satang: "500",
      unit_cost_satang_snapshot: "50.0000000000",
      source_cost_line_id: SOURCE_COST_LINE_ID,
    },
  ],
};

const REVERSAL_OK = {
  cost_movement_id: REVERSAL_COST_MOVEMENT_ID,
  movement_id: REVERSAL_MOVEMENT_ID,
  cost_event_type: "REVERSAL",
  valuation_basis: "EXACT_NEGATION",
  dedupe_key: `inventory-cost:reversal:v1:${REVERSAL_MOVEMENT_ID}`,
  line_count: 1,
  replayed: false,
  lines: [
    {
      movement_line_id: MOVEMENT_LINE_ID,
      signed_value_satang: `-${HUGE_SATANG}`,
      unit_cost_satang_snapshot: "1000.5000000000",
      source_cost_line_id: null,
    },
  ],
};

describe("InventoryCostService.valuePurchaseReceiptMovement", () => {
  test("marshals arguments and parses the response", async () => {
    const { client, calls } = makeStub({
      value_purchase_receipt_movement: { data: PURCHASE_RECEIPT_OK },
    });

    const result = await new InventoryCostService(client).valuePurchaseReceiptMovement({
      movementId: MOVEMENT_ID,
      actor: "staff-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("value_purchase_receipt_movement");
    expect(calls[0]!.args).toEqual({ p_movement_id: MOVEMENT_ID, p_actor: "staff-1" });
    expect(result.costMovementId).toBe(COST_MOVEMENT_ID);
    expect(result.costEventType).toBe("PURCHASE_RECEIPT");
    expect(result.valuationBasis).toBe("SOURCE_UNIT_COST");
    expect(result.replayed).toBe(false);
  });

  test("omitted actor is sent as null, never the string 'undefined'", async () => {
    const { client, calls } = makeStub({
      value_purchase_receipt_movement: { data: PURCHASE_RECEIPT_OK },
    });
    await new InventoryCostService(client).valuePurchaseReceiptMovement({
      movementId: MOVEMENT_ID,
    });
    expect(calls[0]!.args.p_actor).toBeNull();
  });

  test("an amount with more precision than a JS number can hold survives byte-identical", async () => {
    const { client } = makeStub({
      value_purchase_receipt_movement: { data: PURCHASE_RECEIPT_OK },
    });
    const result = await new InventoryCostService(client).valuePurchaseReceiptMovement({
      movementId: MOVEMENT_ID,
    });
    expect(result.lines[0]!.signedValueSatang).toBe(HUGE_SATANG);
    expect(result.lines[0]!.unitCostSatangSnapshot).toBe("1000.5000000000");
  });

  test("an RPC error maps to a typed error", async () => {
    const { client } = makeStub({
      value_purchase_receipt_movement: {
        error: { message: "missing_unit_cost: movement x has ledger lines with receipt_item_id in [1]" },
      },
    });
    await expect(
      new InventoryCostService(client).valuePurchaseReceiptMovement({ movementId: MOVEMENT_ID }),
    ).rejects.toBeInstanceOf(InventoryCostMissingUnitCostError);
  });

  test("a malformed response with a missing key is a hard error, not a typed object", async () => {
    const withoutMovementId = {
      cost_movement_id: PURCHASE_RECEIPT_OK.cost_movement_id,
      cost_event_type: PURCHASE_RECEIPT_OK.cost_event_type,
      valuation_basis: PURCHASE_RECEIPT_OK.valuation_basis,
      dedupe_key: PURCHASE_RECEIPT_OK.dedupe_key,
      line_count: PURCHASE_RECEIPT_OK.line_count,
      replayed: PURCHASE_RECEIPT_OK.replayed,
      lines: PURCHASE_RECEIPT_OK.lines,
    };
    const { client } = makeStub({
      value_purchase_receipt_movement: { data: withoutMovementId },
    });
    await expect(
      new InventoryCostService(client).valuePurchaseReceiptMovement({ movementId: MOVEMENT_ID }),
    ).rejects.toBeInstanceOf(InventoryCostContractViolationError);
  });

  test("a JSON number where a decimal string belongs is refused, never coerced", async () => {
    const { client } = makeStub({
      value_purchase_receipt_movement: {
        data: {
          ...PURCHASE_RECEIPT_OK,
          lines: [{ ...PURCHASE_RECEIPT_OK.lines[0], signed_value_satang: 12345 }],
        },
      },
    });
    await expect(
      new InventoryCostService(client).valuePurchaseReceiptMovement({ movementId: MOVEMENT_ID }),
    ).rejects.toBeInstanceOf(InventoryCostContractViolationError);
  });
});

describe("InventoryCostService.valueConsumptionMovement", () => {
  test("marshals arguments and parses the response", async () => {
    const { client, calls } = makeStub({
      value_inventory_consumption_movement: { data: ISSUE_OK },
    });

    const result = await new InventoryCostService(client).valueConsumptionMovement({
      movementId: MOVEMENT_ID,
      actor: "staff-1",
    });

    expect(calls[0]!.fn).toBe("value_inventory_consumption_movement");
    expect(calls[0]!.args).toEqual({ p_movement_id: MOVEMENT_ID, p_actor: "staff-1" });
    expect(result.costEventType).toBe("ISSUE");
    expect(result.valuationBasis).toBe("MOVING_AVERAGE");
    expect(result.lines[0]!.signedValueSatang).toBe("-500");
  });

  test("an RPC error maps to a typed error", async () => {
    const { client } = makeStub({
      value_inventory_consumption_movement: {
        error: {
          message:
            "insufficient_inventory: movement x line 1 would drive (MAIN,mango,kg) balance to -1",
        },
      },
    });
    await expect(
      new InventoryCostService(client).valueConsumptionMovement({ movementId: MOVEMENT_ID }),
    ).rejects.toBeInstanceOf(InventoryCostInsufficientInventoryError);
  });
});

describe("InventoryCostService.valueGoodReturnMovement", () => {
  test("marshals sourceCostLineIds as a plain array in positional order", async () => {
    const { client, calls } = makeStub({
      value_good_return_movement: { data: GOOD_RETURN_OK },
    });

    const result = await new InventoryCostService(client).valueGoodReturnMovement({
      movementId: MOVEMENT_ID,
      sourceCostLineIds: [SOURCE_COST_LINE_ID, SOURCE_COST_LINE_ID_2],
      actor: "staff-1",
    });

    expect(calls[0]!.fn).toBe("value_good_return_movement");
    expect(calls[0]!.args).toEqual({
      p_movement_id: MOVEMENT_ID,
      p_source_cost_line_ids: [SOURCE_COST_LINE_ID, SOURCE_COST_LINE_ID_2],
      p_actor: "staff-1",
    });
    expect(result.lines[0]!.sourceCostLineId).toBe(SOURCE_COST_LINE_ID);
  });

  test("an RPC error maps to a typed error", async () => {
    const { client } = makeStub({
      value_good_return_movement: {
        error: {
          message:
            "unprovable_return_cost: movement x line 1 has no source cost line id at its positional index",
        },
      },
    });
    await expect(
      new InventoryCostService(client).valueGoodReturnMovement({
        movementId: MOVEMENT_ID,
        sourceCostLineIds: [],
      }),
    ).rejects.toBeInstanceOf(InventoryCostUnprovableReturnError);
  });
});

describe("InventoryCostService.reverseCostMovement", () => {
  test("marshals arguments and parses the response", async () => {
    const { client, calls } = makeStub({
      reverse_inventory_cost_movement: { data: REVERSAL_OK },
    });

    const result = await new InventoryCostService(client).reverseCostMovement({
      costMovementId: COST_MOVEMENT_ID,
      reversalMovementId: REVERSAL_MOVEMENT_ID,
      reason: "staff error",
      actor: "staff-1",
    });

    expect(calls[0]!.fn).toBe("reverse_inventory_cost_movement");
    expect(calls[0]!.args).toEqual({
      p_cost_movement_id: COST_MOVEMENT_ID,
      p_reversal_movement_id: REVERSAL_MOVEMENT_ID,
      p_reason: "staff error",
      p_actor: "staff-1",
    });
    expect(result.costEventType).toBe("REVERSAL");
    expect(result.valuationBasis).toBe("EXACT_NEGATION");
    expect(result.lines[0]!.signedValueSatang).toBe(`-${HUGE_SATANG}`);
  });

  test("an RPC error maps to a typed error", async () => {
    const { client } = makeStub({
      reverse_inventory_cost_movement: {
        error: {
          message:
            "invalid_cost_binding: movement x is not a REVERSAL of movement y",
        },
      },
    });
    await expect(
      new InventoryCostService(client).reverseCostMovement({
        costMovementId: COST_MOVEMENT_ID,
        reversalMovementId: REVERSAL_MOVEMENT_ID,
        reason: "r",
      }),
    ).rejects.toBeInstanceOf(InventoryCostInvalidBindingError);
  });
});

describe("InventoryCostService.getCostBalances", () => {
  test("passes filters through and returns exact decimal strings", async () => {
    const { client, calls } = makeStub({
      get_inventory_cost_balances: {
        data: {
          balances: [
            {
              location_code: "MAIN",
              product_key: "mango",
              unit_key: "kg",
              quantity_balance: "2.500000",
              value_balance_satang: HUGE_SATANG,
              average_unit_cost_satang: "49382716049382716049382.4",
            },
          ],
        },
      },
    });

    const result = await new InventoryCostService(client).getCostBalances({
      locationCode: "MAIN",
      productKey: "mango",
    });

    expect(calls[0]!.args).toEqual({
      p_location_code: "MAIN",
      p_product_key: "mango",
      p_unit_key: null,
      p_include_zero: false,
    });
    expect(result).toEqual([
      {
        locationCode: "MAIN",
        productKey: "mango",
        unitKey: "kg",
        quantityBalance: "2.500000",
        valueBalanceSatang: HUGE_SATANG,
        averageUnitCostSatang: "49382716049382716049382.4",
      },
    ]);
  });

  test("a zero quantity balance yields a null average, never a division", async () => {
    const { client } = makeStub({
      get_inventory_cost_balances: {
        data: {
          balances: [
            {
              location_code: "MAIN",
              product_key: "mango",
              unit_key: "kg",
              quantity_balance: "0",
              value_balance_satang: "0",
              average_unit_cost_satang: null,
            },
          ],
        },
      },
    });
    const result = await new InventoryCostService(client).getCostBalances();
    expect(result[0]!.averageUnitCostSatang).toBeNull();
  });

  test("an empty ledger yields an empty list, not an error", async () => {
    const { client } = makeStub({ get_inventory_cost_balances: { data: { balances: [] } } });
    expect(await new InventoryCostService(client).getCostBalances()).toEqual([]);
  });

  test("a numeric value_balance_satang is refused rather than silently accepted", async () => {
    const { client } = makeStub({
      get_inventory_cost_balances: {
        data: {
          balances: [
            {
              location_code: "MAIN",
              product_key: "mango",
              unit_key: "kg",
              quantity_balance: "2.500000",
              value_balance_satang: 500,
              average_unit_cost_satang: "200",
            },
          ],
        },
      },
    });
    await expect(
      new InventoryCostService(client).getCostBalances(),
    ).rejects.toBeInstanceOf(InventoryCostContractViolationError);
  });
});

describe("mapInventoryCostRpcError", () => {
  const cases: ReadonlyArray<[string, new (...args: never[]) => Error]> = [
    ["inventory movement 1 not found", InventoryCostNotFoundError],
    ["inventory cost movement 1 not found", InventoryCostNotFoundError],
    [
      "unvalued_source_inventory: movement x line 1 cannot be valued because " +
        "(MAIN,mango,kg) has ledger quantity 10 but only 4 of it is valued — " +
        "see public.unvalued_inventory_movement_lines",
      InventoryCostUnvaluedSourceError,
    ],
    [
      "insufficient_inventory: movement x line 1 would drive (MAIN,mango,kg) " +
        "balance to -1 — refusing to post a negative resulting quantity",
      InventoryCostInsufficientInventoryError,
    ],
    [
      "missing_unit_cost: movement x has ledger lines with receipt_item_id in " +
        "[1] whose confirmation item has NULL line_amount_satang",
      InventoryCostMissingUnitCostError,
    ],
    [
      "unprovable_return_cost: movement x was called with no source cost line ids",
      InventoryCostUnprovableReturnError,
    ],
    [
      "unprovable_return_cost: movement x line 1 names source cost line y which does not exist",
      InventoryCostUnprovableReturnError,
    ],
    [
      "movement_already_valued: cost movement a already exists for movement x " +
        "under dedupe key k1 which does not match the freshly computed key k2",
      InventoryCostAlreadyValuedError,
    ],
    [
      "movement_already_valued: cost movement a is already reversed by b under " +
        "a different reversal binding",
      InventoryCostAlreadyValuedError,
    ],
    [
      "unsupported_movement_type: movement x has type ADJUSTMENT — " +
        "value_purchase_receipt_movement only values PURCHASE_RECEIPT",
      InventoryCostUnsupportedMovementTypeError,
    ],
    [
      "cost_ledger_is_append_only: inventory_cost_movement_lines is append-only " +
        "and immutable (attempted UPDATE)",
      InventoryCostAppendOnlyViolationError,
    ],
    [
      "cost_ledger_is_append_only: inventory_cost_movements is append-only and " +
        "immutable (attempted DELETE)",
      InventoryCostAppendOnlyViolationError,
    ],
    [
      "invalid_cost_binding: cost line c (movement_line l) belongs to movement " +
        "x but cost movement a is bound to movement y",
      InventoryCostInvalidBindingError,
    ],
    [
      "invalid_cost_binding: movement x is not a REVERSAL of movement y — cost " +
        "movement a values movement y",
      InventoryCostInvalidBindingError,
    ],
    [
      "value_sign_conflict: cost line c carries signed_value_satang=5 but its " +
        "ledger line l carries signed_quantity=-1",
      InventoryCostSignConflictError,
    ],
  ];

  for (const [message, expected] of cases) {
    test(`maps ${JSON.stringify(message.slice(0, 48))}`, () => {
      expect(mapInventoryCostRpcError(message)).toBeInstanceOf(expected);
    });
  }

  test("an unrecognised failure stays a plain Error rather than a business case", () => {
    const error = mapInventoryCostRpcError("connection reset by peer");
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe("connection reset by peer");
  });

  test("a known-but-unmapped lifecycle message (no distinctive code) falls through to a plain Error", () => {
    // "cost movement % is itself a reversal and cannot be reversed" carries no
    // distinctive code prefix and is not one of the ten typed classes this
    // service defines — it must not be silently absorbed into an unrelated
    // typed class.
    const error = mapInventoryCostRpcError(
      "cost movement a is itself a reversal and cannot be reversed",
    );
    expect(error.constructor).toBe(Error);
  });

  test("unvalued_source_inventory wins over insufficient_inventory when both keywords are present", () => {
    // Neither real migration message is a substring of the other, but the
    // ordering is deliberate and load-bearing (see the comment above
    // mapInventoryCostRpcError): unvalued_source_inventory must be checked
    // BEFORE insufficient_inventory. Prove the order holds even in the
    // adversarial case of a message carrying both keywords.
    const message =
      "insufficient_inventory and unvalued_source_inventory both apply here";
    expect(mapInventoryCostRpcError(message)).toBeInstanceOf(InventoryCostUnvaluedSourceError);
  });
});
