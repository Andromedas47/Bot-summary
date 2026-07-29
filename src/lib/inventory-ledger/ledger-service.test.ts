/**
 * P2C inventory ledger service tests.
 *
 * Scope: what the SERVICE owns — argument marshalling into the RPC, error
 * mapping, and fail-closed handling of the response. The ledger semantics
 * themselves (idempotency, atomicity, immutability, concurrency, grants) live in
 * SQL and are covered against a real PostgreSQL in migration-0053.pg.test.ts.
 * Re-implementing those rules as a JS fake here would only test the fake.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  InventoryAlreadyReversedError,
  InventoryAppendOnlyViolationError,
  InventoryDuplicateSourceError,
  InventoryInvalidLifecycleError,
  InventoryLedgerService,
  InventoryNotFoundError,
  InventoryPostingAtomicityError,
  InventorySourceBlockedError,
  InventoryUnresolvedIdentityError,
  mapInventoryRpcError,
} from "./ledger-service";
import { InventoryContractViolationError } from "./validate";

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

const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";
const MOVEMENT_ID = "33333333-3333-4333-8333-333333333333";
const REVERSAL_ID = "44444444-4444-4444-8444-444444444444";
const HASH = "a".repeat(64);
const DEDUPE = `purchase-receipt-confirmation:v1:${RECEIPT_ID}:${HASH}`;

const POSTING_OK = {
  movement_id: MOVEMENT_ID,
  receipt_id: RECEIPT_ID,
  dedupe_key: DEDUPE,
  line_count: 2,
  replayed: false,
  reversed_by_movement_id: null,
  posting_locked_at: "2026-07-29T09:00:00+00:00",
  posting_locked_by: "p2c-inventory-ledger",
};

const REVERSAL_OK = {
  movement_id: MOVEMENT_ID,
  reversal_id: REVERSAL_ID,
  dedupe_key: "inventory-movement-reversal:v1:rev-1",
  line_count: 2,
  replayed: false,
};

describe("InventoryLedgerService.postPurchaseReceipt", () => {
  test("marshals arguments and parses the response", async () => {
    const { client, calls } = makeStub({
      post_purchase_receipt_inventory_movement: { data: POSTING_OK },
    });

    const result = await new InventoryLedgerService(client).postPurchaseReceipt({
      receiptId: RECEIPT_ID,
      actor: "staff-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("post_purchase_receipt_inventory_movement");
    expect(calls[0]!.args).toEqual({ p_receipt_id: RECEIPT_ID, p_actor: "staff-1" });
    expect(result.movementId).toBe(MOVEMENT_ID);
    expect(result.dedupeKey).toBe(DEDUPE);
    expect(result.lineCount).toBe(2);
    expect(result.replayed).toBe(false);
    expect(result.reversedByMovementId).toBeNull();
    expect(result.postingLockedBy).toBe("p2c-inventory-ledger");
  });

  test("omitted actor is sent as null, never the string 'undefined'", async () => {
    const { client, calls } = makeStub({
      post_purchase_receipt_inventory_movement: { data: POSTING_OK },
    });
    await new InventoryLedgerService(client).postPurchaseReceipt({ receiptId: RECEIPT_ID });
    expect(calls[0]!.args.p_actor).toBeNull();
  });

  test("surfaces the reversal link on a replayed posting", async () => {
    const { client } = makeStub({
      post_purchase_receipt_inventory_movement: {
        data: { ...POSTING_OK, replayed: true, reversed_by_movement_id: REVERSAL_ID },
      },
    });
    const result = await new InventoryLedgerService(client).postPurchaseReceipt({
      receiptId: RECEIPT_ID,
    });
    expect(result.replayed).toBe(true);
    expect(result.reversedByMovementId).toBe(REVERSAL_ID);
  });

  test("a malformed response is a hard error, not a typed object", async () => {
    const { client } = makeStub({
      post_purchase_receipt_inventory_movement: {
        data: { ...POSTING_OK, movement_id: null },
      },
    });
    await expect(
      new InventoryLedgerService(client).postPurchaseReceipt({ receiptId: RECEIPT_ID }),
    ).rejects.toBeInstanceOf(InventoryContractViolationError);
  });

  test("an RPC error maps to a typed error", async () => {
    const { client } = makeStub({
      post_purchase_receipt_inventory_movement: {
        error: { message: "purchase receipt x has blocking blockers and must not post" },
      },
    });
    await expect(
      new InventoryLedgerService(client).postPurchaseReceipt({ receiptId: RECEIPT_ID }),
    ).rejects.toBeInstanceOf(InventorySourceBlockedError);
  });
});

describe("InventoryLedgerService.reverseMovement", () => {
  test("marshals arguments and parses the response", async () => {
    const { client, calls } = makeStub({
      reverse_inventory_movement: { data: REVERSAL_OK },
    });

    const result = await new InventoryLedgerService(client).reverseMovement({
      movementId: MOVEMENT_ID,
      reversalKey: "rev-1",
      reason: "staff error",
      actor: "staff-1",
    });

    expect(calls[0]!.args).toEqual({
      p_movement_id: MOVEMENT_ID,
      p_reversal_key: "rev-1",
      p_reason: "staff error",
      p_actor: "staff-1",
    });
    expect(result.reversalId).toBe(REVERSAL_ID);
    expect(result.replayed).toBe(false);
  });

  test("a reversal that claims to be its own original is rejected", async () => {
    const { client } = makeStub({
      reverse_inventory_movement: { data: { ...REVERSAL_OK, reversal_id: MOVEMENT_ID } },
    });
    await expect(
      new InventoryLedgerService(client).reverseMovement({
        movementId: MOVEMENT_ID,
        reversalKey: "rev-1",
        reason: "r",
      }),
    ).rejects.toBeInstanceOf(InventoryContractViolationError);
  });
});

describe("InventoryLedgerService.getBalances", () => {
  test("passes filters through and returns exact decimal strings", async () => {
    const { client, calls } = makeStub({
      get_inventory_balances: {
        data: {
          balances: [
            {
              location_code: "MAIN",
              product_key: "mango",
              unit_key: "kg",
              quantity_balance: "2.500000",
            },
          ],
        },
      },
    });

    const result = await new InventoryLedgerService(client).getBalances({
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
      { locationCode: "MAIN", productKey: "mango", unitKey: "kg", quantityBalance: "2.500000" },
    ]);
  });

  test("an empty ledger yields an empty list, not an error", async () => {
    const { client } = makeStub({ get_inventory_balances: { data: { balances: [] } } });
    expect(await new InventoryLedgerService(client).getBalances()).toEqual([]);
  });

  test("a numeric quantity_balance is refused rather than silently accepted", async () => {
    const { client } = makeStub({
      get_inventory_balances: {
        data: {
          balances: [
            {
              location_code: "MAIN",
              product_key: "mango",
              unit_key: "kg",
              quantity_balance: 2.5,
            },
          ],
        },
      },
    });
    await expect(
      new InventoryLedgerService(client).getBalances(),
    ).rejects.toBeInstanceOf(InventoryContractViolationError);
  });
});

describe("mapInventoryRpcError", () => {
  const cases: ReadonlyArray<[string, new (...args: never[]) => Error]> = [
    ["purchase receipt 1 not found", InventoryNotFoundError],
    ["inventory movement 1 not found", InventoryNotFoundError],
    ["purchase receipt 1 is void and must not be posted to inventory", InventoryInvalidLifecycleError],
    ["purchase receipt 1 is not confirmed (status=draft)", InventoryInvalidLifecycleError],
    ["purchase receipt 1 has blocking blockers and must not post", InventorySourceBlockedError],
    ["purchase receipt 1 declares posts_inventory_movement=true", InventorySourceBlockedError],
    ["purchase receipt 1 targets destination WEST", InventorySourceBlockedError],
    ["purchase receipt 1 item 2 has non-positive quantity 0", InventorySourceBlockedError],
    ["purchase receipt 1 item 2 has UNRESOLVED product identity", InventoryUnresolvedIdentityError],
    ["purchase receipt 1 item 2 has UNRESOLVED unit identity", InventoryUnresolvedIdentityError],
    ["purchase receipt 1 already posted as movement 9", InventoryDuplicateSourceError],
    ["reversal key r is already in use by a different movement", InventoryDuplicateSourceError],
    ["movement 1 is already reversed by 2 under a different reversal key", InventoryAlreadyReversedError],
    ["movement 1 is itself a reversal and cannot be reversed", InventoryInvalidLifecycleError],
    ["inventory_movements is append-only and immutable (attempted DELETE)", InventoryAppendOnlyViolationError],
    ["movement 1 declares 3 lines but has 2", InventoryPostingAtomicityError],
    ["purchase receipt 1 returned a malformed confirmation payload", InventoryContractViolationError],
  ];

  for (const [message, expected] of cases) {
    test(`maps ${JSON.stringify(message.slice(0, 48))}`, () => {
      expect(mapInventoryRpcError(message)).toBeInstanceOf(expected);
    });
  }

  test("an unrecognised failure stays a plain Error rather than a business case", () => {
    const error = mapInventoryRpcError("connection reset by peer");
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe("connection reset by peer");
  });

  test("'already reversed' wins over the duplicate-source pattern", () => {
    // Both patterns could plausibly match a reversal conflict; ordering must be
    // stable so the caller sees the specific case.
    expect(
      mapInventoryRpcError("movement 1 is already reversed by 2 under a different reversal key"),
    ).toBeInstanceOf(InventoryAlreadyReversedError);
  });
});
