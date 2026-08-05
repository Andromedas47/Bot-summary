/**
 * RPC draft payload shape for replace_purchase_capture_draft (§12.2).
 */

import type { Json } from "@/types/database";
import type { PurchaseReceiptDraftInput } from "@/lib/purchase-receipts/types";

export function toRpcDraftPayload(input: PurchaseReceiptDraftInput): Record<string, Json> {
  const vat = input.vat ?? { kind: "NONE" as const };
  return {
    document_namespace: input.documentNamespace,
    document_key: input.documentKey,
    contract_version: input.contractVersion,
    business_date: input.businessDate,
    purchase_time: input.purchaseTime ?? null,
    supplier_key: input.supplierKey ?? null,
    supplier_raw: input.supplierRaw ?? null,
    supplier_ref: input.supplierRef ?? null,
    reference_text: input.referenceText ?? null,
    freight_satang: input.freightSatang ?? "0",
    handling_satang: input.handlingSatang ?? "0",
    discount_satang: input.discountSatang ?? "0",
    vat_kind: vat.kind,
    vat_satang: vat.kind === "AMOUNT" ? vat.satang : null,
    vat_included_in_item_prices: vat.kind === "AMOUNT" ? vat.includedInItemPrices : null,
    vat_recoverable: vat.kind === "AMOUNT" ? vat.recoverable : null,
    source_line_event_id: input.sourceLineEventId ?? null,
    source_raw_message_id: input.sourceRawMessageId ?? null,
    source_evidence: (input.sourceEvidence ?? {}) as Json,
    review_flags: (input.reviewFlags ?? []) as Json,
    supersedes_receipt_id: input.supersedesReceiptId ?? null,
    actor: input.actor ?? null,
    items: input.items.map((item) => ({
      product_key: item.productKey,
      raw_product_text: item.rawProductText,
      product_identity_status: item.productIdentityStatus,
      quantity: item.quantity,
      unit_key: item.unitKey,
      raw_unit: item.rawUnit,
      unit_identity_status: item.unitIdentityStatus,
      unit_cost: item.unitCost ?? null,
      price_unit_text: item.priceUnitText ?? null,
      price_unit_status: item.priceUnitStatus,
      item_number: item.itemNumber ?? null,
      source_evidence: (item.sourceEvidence ?? {}) as Json,
    })) as unknown as Json,
  };
}
