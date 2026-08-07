/**
 * P2C Slice C2 — posted_success notification rendering.
 *
 * Renders the LINE message sent after a purchase receipt has been posted into
 * the inventory ledger. Deliberately mirrors the formatting STYLE of
 * ./preview.ts (buildPreviewConfirmationFromDraft's Thai copy, Buddhist-year
 * date formatting) without importing from it — preview.ts does not export
 * these helpers, and this module defines its own local copies so the two
 * renderers can evolve independently.
 *
 * CRITICAL: output must be a PURE, DETERMINISTIC function of `payload` alone —
 * byte-identical on every replay. complete_purchase_capture_posting raises
 * notification_identity_conflict if the payload text differs from an existing
 * part set, so this must never depend on the clock, locale, or ordering that
 * varies between calls. `movementId` is accepted only because it is the
 * notification_version the caller threads through separately — it is NEVER
 * printed in the rendered text.
 *
 * Does NOT print any money amount, unit cost, line amount, payable total, or
 * valuation figure. The single "หมายเหตุ" line below is the only mention of
 * cost, and it explicitly states that cost has not been computed.
 */

import { chunkBlocks, LINE_MESSAGE_MAX_CODE_POINTS } from "@/lib/summary/line-chunking";
import type { PurchaseConfirmationPayload } from "@/lib/purchase-receipts/types";

/** Copied verbatim from preview.ts's formatDisplayBusinessDate. */
function formatDisplayBusinessDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) return isoDate;
  const buddhistYear = Number(year) + 543;
  return `${Number(day)}/${Number(month)}/${buddhistYear}`;
}

/** Copied verbatim from preview.ts's formatPurchaseDateTime. */
function formatPurchaseDateTime(payload: PurchaseConfirmationPayload): string {
  const date = formatDisplayBusinessDate(payload.business_date);
  if (!payload.purchase_time) return date;
  const time = payload.purchase_time.slice(0, 5);
  return `${date} ${time}`;
}

export function renderPurchaseCapturePostedSuccessText(params: {
  payload: PurchaseConfirmationPayload;
  movementId: string;
}): string {
  const { payload } = params;

  const lines: string[] = [
    "ยืนยันใบซื้อแล้ว",
    "บันทึกสินค้าเข้าสต๊อกคลังหลักแล้ว",
    "",
    `วันที่ซื้อ: ${formatPurchaseDateTime(payload)}`,
    `ผู้ขาย: ${payload.supplier_raw ?? "—"}`,
    `ใบอ้างอิง: ${payload.reference_text ?? "ไม่มี"}`,
    `ปลายทาง: ${payload.intended_warehouse_code}`,
    "",
  ];

  for (const item of payload.items) {
    lines.push(
      `รายการที่ ${item.item_ordinal}: ${item.raw_product_text}`,
      `  จำนวน: ${item.quantity} ${item.raw_unit}`,
    );
  }

  lines.push(
    "",
    `รวมทั้งหมด: ${payload.item_count} รายการ`,
    "",
    "หมายเหตุ: บันทึกเฉพาะจำนวนสินค้าเข้าสต๊อก ยังไม่คำนวณต้นทุนจริงและมูลค่าสินค้า",
  );

  return lines.join("\n");
}

export function renderPurchaseCapturePostedSuccessPayloadTexts(params: {
  payload: PurchaseConfirmationPayload;
  movementId: string;
}): string[] {
  const text = renderPurchaseCapturePostedSuccessText(params);
  return chunkBlocks([text], LINE_MESSAGE_MAX_CODE_POINTS);
}
