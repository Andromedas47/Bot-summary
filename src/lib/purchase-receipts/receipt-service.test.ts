/**
 * P2B purchase receipt service tests.
 *
 * Scope: what the SERVICE owns — argument marshalling into the RPC, error
 * mapping, and fail-closed handling of the response. The lifecycle semantics
 * themselves (idempotency, concurrency, immutability, grants) live in SQL and
 * are covered against a real PostgreSQL in migration-0052.pg.test.ts.
 * Re-implementing those rules as a JS fake here would test the fake.
 *
 * Response validation itself is covered in validate.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  PurchaseDocumentIdentityConflictError,
  PurchaseReceiptConfirmationConflictError,
  PurchaseReceiptDomainError,
  PurchaseReceiptLifecycleError,
  PurchaseReceiptNotFoundError,
  PurchaseReceiptPostingLockedError,
  PurchaseReceiptService,
  PurchaseReceiptStaleRevisionError,
  mapPurchaseRpcError,
} from "./receipt-service";
import { PurchaseContractViolationError } from "./validate";
import {
  PURCHASE_RECEIPT_MAX_ITEMS,
  type PurchaseReceiptDraftInput,
} from "./types";

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
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);

const BASE_DRAFT: PurchaseReceiptDraftInput = {
  documentNamespace: "line-text",
  documentKey: "DOC-1",
  contractVersion: "p2b-slice-a-v1",
  businessDate: "2026-07-29",
  sourceType: "group",
  sourceId: "G1",
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
      receipt_id: RECEIPT_ID,
      document_namespace: "line-text",
      document_key: "DOC-1",
      status: "draft",
      draft_revision: "1",
      item_count: 1,
    },
  },
};

function confirmationResponse(replayed: boolean) {
  return {
    receipt_id: RECEIPT_ID,
    confirmation: {
      contract_version: "p2b-purchase-confirm-v1",
      canonical_form: "purchase-receipt-canonical-json-v1",
      hash_algorithm: "sha256",
      hash: HASH,
      confirmation_key: "ck-1",
      confirmed_at: "2026-07-29T03:00:00.000Z",
      confirmed_by: "tester",
      payload: {
        contract_version: "p2b-purchase-confirm-v1",
        receipt_id: RECEIPT_ID,
        document_namespace: "line-text",
        document_key: "DOC-1",
        parser_contract_version: "p2b-slice-a-v1",
        source: {
          source_type: "group",
          source_id: "G1",
          sender_line_user_id: null,
          source_line_event_id: "evt-1",
          source_raw_message_id: null,
          source_evidence: {},
        },
        business_date: "2026-07-29",
        purchase_time: null,
        supplier_key: null,
        supplier_raw: null,
        supplier_ref: null,
        reference_text: null,
        intended_warehouse_code: "MAIN",
        vat_kind: "NONE",
        vat_included_in_item_prices: null,
        vat_recoverable: null,
        item_count: 1,
        items: [
          {
            receipt_item_id: ITEM_ID,
            item_ordinal: 1,
            item_number: "1",
            product_key: "mango",
            raw_product_text: "มะม่วง",
            product_identity_status: "RESOLVED",
            quantity: "2.5",
            unit_key: "kg",
            raw_unit: "กก.",
            unit_identity_status: "RESOLVED",
            unit_cost: "12.3456",
            price_unit_text: null,
            price_unit_status: "NOT_APPLICABLE",
            line_amount_satang: "3086",
            source_evidence: {},
          },
        ],
        totals: {
          line_subtotal_satang: "3086",
          freight_satang: "0",
          handling_satang: "0",
          discount_satang: "0",
          vat_satang: null,
          payable_total_satang: "3086",
          declared_total_satang: null,
          reconciliation_status: "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
        },
        blockers: [],
        has_blocking_blockers: false,
        posts_inventory_movement: false,
        posts_valuation: false,
      },
    },
    lifecycle: { status: "confirmed", posting_locked_at: null, posting_locked_by: null },
    void: null,
    correction: { supersedes_receipt_id: null, superseded_by_receipt_id: null },
    p2c_dedupe_key: `purchase-receipt-confirmation:v1:${RECEIPT_ID}:${HASH}`,
    replayed,
  };
}

describe("saveDraft marshalling", () => {
  test("sends document identity and source binding separately from delivery id", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft({
      ...BASE_DRAFT,
      sourceLineEventId: "evt-99",
    });

    const args = calls[0]!.args;
    expect(args.p_document_namespace).toBe("line-text");
    expect(args.p_document_key).toBe("DOC-1");
    expect(args.p_source_type).toBe("group");
    expect(args.p_source_id).toBe("G1");
    // Delivery identity is separate from document identity.
    expect(args.p_source_line_event_id).toBe("evt-99");
  });

  test("marshals items with resolution statuses defaulted", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft(BASE_DRAFT);

    expect(calls[0]!.args.p_items).toEqual([
      {
        product_key: "mango",
        raw_product_text: "มะม่วง",
        product_identity_status: "RESOLVED",
        quantity: "2.5",
        unit_key: "kg",
        raw_unit: "กก.",
        unit_identity_status: "RESOLVED",
        unit_cost: "12.3456",
        price_unit_text: null,
        price_unit_status: "NOT_APPLICABLE",
        item_number: "1",
        source_evidence: {},
      },
    ]);
  });

  test("defaults price_unit_status to UNRESOLVED when a price unit is present", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft({
      ...BASE_DRAFT,
      items: [{ ...BASE_DRAFT.items[0]!, priceUnitText: "ลัง" }],
    });

    const items = calls[0]!.args.p_items as Array<Record<string, unknown>>;
    expect(items[0]!.price_unit_status).toBe("UNRESOLVED");
  });

  test("forwards unresolved identity statuses so they become blockers", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft({
      ...BASE_DRAFT,
      items: [
        {
          ...BASE_DRAFT.items[0]!,
          productIdentityStatus: "UNRESOLVED",
          unitIdentityStatus: "UNRESOLVED",
        },
      ],
    });

    const items = calls[0]!.args.p_items as Array<Record<string, unknown>>;
    expect(items[0]!.product_identity_status).toBe("UNRESOLVED");
    expect(items[0]!.unit_identity_status).toBe("UNRESOLVED");
  });

  test("keeps decimals as strings so no value passes through a JS number", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft({
      ...BASE_DRAFT,
      items: [
        {
          productKey: "p",
          rawProductText: "p",
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
  });

  test("sends satang amounts as strings, defaulting to zero", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft(BASE_DRAFT);

    expect(calls[0]!.args.p_freight_satang).toBe("0");
    expect(calls[0]!.args.p_handling_satang).toBe("0");
    expect(calls[0]!.args.p_discount_satang).toBe("0");
  });

  test("passes a VAT AMOUNT declaration through in full", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft({
      ...BASE_DRAFT,
      vat: { kind: "AMOUNT", satang: "70000", includedInItemPrices: true, recoverable: false },
    });

    expect(calls[0]!.args.p_vat_kind).toBe("AMOUNT");
    expect(calls[0]!.args.p_vat_satang).toBe("70000");
    expect(calls[0]!.args.p_vat_included_in_item_prices).toBe(true);
    expect(calls[0]!.args.p_vat_recoverable).toBe(false);
  });

  test("defaults VAT to NONE and nulls its dependent fields", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft(BASE_DRAFT);

    expect(calls[0]!.args.p_vat_kind).toBe("NONE");
    expect(calls[0]!.args.p_vat_satang).toBeNull();
    expect(calls[0]!.args.p_vat_included_in_item_prices).toBeNull();
    expect(calls[0]!.args.p_vat_recoverable).toBeNull();
  });

  test("forwards correction linkage", async () => {
    const { client, calls } = makeStub(DRAFT_OK);
    await new PurchaseReceiptService(client).saveDraft({
      ...BASE_DRAFT,
      supersedesReceiptId: RECEIPT_ID,
    });
    expect(calls[0]!.args.p_supersedes_receipt_id).toBe(RECEIPT_ID);
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

  test("returns draft_revision as a lossless string", async () => {
    const { client } = makeStub(DRAFT_OK);
    const result = await new PurchaseReceiptService(client).saveDraft(BASE_DRAFT);
    expect(result.draftRevision).toBe("1");
    expect(typeof result.draftRevision).toBe("string");
  });

  test("fails closed when the RPC returns a numeric draft_revision", async () => {
    const { client } = makeStub({
      upsert_purchase_receipt_draft: {
        data: { ...DRAFT_OK.upsert_purchase_receipt_draft.data, draft_revision: 1 },
      },
    });
    await expect(
      new PurchaseReceiptService(client).saveDraft(BASE_DRAFT),
    ).rejects.toBeInstanceOf(PurchaseContractViolationError);
  });

  test("fails closed on a non-object RPC response", async () => {
    const { client } = makeStub({ upsert_purchase_receipt_draft: { data: "ok" } });
    await expect(
      new PurchaseReceiptService(client).saveDraft(BASE_DRAFT),
    ).rejects.toBeInstanceOf(PurchaseContractViolationError);
  });
});

describe("confirm", () => {
  test("validates and returns the frozen contract", async () => {
    const { client } = makeStub({
      confirm_purchase_receipt: { data: confirmationResponse(false) },
    });

    const confirmation = await new PurchaseReceiptService(client).confirm({
      receiptId: RECEIPT_ID,
      confirmationKey: "ck-1",
      expectedDraftRevision: "1",
    });

    expect(confirmation.replayed).toBe(false);
    expect(confirmation.confirmation.hash).toBe(HASH);
    expect(confirmation.p2cDedupeKey).toBe(
      `purchase-receipt-confirmation:v1:${RECEIPT_ID}:${HASH}`,
    );
    expect(confirmation.confirmation.payload.posts_inventory_movement).toBe(false);
    expect(confirmation.confirmation.payload.posts_valuation).toBe(false);
  });

  test("sends the expected draft revision as a string", async () => {
    const { client, calls } = makeStub({
      confirm_purchase_receipt: { data: confirmationResponse(false) },
    });
    await new PurchaseReceiptService(client).confirm({
      receiptId: RECEIPT_ID,
      confirmationKey: "ck-1",
      expectedDraftRevision: "7",
    });
    expect(calls[0]!.args.p_expected_draft_revision).toBe("7");
  });

  test("surfaces a replayed confirmation", async () => {
    const { client } = makeStub({
      confirm_purchase_receipt: { data: confirmationResponse(true) },
    });
    const confirmation = await new PurchaseReceiptService(client).confirm({
      receiptId: RECEIPT_ID,
      confirmationKey: "ck-1",
    });
    expect(confirmation.replayed).toBe(true);
  });

  test("fails closed on a partial confirmation response", async () => {
    const partial = confirmationResponse(false) as Record<string, unknown>;
    delete partial.correction;
    const { client } = makeStub({ confirm_purchase_receipt: { data: partial } });

    await expect(
      new PurchaseReceiptService(client).confirm({
        receiptId: RECEIPT_ID,
        confirmationKey: "ck-1",
      }),
    ).rejects.toBeInstanceOf(PurchaseContractViolationError);
  });
});

describe("getConfirmation, void, and posting lock", () => {
  test("reads the stored contract and marks it replayed", async () => {
    const response = confirmationResponse(true) as Record<string, unknown>;
    delete response.replayed;
    const { client } = makeStub({ get_purchase_receipt_confirmation: { data: response } });

    const confirmation = await new PurchaseReceiptService(client).getConfirmation(RECEIPT_ID);
    expect(confirmation.confirmation.confirmation_key).toBe("ck-1");
    expect(confirmation.replayed).toBe(true);
  });

  test("void reports replay", async () => {
    const { client } = makeStub({
      void_purchase_receipt: { data: { receipt_id: RECEIPT_ID, status: "void", replayed: true } },
    });
    const result = await new PurchaseReceiptService(client).void({
      receiptId: RECEIPT_ID,
      reason: "duplicate",
    });
    expect(result).toEqual({ receiptId: RECEIPT_ID, status: "void", replayed: true });
  });

  test("void fails closed on an unknown status", async () => {
    const { client } = makeStub({
      void_purchase_receipt: { data: { receipt_id: RECEIPT_ID, status: "cancelled", replayed: false } },
    });
    await expect(
      new PurchaseReceiptService(client).void({ receiptId: RECEIPT_ID, reason: "x" }),
    ).rejects.toBeInstanceOf(PurchaseContractViolationError);
  });

  test("lockForPosting forwards the locking owner", async () => {
    const { client, calls } = makeStub({
      lock_purchase_receipt_for_posting: { data: { receipt_id: RECEIPT_ID, replayed: false } },
    });
    const result = await new PurchaseReceiptService(client).lockForPosting({
      receiptId: RECEIPT_ID,
      lockedBy: "p2c-poster",
    });
    expect(calls[0]!.args.p_locked_by).toBe("p2c-poster");
    expect(result.replayed).toBe(false);
  });
});

describe("mapPurchaseRpcError", () => {
  test("maps a missing receipt", () => {
    expect(mapPurchaseRpcError("purchase receipt r not found")).toBeInstanceOf(
      PurchaseReceiptNotFoundError,
    );
  });

  test("maps a moved draft revision", () => {
    expect(
      mapPurchaseRpcError("purchase receipt r draft_revision moved (expected 1, found 2)"),
    ).toBeInstanceOf(PurchaseReceiptStaleRevisionError);
  });

  test("maps a rival confirmation key", () => {
    expect(
      mapPurchaseRpcError("purchase receipt r already confirmed under a different confirmation_key"),
    ).toBeInstanceOf(PurchaseReceiptConfirmationConflictError);
  });

  test("maps a document identity collision distinctly from a confirmation conflict", () => {
    const mapped = mapPurchaseRpcError(
      "document line-text/DOC 1 already exists under a different source binding (stored group/G1, got group/G2)",
    );
    expect(mapped).toBeInstanceOf(PurchaseDocumentIdentityConflictError);
    expect(mapped).not.toBeInstanceOf(PurchaseReceiptConfirmationConflictError);
  });

  test("maps an out-of-envelope value to a domain error", () => {
    expect(
      mapPurchaseRpcError("item 1: quantity 10000000000000 exceeds the documented numeric(18,6) envelope"),
    ).toBeInstanceOf(PurchaseReceiptDomainError);
  });

  test("maps a posting lock refusal", () => {
    expect(
      mapPurchaseRpcError(
        "purchase receipt r is locked for posting by p2c — void must be performed together with ledger reversal",
      ),
    ).toBeInstanceOf(PurchaseReceiptPostingLockedError);
  });

  test("rethrows an unrecognised database fault instead of mislabelling it", () => {
    const mapped = mapPurchaseRpcError("connection reset by peer");
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped).not.toBeInstanceOf(PurchaseReceiptLifecycleError);
    expect(mapped.message).toBe("connection reset by peer");
  });
});
