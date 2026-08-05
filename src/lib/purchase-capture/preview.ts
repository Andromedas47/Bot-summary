/**
 * Purchase capture draft preview rendering (plan §11).
 */

import { satangToBahtText } from "@/lib/sales/calculate";
import { chunkBlocks, LINE_MESSAGE_MAX_CODE_POINTS } from "@/lib/summary/line-chunking";
import type {
  PurchaseConfirmationItem,
  PurchaseConfirmationPayload,
  PurchaseReceiptDraftInput,
} from "@/lib/purchase-receipts/types";
import { PURCHASE_CONFIRMATION_CONTRACT_VERSION } from "@/lib/purchase-receipts/types";
import { PURCHASE_INTENDED_WAREHOUSE_MAIN } from "@/lib/purchases";
import { itemHasBlockingIdentity } from "./identity";

function formatDisplayBusinessDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) return isoDate;
  const buddhistYear = Number(year) + 543;
  return `${Number(day)}/${Number(month)}/${buddhistYear}`;
}

function formatPurchaseDateTime(payload: PurchaseConfirmationPayload): string {
  const date = formatDisplayBusinessDate(payload.business_date);
  if (!payload.purchase_time) return date;
  const time = payload.purchase_time.slice(0, 5);
  return `${date} ${time}`;
}

function formatBahtFromSatangString(satang: string | null): string {
  if (satang == null) return "—";
  return `${satangToBahtText(Number(satang))} บาท`;
}

function itemLineAmount(item: PurchaseConfirmationItem): string {
  return formatBahtFromSatangString(item.line_amount_satang);
}

function itemBlockingLabel(item: PurchaseConfirmationItem): string {
  if (item.product_identity_status !== "RESOLVED") {
    return " ⚠️ ยังไม่รู้จักชื่อสินค้านี้";
  }
  if (
    item.unit_identity_status !== "RESOLVED"
    || item.price_unit_status === "UNRESOLVED"
  ) {
    return " ⚠️ หน่วยราคาต่างจากหน่วยจำนวน";
  }
  return "";
}

function itemBlockingDetail(item: PurchaseConfirmationItem): string | null {
  if (item.product_identity_status !== "RESOLVED") {
    return `รายการที่ ${item.item_ordinal}: "${item.raw_product_text}" ยังไม่ได้ลงทะเบียนสินค้า`;
  }
  if (
    item.unit_identity_status !== "RESOLVED"
    || item.price_unit_status === "UNRESOLVED"
  ) {
    return `รายการที่ ${item.item_ordinal}: หน่วย "${item.raw_unit}" กับ "${item.price_unit_text ?? "—"}" ต้องเป็นหน่วยเดียวกัน หรือยังไม่ได้ลงทะเบียนหน่วยนี้`;
  }
  return null;
}

function hasBlockingItems(payload: PurchaseConfirmationPayload): boolean {
  return payload.items.some((item) =>
    itemHasBlockingIdentity({
      productIdentityStatus: item.product_identity_status,
      unitIdentityStatus: item.unit_identity_status,
      priceUnitStatus: item.price_unit_status,
    })
  );
}

export function renderPurchaseCapturePreviewText(
  payload: PurchaseConfirmationPayload,
): string {
  const blockers = payload.items
    .map((item) => itemBlockingDetail(item))
    .filter((line): line is string => line != null);
  const blocking = hasBlockingItems(payload);

  const lines: string[] = [
    blocking ? "สรุปใบซื้อ (มีรายการต้องแก้ไข)" : "สรุปใบซื้อ (รอยืนยัน)",
    "",
    `วันที่ซื้อ: ${formatPurchaseDateTime(payload)}`,
    `ผู้ขาย: ${payload.supplier_raw ?? "—"}`,
    `ใบอ้างอิง: ${payload.reference_text ?? "ไม่มี"}`,
    `ปลายทาง: ${payload.intended_warehouse_code}`,
    "",
  ];

  for (const item of payload.items) {
    lines.push(
      `รายการที่ ${item.item_ordinal}: ${item.raw_product_text}${itemBlockingLabel(item)}`,
      `  จำนวน: ${item.quantity} ${item.raw_unit}`,
      item.unit_cost == null
        ? "  ราคา: ไม่ทราบ"
        : `  ราคา: ${item.unit_cost} บาท/${item.price_unit_text ?? item.raw_unit}`,
      `  รวม: ${itemLineAmount(item)}`,
      "",
    );
  }

  lines.push(
    `ค่าขนส่ง: ${formatBahtFromSatangString(payload.totals.freight_satang)}`,
    `ค่าจัดการ: ${formatBahtFromSatangString(payload.totals.handling_satang)}`,
    `ส่วนลด: ${formatBahtFromSatangString(payload.totals.discount_satang)}`,
    payload.vat_kind === "NONE"
      ? "ภาษีมูลค่าเพิ่ม: ไม่มี"
      : `ภาษีมูลค่าเพิ่ม: ${formatBahtFromSatangString(payload.totals.vat_satang)}`,
    "",
    `ยอดชำระสุทธิ: ${formatBahtFromSatangString(payload.totals.payable_total_satang)}`,
    "",
  );

  if (blocking) {
    lines.push(
      "รายการที่ต้องแก้ไขก่อนบันทึกเข้าสต๊อก:",
      ...blockers.map((line) => `  - ${line}`),
      "",
      "ใบซื้อนี้ยังไม่สามารถยืนยันเข้าสต๊อกได้ จนกว่ารายการที่มีปัญหาจะได้รับการแก้ไขครบ",
      "",
      'หลังแก้ไขข้อมูลลงทะเบียนแล้ว พิมพ์ "ตรวจใบซื้อใหม่" เพื่อตรวจสอบอีกครั้ง',
      'พิมพ์ "ยกเลิกซื้อ" เพื่อยกเลิก',
    );
  } else {
    lines.push(
      "ไม่มีรายการที่ต้องแก้ไข",
      "",
      'พิมพ์ "ยืนยันซื้อ" เพื่อบันทึกเข้าสต๊อก',
      'พิมพ์ "ยกเลิกซื้อ" เพื่อยกเลิก',
    );
  }

  return lines.join("\n");
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
    line_amount_satang: item.unitCost
      ? multiplyDecimalStrings(item.quantity, item.unitCost)
      : null,
    source_evidence: item.sourceEvidence ?? {},
  }));

  const lineSubtotal = items.reduce((sum, item) => {
    if (item.line_amount_satang == null) return sum;
    return sum + BigInt(item.line_amount_satang);
  }, BigInt(0));

  const freight = BigInt(draft.freightSatang ?? "0");
  const handling = BigInt(draft.handlingSatang ?? "0");
  const discount = BigInt(draft.discountSatang ?? "0");
  const vat = draft.vat?.kind === "AMOUNT" ? BigInt(draft.vat.satang) : BigInt(0);
  const payable = lineSubtotal + freight + handling - discount
    + (draft.vat?.kind === "AMOUNT" && !draft.vat.includedInItemPrices ? vat : BigInt(0));

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
      line_subtotal_satang: items.some((item) => item.line_amount_satang == null)
        ? null
        : lineSubtotal.toString(),
      freight_satang: freight.toString(),
      handling_satang: handling.toString(),
      discount_satang: discount.toString(),
      vat_satang: draft.vat?.kind === "AMOUNT" ? vat.toString() : null,
      payable_total_satang: items.some((item) => item.line_amount_satang == null)
        ? null
        : payable.toString(),
      declared_total_satang: null,
      reconciliation_status: items.some((item) => item.line_amount_satang == null)
        ? "NOT_COMPUTABLE_MISSING_UNIT_COST"
        : "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
    },
    blockers: [],
    has_blocking_blockers: items.some((item) =>
      item.product_identity_status !== "RESOLVED"
      || item.unit_identity_status !== "RESOLVED"
      || (item.price_unit_status !== "NOT_APPLICABLE" && item.price_unit_status !== "RESOLVED")),
    posts_inventory_movement: false,
    posts_valuation: false,
  };
}

function multiplyDecimalStrings(quantity: string, unitCost: string): string | null {
  const [qWhole, qFrac = ""] = quantity.split(".");
  const [cWhole, cFrac = ""] = unitCost.split(".");
  const q = BigInt(`${qWhole}${qFrac}`);
  const c = BigInt(`${cWhole}${cFrac}`);
  const scale = BigInt(10) ** BigInt(qFrac.length + cFrac.length);
  const product = q * c;
  const satang = product * BigInt(100) / scale;
  return satang.toString();
}

export function renderPurchaseCapturePreviewPayloadTextsFromDraft(
  draft: PurchaseReceiptDraftInput,
): string[] {
  return renderPurchaseCapturePreviewPayloadTexts(buildPreviewConfirmationFromDraft(draft));
}

export function renderPurchaseCapturePreviewPayloadTexts(
  payload: PurchaseConfirmationPayload,
): string[] {
  const text = renderPurchaseCapturePreviewText(payload);
  return chunkBlocks([text], LINE_MESSAGE_MAX_CODE_POINTS);
}
