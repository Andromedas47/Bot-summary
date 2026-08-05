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
import { buildPreviewConfirmationFromDraft } from "./preview-confirmation";

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
  if (item.unit_cost == null) {
    return " ⚠️ ไม่ทราบราคาต่อหน่วย";
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
  if (item.unit_cost == null) {
    return `รายการที่ ${item.item_ordinal}: ไม่ทราบราคาต่อหน่วย — ต้องระบุราคาก่อนยืนยัน`;
  }
  return null;
}

function reviewFlagLines(payload: PurchaseConfirmationPayload): string[] {
  const reviewBlocker = payload.blockers.find((blocker) => blocker.code === "SOURCE_REVIEW_FLAGS");
  if (!reviewBlocker?.flags || !Array.isArray(reviewBlocker.flags)) return [];
  return reviewBlocker.flags.map((flag) => {
    if (typeof flag === "object" && flag != null && "code" in flag) {
      return `  - ${String((flag as { code: string }).code)}`;
    }
    return `  - ${String(flag)}`;
  });
}

export function renderPurchaseCapturePreviewText(
  payload: PurchaseConfirmationPayload,
): string {
  const blockers = payload.items
    .map((item) => itemBlockingDetail(item))
    .filter((line): line is string => line != null);
  const blocking = payload.has_blocking_blockers;
  const reviewLines = reviewFlagLines(payload);

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
    payload.totals.payable_total_satang == null
      ? "ยอดชำระสุทธิ: ไม่สามารถคำนวณ"
      : `ยอดชำระสุทธิ: ${formatBahtFromSatangString(payload.totals.payable_total_satang)}`,
    "",
  );

  if (reviewLines.length > 0) {
    lines.push("หมายเหตุจากการตรวจสอบ (ไม่บล็อกการยืนยัน):", ...reviewLines, "");
  }

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

export { buildPreviewConfirmationFromDraft } from "./preview-confirmation";

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
