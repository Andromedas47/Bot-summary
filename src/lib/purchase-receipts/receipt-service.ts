/**
 * P2B Purchase Receipt persistence service.
 *
 * Writes the purchase DOCUMENT layer only:
 *   - draft (full item replace, idempotent on draftKey)
 *   - idempotent confirm (idempotent on confirmationKey)
 *   - void
 *
 * Does NOT write inventory movements. Does NOT write valuation/COGS.
 * Does NOT mutate produce/physical-inventory/slip/white-sheet state.
 *
 * All mutation goes through service_role SECURITY DEFINER RPCs from migration
 * 0052 — this client has no direct table DML and the grants enforce that.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import {
  PURCHASE_RECEIPT_MAX_ITEMS,
  type PurchaseReceiptConfirmation,
  type PurchaseReceiptDraftInput,
  type PurchaseReceiptDraftResult,
  type PurchaseReceiptVoidResult,
} from "./types";

type Supabase = SupabaseClient<Database>;

export class PurchaseReceiptNotFoundError extends Error {
  constructor(message = "purchase_receipt_not_found") {
    super(message);
    this.name = "PurchaseReceiptNotFoundError";
  }
}

/** Draft moved under the caller between read and confirm. */
export class PurchaseReceiptStaleRevisionError extends Error {
  constructor(message = "stale_draft_revision") {
    super(message);
    this.name = "PurchaseReceiptStaleRevisionError";
  }
}

/** Two callers each believe they own the confirmation of one receipt. */
export class PurchaseReceiptConfirmationConflictError extends Error {
  constructor(message = "confirmation_key_conflict") {
    super(message);
    this.name = "PurchaseReceiptConfirmationConflictError";
  }
}

/** Illegal lifecycle transition, or a document that fails its own invariants. */
export class PurchaseReceiptLifecycleError extends Error {
  constructor(message = "invalid_lifecycle_state") {
    super(message);
    this.name = "PurchaseReceiptLifecycleError";
  }
}

/**
 * Maps Postgres RPC failures to typed errors.
 *
 * Matching is on the SQLSTATE-driven message text raised by 0052. An unmatched
 * failure is rethrown as-is rather than being flattened into a generic error,
 * so an unexpected DB fault can never masquerade as an expected lifecycle case.
 */
export function mapPurchaseRpcError(message: string): Error {
  const text = message ?? "";
  if (/not found/iu.test(text)) return new PurchaseReceiptNotFoundError(text);
  if (/draft_revision moved/iu.test(text)) {
    return new PurchaseReceiptStaleRevisionError(text);
  }
  if (/already confirmed under a different confirmation_key/iu.test(text)) {
    return new PurchaseReceiptConfirmationConflictError(text);
  }
  if (
    /can no longer be drafted|cannot be confirmed|has no items|disagrees with|only confirmed receipts|is immutable|illegal purchase receipt transition|is terminal/iu
      .test(text)
  ) {
    return new PurchaseReceiptLifecycleError(text);
  }
  return new Error(text || "purchase_receipt_rpc_failed");
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected an object payload from the RPC`);
  }
  return value as Record<string, unknown>;
}

export class PurchaseReceiptService {
  constructor(private readonly supabase: Supabase) {}

  /**
   * Writes a draft header + items atomically, replacing any existing items for
   * the same draftKey. Safe to retry: a redelivered document updates in place
   * instead of forking a second receipt or duplicating lines.
   */
  async saveDraft(
    input: PurchaseReceiptDraftInput,
  ): Promise<PurchaseReceiptDraftResult> {
    if (input.items.length > PURCHASE_RECEIPT_MAX_ITEMS) {
      throw new PurchaseReceiptLifecycleError(
        `items exceed the ${PURCHASE_RECEIPT_MAX_ITEMS}-line document limit (got ${input.items.length})`,
      );
    }

    const vat = input.vat ?? { kind: "NONE" as const };

    const items = input.items.map((item) => ({
      product_key: item.productKey,
      raw_product_text: item.rawProductText,
      quantity: item.quantity,
      unit_key: item.unitKey,
      raw_unit: item.rawUnit,
      unit_cost: item.unitCost ?? null,
      price_unit_text: item.priceUnitText ?? null,
      item_number: item.itemNumber ?? null,
      source_evidence: (item.sourceEvidence ?? {}) as Json,
    }));

    const { data, error } = await this.supabase.rpc(
      "upsert_purchase_receipt_draft",
      {
        p_draft_key: input.draftKey,
        p_contract_version: input.contractVersion,
        p_business_date: input.businessDate,
        p_items: items as unknown as Json,
        p_purchase_time: input.purchaseTime ?? null,
        p_supplier_key: input.supplierKey ?? null,
        p_supplier_raw: input.supplierRaw ?? null,
        p_supplier_ref: input.supplierRef ?? null,
        p_reference_text: input.referenceText ?? null,
        p_freight_satang: input.freightSatang ?? "0",
        p_handling_satang: input.handlingSatang ?? "0",
        p_discount_satang: input.discountSatang ?? "0",
        p_vat_kind: vat.kind,
        p_vat_satang: vat.kind === "AMOUNT" ? vat.satang : null,
        p_vat_included_in_item_prices:
          vat.kind === "AMOUNT" ? vat.includedInItemPrices : null,
        p_vat_recoverable: vat.kind === "AMOUNT" ? vat.recoverable : null,
        p_source_type: input.sourceType ?? null,
        p_source_id: input.sourceId ?? null,
        p_sender_line_user_id: input.senderLineUserId ?? null,
        p_source_line_event_id: input.sourceLineEventId ?? null,
        p_source_raw_message_id: input.sourceRawMessageId ?? null,
        p_source_evidence: (input.sourceEvidence ?? {}) as Json,
        p_review_flags: (input.reviewFlags ?? []) as Json,
        p_actor: input.actor ?? null,
      },
    );

    if (error) throw mapPurchaseRpcError(error.message ?? "");
    const row = requireObject(data, "saveDraft");

    return {
      receiptId: String(row.receipt_id),
      status: row.status as PurchaseReceiptDraftResult["status"],
      draftRevision: Number(row.draft_revision),
      itemCount: Number(row.item_count),
    };
  }

  /**
   * Freezes the document and returns the P2C confirmation contract.
   *
   * Idempotent on confirmationKey: a redelivered confirm returns the ORIGINAL
   * confirmation with `replayed: true` and writes nothing. Pass
   * expectedDraftRevision to refuse confirming a draft that moved underneath.
   */
  async confirm(params: {
    receiptId: string;
    confirmationKey: string;
    expectedDraftRevision?: number | null;
    actor?: string | null;
  }): Promise<PurchaseReceiptConfirmation> {
    const { data, error } = await this.supabase.rpc("confirm_purchase_receipt", {
      p_receipt_id: params.receiptId,
      p_confirmation_key: params.confirmationKey,
      p_expected_draft_revision: params.expectedDraftRevision ?? null,
      p_actor: params.actor ?? null,
    });

    if (error) throw mapPurchaseRpcError(error.message ?? "");
    return toConfirmation(requireObject(data, "confirm"));
  }

  /** Reads the frozen contract. Throws unless the receipt is confirmed. */
  async getConfirmation(
    receiptId: string,
  ): Promise<PurchaseReceiptConfirmation> {
    const { data, error } = await this.supabase.rpc(
      "get_purchase_receipt_confirmation",
      { p_receipt_id: receiptId },
    );

    if (error) throw mapPurchaseRpcError(error.message ?? "");
    const row = requireObject(data, "getConfirmation");
    return toConfirmation({ ...row, replayed: true });
  }

  /** Voids a receipt. Idempotent: voiding an already-void receipt is a no-op. */
  async void(params: {
    receiptId: string;
    reason: string;
    actor?: string | null;
  }): Promise<PurchaseReceiptVoidResult> {
    const { data, error } = await this.supabase.rpc("void_purchase_receipt", {
      p_receipt_id: params.receiptId,
      p_reason: params.reason,
      p_actor: params.actor ?? null,
    });

    if (error) throw mapPurchaseRpcError(error.message ?? "");
    const row = requireObject(data, "void");
    return {
      receiptId: String(row.receipt_id),
      status: row.status as PurchaseReceiptVoidResult["status"],
      replayed: Boolean(row.replayed),
    };
  }
}

function toConfirmation(
  row: Record<string, unknown>,
): PurchaseReceiptConfirmation {
  return {
    receiptId: String(row.receipt_id),
    status: row.status as PurchaseReceiptConfirmation["status"],
    confirmationKey: String(row.confirmation_key),
    confirmationHash: String(row.confirmation_hash),
    confirmedAt: String(row.confirmed_at),
    replayed: Boolean(row.replayed),
    payload: row.payload as PurchaseReceiptConfirmation["payload"],
  };
}
