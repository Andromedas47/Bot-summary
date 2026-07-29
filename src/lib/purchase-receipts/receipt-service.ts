/**
 * P2B Purchase Receipt persistence service.
 *
 * Writes the purchase DOCUMENT layer only:
 *   - draft (full item replace, keyed on normalized document identity)
 *   - idempotent confirm (idempotent on confirmationKey)
 *   - void (idempotent, refused once P2C has locked the receipt for posting)
 *   - posting lock (the P2C extension hook)
 *
 * Does NOT write inventory movements. Does NOT write valuation/COGS.
 * Does NOT mutate produce/physical-inventory/slip/white-sheet state.
 * Does NOT wire LINE webhooks.
 *
 * All mutation goes through service_role SECURITY DEFINER RPCs from migration
 * 0052 — this client has no direct table DML and the grants enforce that.
 *
 * Every response is validated at runtime (see ./validate). Nothing is cast.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import {
  PurchaseContractViolationError,
  isPlainObject,
  parseConfirmationResponse,
  parseDraftResponse,
  parsePostingLockResponse,
  parseVoidResponse,
} from "./validate";
import {
  PURCHASE_RECEIPT_MAX_ITEMS,
  type PurchaseReceiptConfirmation,
  type PurchaseReceiptDraftInput,
  type PurchaseReceiptDraftResult,
  type PurchaseReceiptPostingLockResult,
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

/**
 * A document key already exists under a different source binding.
 *
 * Distinct from a confirmation conflict: this means caller-supplied text would
 * have overwritten an unrelated document, and the write was refused.
 */
export class PurchaseDocumentIdentityConflictError extends Error {
  constructor(message = "document_identity_conflict") {
    super(message);
    this.name = "PurchaseDocumentIdentityConflictError";
  }
}

/** Input outside the documented Slice A envelope. */
export class PurchaseReceiptDomainError extends Error {
  constructor(message = "value_outside_documented_envelope") {
    super(message);
    this.name = "PurchaseReceiptDomainError";
  }
}

/** Illegal lifecycle transition, or a document that fails its own invariants. */
export class PurchaseReceiptLifecycleError extends Error {
  constructor(message = "invalid_lifecycle_state") {
    super(message);
    this.name = "PurchaseReceiptLifecycleError";
  }
}

/** Void refused because P2C holds a posting lock on the receipt. */
export class PurchaseReceiptPostingLockedError extends Error {
  constructor(message = "receipt_locked_for_posting") {
    super(message);
    this.name = "PurchaseReceiptPostingLockedError";
  }
}

/**
 * Maps Postgres RPC failures to typed errors.
 *
 * An unmatched failure is rethrown as-is rather than flattened into a generic
 * lifecycle error, so an unexpected DB fault can never masquerade as an
 * expected business case.
 */
export function mapPurchaseRpcError(message: string): Error {
  const text = message ?? "";
  if (/not found/iu.test(text)) return new PurchaseReceiptNotFoundError(text);
  if (/draft_revision moved/iu.test(text)) return new PurchaseReceiptStaleRevisionError(text);
  if (/already confirmed under a different confirmation_key/iu.test(text)) {
    return new PurchaseReceiptConfirmationConflictError(text);
  }
  if (/different source binding/iu.test(text)) {
    return new PurchaseDocumentIdentityConflictError(text);
  }
  if (/locked for posting/iu.test(text)) return new PurchaseReceiptPostingLockedError(text);
  if (/exceeds the documented|must be greater than zero|must not be negative/iu.test(text)) {
    return new PurchaseReceiptDomainError(text);
  }
  if (
    /can no longer be drafted|cannot be confirmed|has no items|disagrees with|never been confirmed|is immutable|illegal purchase receipt transition|is terminal|must not be blank|document identity is immutable|500-line document limit|can be locked for posting/iu
      .test(text)
  ) {
    return new PurchaseReceiptLifecycleError(text);
  }
  return new Error(text || "purchase_receipt_rpc_failed");
}

function requireRpcObject(value: unknown, context: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new PurchaseContractViolationError(
      `expected an object payload from the RPC, got ${value === null ? "null" : typeof value}`,
      context,
    );
  }
  return value;
}

export class PurchaseReceiptService {
  constructor(private readonly supabase: Supabase) {}

  /**
   * Writes a draft header + items atomically, replacing any existing items for
   * the same document identity.
   *
   * Safe to retry: a redelivered document updates in place instead of forking a
   * second receipt or duplicating lines. A key already bound to a different
   * source fails closed rather than overwriting an unrelated document.
   */
  async saveDraft(input: PurchaseReceiptDraftInput): Promise<PurchaseReceiptDraftResult> {
    if (input.items.length > PURCHASE_RECEIPT_MAX_ITEMS) {
      throw new PurchaseReceiptLifecycleError(
        `items exceed the ${PURCHASE_RECEIPT_MAX_ITEMS}-line document limit (got ${input.items.length})`,
      );
    }

    const vat = input.vat ?? { kind: "NONE" as const };

    const items = input.items.map((item) => ({
      product_key: item.productKey,
      raw_product_text: item.rawProductText,
      product_identity_status: item.productIdentityStatus ?? "RESOLVED",
      quantity: item.quantity,
      unit_key: item.unitKey,
      raw_unit: item.rawUnit,
      unit_identity_status: item.unitIdentityStatus ?? "RESOLVED",
      unit_cost: item.unitCost ?? null,
      price_unit_text: item.priceUnitText ?? null,
      price_unit_status:
        item.priceUnitStatus ?? (item.priceUnitText == null ? "NOT_APPLICABLE" : "UNRESOLVED"),
      item_number: item.itemNumber ?? null,
      source_evidence: (item.sourceEvidence ?? {}) as Json,
    }));

    const { data, error } = await this.supabase.rpc("upsert_purchase_receipt_draft", {
      p_document_namespace: input.documentNamespace,
      p_document_key: input.documentKey,
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
      p_vat_included_in_item_prices: vat.kind === "AMOUNT" ? vat.includedInItemPrices : null,
      p_vat_recoverable: vat.kind === "AMOUNT" ? vat.recoverable : null,
      p_source_type: input.sourceType ?? null,
      p_source_id: input.sourceId ?? null,
      p_sender_line_user_id: input.senderLineUserId ?? null,
      p_source_line_event_id: input.sourceLineEventId ?? null,
      p_source_raw_message_id: input.sourceRawMessageId ?? null,
      p_source_evidence: (input.sourceEvidence ?? {}) as Json,
      p_review_flags: (input.reviewFlags ?? []) as unknown as Json,
      p_supersedes_receipt_id: input.supersedesReceiptId ?? null,
      p_actor: input.actor ?? null,
    });

    if (error) throw mapPurchaseRpcError(error.message ?? "");
    return parseDraftResponse(data);
  }

  /**
   * Freezes the document and returns the P2C confirmation contract.
   *
   * Idempotent on confirmationKey: a redelivered confirm returns the ORIGINAL
   * frozen snapshot with `replayed: true` and writes nothing. Pass
   * expectedDraftRevision to refuse confirming a draft that moved underneath.
   */
  async confirm(params: {
    receiptId: string;
    confirmationKey: string;
    expectedDraftRevision?: string | null;
    actor?: string | null;
  }): Promise<PurchaseReceiptConfirmation> {
    const { data, error } = await this.supabase.rpc("confirm_purchase_receipt", {
      p_receipt_id: params.receiptId,
      p_confirmation_key: params.confirmationKey,
      p_expected_draft_revision: params.expectedDraftRevision ?? null,
      p_actor: params.actor ?? null,
    });

    if (error) throw mapPurchaseRpcError(error.message ?? "");
    return parseConfirmationResponse(data);
  }

  /**
   * Reads the frozen contract as stored at confirmation time.
   *
   * Still returns the confirmation after the receipt is voided — void metadata
   * arrives as a separate field, so history survives.
   */
  async getConfirmation(receiptId: string): Promise<PurchaseReceiptConfirmation> {
    const { data, error } = await this.supabase.rpc("get_purchase_receipt_confirmation", {
      p_receipt_id: receiptId,
    });

    if (error) throw mapPurchaseRpcError(error.message ?? "");
    // The getter has no `replayed` notion; it always reads an existing snapshot.
    const row = requireRpcObject(data, "getConfirmation");
    return parseConfirmationResponse({ ...row, replayed: true });
  }

  /**
   * P2C extension hook: marks the receipt as having posted movements, after
   * which a standalone void is refused so document void and ledger reversal
   * must happen in one P2C transaction.
   */
  async lockForPosting(params: {
    receiptId: string;
    lockedBy: string;
  }): Promise<PurchaseReceiptPostingLockResult> {
    const { data, error } = await this.supabase.rpc("lock_purchase_receipt_for_posting", {
      p_receipt_id: params.receiptId,
      p_locked_by: params.lockedBy,
    });

    if (error) throw mapPurchaseRpcError(error.message ?? "");
    return parsePostingLockResponse(data);
  }

  /** Voids a receipt. Idempotent; refused while a posting lock is held. */
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
    return parseVoidResponse(data);
  }
}
