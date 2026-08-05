/**
 * In-memory purchase confirmation payload builder matching 0052
 * purchase_receipt_build_confirmation_payload semantics exactly.
 *
 * Used for pre-RPC preview generation (replace flow). Finalize path prefers
 * the live RPC after saveDraft; parity tests keep both paths aligned.
 */

import { parseExactDecimal } from "@/lib/purchases/exact-decimal";
import {
  PURCHASE_CONFIRMATION_CONTRACT_VERSION,
  type PurchaseBlocker,
  type PurchaseConfirmationItem,
  type PurchaseConfirmationPayload,
  type PurchaseReceiptDraftInput,
} from "@/lib/purchase-receipts/types";
import { PURCHASE_INTENDED_WAREHOUSE_MAIN } from "@/lib/purchases";

const QUANTITY_LIMITS = { maxTotalDigits: 18, maxScale: 6 };
const UNIT_COST_LIMITS = { maxTotalDigits: 18, maxScale: 4 };

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TWO = BigInt(2);
const BIGINT_HUNDRED = BigInt(100);

/** PostgreSQL round(numeric) half-away-from-zero for non-negative values. */
export function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BIGINT_ZERO) throw new Error("division by zero");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * BIGINT_TWO >= denominator) return quotient + BIGINT_ONE;
  return quotient;
}

/**
 * round(quantity * unit_cost * 100) — matches generated column line_amount_satang.
 */
export function computeLineAmountSatang(quantity: string, unitCost: string): string {
  const q = parseExactDecimal(quantity, QUANTITY_LIMITS);
  const uc = parseExactDecimal(unitCost, UNIT_COST_LIMITS);
  if (!q.ok || !uc.ok) {
    throw new Error("invalid quantity or unit_cost for line amount");
  }
  const numerator = q.value.coefficient * uc.value.coefficient * BIGINT_HUNDRED;
  const denominator = BigInt(10) ** BigInt(q.value.scale + uc.value.scale);
  return roundHalfAwayFromZero(numerator, denominator).toString();
}

function buildBlockers(
  items: readonly PurchaseConfirmationItem[],
  reviewFlags: PurchaseReceiptDraftInput["reviewFlags"],
): PurchaseBlocker[] {
  const blockers: PurchaseBlocker[] = [];

  const missingCost = items.filter((item) => item.unit_cost == null);
  if (missingCost.length > 0) {
    blockers.push({
      code: "MISSING_UNIT_COST",
      severity: "BLOCKING",
      item_count: missingCost.length,
      item_ordinals: missingCost.map((item) => item.item_ordinal),
      detail: "Document stated no unit rate for these lines; amount is NULL, not zero.",
    });
  }

  const unresolvedProduct = items.filter((item) => item.product_identity_status === "UNRESOLVED");
  if (unresolvedProduct.length > 0) {
    blockers.push({
      code: "UNRESOLVED_PRODUCT_IDENTITY",
      severity: "BLOCKING",
      item_count: unresolvedProduct.length,
      item_ordinals: unresolvedProduct.map((item) => item.item_ordinal),
      detail: "product_key is a raw-text fallback, not a canonical identity.",
    });
  }

  const unresolvedUnit = items.filter((item) => item.unit_identity_status === "UNRESOLVED");
  if (unresolvedUnit.length > 0) {
    blockers.push({
      code: "UNRESOLVED_UNIT_IDENTITY",
      severity: "BLOCKING",
      item_count: unresolvedUnit.length,
      item_ordinals: unresolvedUnit.map((item) => item.item_ordinal),
      detail: "unit_key is a raw-text fallback, not a canonical identity.",
    });
  }

  const unresolvedPriceUnit = items.filter((item) => item.price_unit_status === "UNRESOLVED");
  if (unresolvedPriceUnit.length > 0) {
    blockers.push({
      code: "UNRESOLVED_PRICE_UNIT",
      severity: "BLOCKING",
      item_count: unresolvedPriceUnit.length,
      item_ordinals: unresolvedPriceUnit.map((item) => item.item_ordinal),
      detail: "Rate was quoted against a different unit; 0052 performs no conversion.",
    });
  }

  const flags = reviewFlags ?? [];
  if (flags.length > 0) {
    blockers.push({
      code: "SOURCE_REVIEW_FLAGS",
      severity: "REVIEW",
      item_count: flags.length,
      item_ordinals: [],
      detail: "Slice A raised review flags on this document.",
      flags,
    });
  }

  return blockers;
}

export function buildPreviewConfirmationFromDraft(
  draft: PurchaseReceiptDraftInput,
): PurchaseConfirmationPayload {
  const items: PurchaseConfirmationItem[] = draft.items.map((item, index) => ({
    receipt_item_id: `preview-${index + 1}`,
    item_ordinal: index + 1,
    item_number: item.itemNumber ?? null,
    product_key: item.productKey,
    raw_product_text: item.rawProductText,
    product_identity_status: item.productIdentityStatus ?? "UNRESOLVED",
    quantity: item.quantity,
    unit_key: item.unitKey,
    raw_unit: item.rawUnit,
    unit_identity_status: item.unitIdentityStatus ?? "UNRESOLVED",
    unit_cost: item.unitCost ?? null,
    price_unit_text: item.priceUnitText ?? null,
    price_unit_status: item.priceUnitStatus ?? "NOT_APPLICABLE",
    line_amount_satang:
      item.unitCost == null ? null : computeLineAmountSatang(item.quantity, item.unitCost),
    source_evidence: item.sourceEvidence ?? {},
  }));

  const missingUnitCost = items.some((item) => item.unit_cost == null);
  const lineSubtotal = missingUnitCost
    ? null
    : items.reduce((sum, item) => sum + BigInt(item.line_amount_satang!), BIGINT_ZERO);

  const freight = BigInt(draft.freightSatang ?? "0");
  const handling = BigInt(draft.handlingSatang ?? "0");
  const discount = BigInt(draft.discountSatang ?? "0");
  const vat = draft.vat?.kind === "AMOUNT" ? BigInt(draft.vat.satang) : BIGINT_ZERO;

  const payable = lineSubtotal == null
    ? null
    : lineSubtotal + freight + handling - discount
      + (draft.vat?.kind === "AMOUNT" && !draft.vat.includedInItemPrices ? vat : BIGINT_ZERO);

  const blockers = buildBlockers(items, draft.reviewFlags);
  const hasBlockingBlockers = blockers.some((blocker) => blocker.severity === "BLOCKING");

  return {
    contract_version: PURCHASE_CONFIRMATION_CONTRACT_VERSION,
    receipt_id: "preview",
    document_namespace: draft.documentNamespace,
    document_key: draft.documentKey,
    parser_contract_version: draft.contractVersion,
    source: {
      source_type: draft.sourceType ?? null,
      source_id: draft.sourceId ?? null,
      sender_line_user_id: draft.senderLineUserId ?? null,
      source_line_event_id: draft.sourceLineEventId ?? null,
      source_raw_message_id: draft.sourceRawMessageId ?? null,
      source_evidence: draft.sourceEvidence ?? {},
    },
    business_date: draft.businessDate,
    purchase_time: draft.purchaseTime ?? null,
    supplier_key: draft.supplierKey ?? null,
    supplier_raw: draft.supplierRaw ?? null,
    supplier_ref: draft.supplierRef ?? null,
    reference_text: draft.referenceText ?? null,
    intended_warehouse_code: PURCHASE_INTENDED_WAREHOUSE_MAIN,
    vat_kind: draft.vat?.kind === "AMOUNT" ? "AMOUNT" : "NONE",
    vat_included_in_item_prices: draft.vat?.kind === "AMOUNT" ? draft.vat.includedInItemPrices : null,
    vat_recoverable: draft.vat?.kind === "AMOUNT" ? draft.vat.recoverable : null,
    item_count: items.length,
    items,
    totals: {
      line_subtotal_satang: lineSubtotal?.toString() ?? null,
      freight_satang: freight.toString(),
      handling_satang: handling.toString(),
      discount_satang: discount.toString(),
      vat_satang: draft.vat?.kind === "AMOUNT" ? vat.toString() : null,
      payable_total_satang: payable?.toString() ?? null,
      declared_total_satang: null,
      reconciliation_status: missingUnitCost
        ? "NOT_COMPUTABLE_MISSING_UNIT_COST"
        : "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
    },
    blockers,
    has_blocking_blockers: hasBlockingBlockers,
    posts_inventory_movement: false,
    posts_valuation: false,
  };
}
