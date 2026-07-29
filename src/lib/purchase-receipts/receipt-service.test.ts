/**
 * P2B purchase receipt service tests.
 *
 * Scope: what the SERVICE owns — argument marshalling into the RPC, error
 * mapping, and result shaping. The lifecycle semantics themselves (idempotency,
 * concurrency, immutability, grants) live in SQL and are covered against a real
 * PostgreSQL in migration-0052.pg.test.ts. Re-implementing those rules as a JS
 * fake here would test the fake, not the database.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  PurchaseReceiptConfirmationConflictError,
  PurchaseReceiptLifecycleError,
  PurchaseReceiptNotFoundError,
  PurchaseReceiptService,
  PurchaseReceiptStaleRevisionError,
  mapPurchaseRpcError,
} from "./receipt-service";
import {
  PURCHASE_CONFIRMATION_CONTRACT_VERSION,
  PURCHASE_RECEIPT_MAX_ITEMS,
  type PurchaseReceiptDraftInput,
} from "./types";

type RpcCall = { fn: string; args: Record<string, unknown> };

/** Records RPC calls and replays canned responses. */
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

const BASE_DRAFT: PurchaseReceiptDraftInput = {
  draftKey: "doc-1",
  contractVersion: "p2b-slice-a-v1",
  businessDate: "2026-07-29",
  items: [
    {
      productKey: "mango",
      rawProductText: "มะม่วง",
      quantity: "2.5",
      unitKey: "kg",
      rawUnit: "กก.",
      unitCost: "12.3456",
      itemNumber: "1",
    },
  ],
};

const DRAFT_OK = {
  upsert_purchase_receipt_draft: {
    data: {
      receipt_id: "11111111-1111-4111-8111-111111111111",
      status: "draft",
      draft_revision: 1,
      item_count: 1,
    },
  },
};

function confirmationResponse(replayed: boolean) {
  return {
    receipt_id: "11111111-1111-4111-8111-111111111111",
    status: "confirmed",
    confirmation_key: "ck-1",
    confirmation_hash: "a".repeat(64),
    confirmed_at: "2026-07-29T03:00:00.000Z",
    replayed,
    payload: {
      contract_version: PURCHASE_CONFIRMATION_CONTRACT_VERSION,
      receipt_id: "11111111-1111-4111-8111-111111111111",
      item_count: 1,
      posts_inventory_movement: false,
      posts_valuation: false,
      items: [
        {
          item_ordinal: 1,
          product_key: "mango",
          quantity: "2.5",
          unit_key: "kg",
          unit_cost: "12.3456",
          line_amount_satang: "3086",
        },
      ],
    },
  };
}

describe("PurchaseReceiptService.saveDraft", () => {
  test("marshals items into the RPC item shape", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft(BASE_DRAFT);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("upsert_purchase_receipt_draft");
    expect(calls[0]!.args.p_items).toEqual([
      {
        product_key: "mango",
        raw_product_text: "มะม่วง",
        quantity: "2.5",
        unit_key: "kg",
        raw_unit: "กก.",
        unit_cost: "12.3456",
        price_unit_text: null,
        item_number: "1",
        source_evidence: {},
      },
    ]);
  });

  test("keeps decimals as strings so no value passes through a JS number", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft({
      ...BASE_DRAFT,
      items: [
        {
          productKey: "p",
          rawProductText: "p",
          // 18 significant digits: would lose precision as a double.
          quantity: "123456789012.345678",
          unitKey: "kg",
          rawUnit: "kg",
          unitCost: "99999999999.9999",
        },
      ],
    });

    const items = calls[0]!.args.p_items as Array<Record<string, unknown>>;
    expect(items[0]!.quantity).toBe("123456789012.345678");
    expect(items[0]!.unit_cost).toBe("99999999999.9999");
    expect(typeof items[0]!.quantity).toBe("string");
  });

  test("defaults VAT to NONE and nulls its dependent fields", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft(BASE_DRAFT);

    expect(calls[0]!.args.p_vat_kind).toBe("NONE");
    expect(calls[0]!.args.p_vat_satang).toBeNull();
    expect(calls[0]!.args.p_vat_included_in_item_prices).toBeNull();
    expect(calls[0]!.args.p_vat_recoverable).toBeNull();
  });

  test("passes a VAT AMOUNT declaration through in full", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft({
      ...BASE_DRAFT,
      vat: {
        kind: "AMOUNT",
        satang: "70000",
        includedInItemPrices: true,
        recoverable: false,
      },
    });

    expect(calls[0]!.args.p_vat_kind).toBe("AMOUNT");
    expect(calls[0]!.args.p_vat_satang).toBe("70000");
    expect(calls[0]!.args.p_vat_included_in_item_prices).toBe(true);
    expect(calls[0]!.args.p_vat_recoverable).toBe(false);
  });

  test("defaults document costs to zero satang", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft(BASE_DRAFT);

    expect(calls[0]!.args.p_freight_satang).toBe("0");
    expect(calls[0]!.args.p_handling_satang).toBe("0");
    expect(calls[0]!.args.p_discount_satang).toBe("0");
  });

  test("rejects a document over the line limit before hitting the database", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    const items = Array.from({ length: PURCHASE_RECEIPT_MAX_ITEMS + 1 }, () => ({
      productKey: "p",
      rawProductText: "p",
      quantity: "1",
      unitKey: "kg",
      rawUnit: "kg",
    }));

    await expect(
      new PurchaseReceiptService(client).saveDraft({ ...BASE_DRAFT, items }),
    ).rejects.toBeInstanceOf(PurchaseReceiptLifecycleError);
    expect(calls).toHaveLength(0);
  });

  test("shapes the draft result", async () => {
    const { client } = makeStub(DRAFT_OK);
    const result = await new PurchaseReceiptService(client).saveDraft(BASE_DRAFT);

    expect(result).toEqual({
      receiptId: "11111111-1111-4111-8111-111111111111",
      status: "draft",
      draftRevision: 1,
      itemCount: 1,
    });
  });

  test("refuses to draft onto a confirmed receipt", async () => {
    const { client } = makeStub({
      upsert_purchase_receipt_draft: {
        error: {
          message:
            "purchase receipt 1111 is confirmed and can no longer be drafted",
        },
      },
    });

    await expect(
      new PurchaseReceiptService(client).saveDraft(BASE_DRAFT),
    ).rejects.toBeInstanceOf(PurchaseReceiptLifecycleError);
  });
});

describe("PurchaseReceiptService.confirm", () => {
  test("returns the confirmation contract and the stable hash", async () => {
    const { client } = makeStub({
      confirm_purchase_receipt: { data: confirmationResponse(false) },
    });

    const confirmation = await new PurchaseReceiptService(client).confirm({
      receiptId: "11111111-1111-4111-8111-111111111111",
      confirmationKey: "ck-1",
      expectedDraftRevision: 1,
    });

    expect(confirmation.status).toBe("confirmed");
    expect(confirmation.replayed).toBe(false);
    expect(confirmation.confirmationHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(confirmation.payload.contract_version).toBe(
      PURCHASE_CONFIRMATION_CONTRACT_VERSION,
    );
  });

  test("surfaces a replayed confirmation as replayed", async () => {
    const { client } = makeStub({
      confirm_purchase_receipt: { data: confirmationResponse(true) },
    });

    const confirmation = await new PurchaseReceiptService(client).confirm({
      receiptId: "11111111-1111-4111-8111-111111111111",
      confirmationKey: "ck-1",
    });

    expect(confirmation.replayed).toBe(true);
  });

  test("forwards the expected draft revision so a moved draft is refused", async () => {
    const { client, calls } = makeStub({
      confirm_purchase_receipt: { data: confirmationResponse(false) },
    });

    await new PurchaseReceiptService(client).confirm({
      receiptId: "r",
      confirmationKey: "ck-1",
      expectedDraftRevision: 7,
    });

    expect(calls[0]!.args.p_expected_draft_revision).toBe(7);
  });

  test("maps a moved draft revision to a stale-revision error", async () => {
    const { client } = makeStub({
      confirm_purchase_receipt: {
        error: {
          message:
            "purchase receipt r draft_revision moved (expected 1, found 2)",
        },
      },
    });

    await expect(
      new PurchaseReceiptService(client).confirm({
        receiptId: "r",
        confirmationKey: "ck-1",
        expectedDraftRevision: 1,
      }),
    ).rejects.toBeInstanceOf(PurchaseReceiptStaleRevisionError);
  });

  test("maps a rival confirmation key to a conflict error", async () => {
    const { client } = makeStub({
      confirm_purchase_receipt: {
        error: {
          message:
            "purchase receipt r already confirmed under a different confirmation_key",
        },
      },
    });

    await expect(
      new PurchaseReceiptService(client).confirm({
        receiptId: "r",
        confirmationKey: "ck-2",
      }),
    ).rejects.toBeInstanceOf(PurchaseReceiptConfirmationConflictError);
  });

  test("payload states that P2B posts no movement and no valuation", async () => {
    const { client } = makeStub({
      confirm_purchase_receipt: { data: confirmationResponse(false) },
    });

    const confirmation = await new PurchaseReceiptService(client).confirm({
      receiptId: "r",
      confirmationKey: "ck-1",
    });

    expect(confirmation.payload.posts_inventory_movement).toBe(false);
    expect(confirmation.payload.posts_valuation).toBe(false);
  });
});

describe("PurchaseReceiptService.getConfirmation and void", () => {
  test("reads a confirmed contract", async () => {
    const { client } = makeStub({
      get_purchase_receipt_confirmation: { data: confirmationResponse(true) },
    });

    const confirmation = await new PurchaseReceiptService(client).getConfirmation(
      "11111111-1111-4111-8111-111111111111",
    );

    expect(confirmation.confirmationKey).toBe("ck-1");
    expect(confirmation.payload.items).toHaveLength(1);
  });

  test("refuses to expose a contract for an unconfirmed receipt", async () => {
    const { client } = makeStub({
      get_purchase_receipt_confirmation: {
        error: {
          message:
            "purchase receipt r is draft — only confirmed receipts expose a confirmation contract",
        },
      },
    });

    await expect(
      new PurchaseReceiptService(client).getConfirmation("r"),
    ).rejects.toBeInstanceOf(PurchaseReceiptLifecycleError);
  });

  test("void is reported as replayed when already void", async () => {
    const { client } = makeStub({
      void_purchase_receipt: {
        data: { receipt_id: "r", status: "void", replayed: true },
      },
    });

    const result = await new PurchaseReceiptService(client).void({
      receiptId: "r",
      reason: "duplicate",
    });

    expect(result).toEqual({ receiptId: "r", status: "void", replayed: true });
  });
});

describe("mapPurchaseRpcError", () => {
  test("maps a missing receipt", () => {
    expect(mapPurchaseRpcError("purchase receipt r not found")).toBeInstanceOf(
      PurchaseReceiptNotFoundError,
    );
  });

  test("rethrows an unrecognised database fault instead of mislabelling it", () => {
    const mapped = mapPurchaseRpcError("connection reset by peer");
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped).not.toBeInstanceOf(PurchaseReceiptLifecycleError);
    expect(mapped).not.toBeInstanceOf(PurchaseReceiptNotFoundError);
    expect(mapped.message).toBe("connection reset by peer");
  });
});
