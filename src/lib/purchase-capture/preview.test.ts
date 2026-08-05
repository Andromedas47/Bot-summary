import { describe, expect, test } from "bun:test";
import {
  CLOSE_TWO,
  COSTS_NO_VAT,
  HEADER_KNOWN,
  ITEM_ONE,
  ITEM_TWO_UNKNOWN,
} from "@/lib/purchases/test-helpers";
import {
  buildPurchaseReceiptDraftInput,
  parsePurchaseCaptureAssembly,
} from "./parser-adapter";
import type { PurchaseCaptureParseContext } from "./parser-adapter";
import {
  buildPreviewConfirmationFromDraft,
  renderPurchaseCapturePreviewPayloadTextsFromDraft,
  renderPurchaseCapturePreviewText,
} from "./preview";

const context: PurchaseCaptureParseContext = {
  sourceType: "group",
  sourceId: "G-preview",
  senderLineUserId: "U-preview",
  openedLineEventId: "evt-open-preview",
};

function completeAssembly(itemTwo = ITEM_TWO_UNKNOWN) {
  return parsePurchaseCaptureAssembly(
    [
      {
        line_event_id: "evt-header",
        line_timestamp_ms: 1000,
        kind: "header",
        raw_text: HEADER_KNOWN,
        ingest_ordinal: 1,
      },
      {
        line_event_id: "evt-item-1",
        line_timestamp_ms: 2000,
        kind: "item",
        raw_text: ITEM_ONE,
        ingest_ordinal: 2,
      },
      {
        line_event_id: "evt-item-2",
        line_timestamp_ms: 2500,
        kind: "item",
        raw_text: itemTwo,
        ingest_ordinal: 3,
      },
      {
        line_event_id: "evt-costs",
        line_timestamp_ms: 3000,
        kind: "costs",
        raw_text: COSTS_NO_VAT,
        ingest_ordinal: 4,
      },
      {
        line_event_id: "evt-close",
        line_timestamp_ms: 4000,
        kind: "close",
        raw_text: CLOSE_TWO,
        ingest_ordinal: 5,
      },
    ],
    context,
  );
}

const ITEM_TWO_RESOLVED = `ซื้อรายการ 2
สินค้า: องุ่นเขียวตะกร้าแดง
จำนวน: 6 ตะกร้า
ราคา: 120 บาท/ตะกร้า`;

describe("purchase capture preview rendering", () => {
  test("shows รอยืนยัน when identities resolve", () => {
    const assembly = completeAssembly(ITEM_TWO_RESOLVED);
    const draft = buildPurchaseReceiptDraftInput({
      assembly,
      context,
      products: new Map([
        ["หมอนทอง", { raw_product_text: "หมอนทอง", product_key: "durian-monthong", active: true }],
        ["องุ่นเขียวตะกร้าแดง", {
          raw_product_text: "องุ่นเขียวตะกร้าแดง",
          product_key: "grape-green",
          active: true,
        }],
      ]),
      units: new Map([
        ["โล", { raw_unit_text: "โล", unit_key: "kg", active: true }],
        ["ตะกร้า", { raw_unit_text: "ตะกร้า", unit_key: "basket", active: true }],
      ]),
    });
    expect(draft).not.toBeNull();
    const payload = buildPreviewConfirmationFromDraft(draft!);
    const text = renderPurchaseCapturePreviewText(payload);
    expect(text).toContain("สรุปใบซื้อ (รอยืนยัน)");
    expect(text).toContain("ไม่มีรายการที่ต้องแก้ไข");
    expect(text).toContain("ยืนยันซื้อ");
  });

  test("shows blocker status when product/unit unresolved", () => {
    const assembly = completeAssembly();
    const draft = buildPurchaseReceiptDraftInput({
      assembly,
      context,
      products: new Map(),
      units: new Map(),
    });
    expect(draft).not.toBeNull();
    const texts = renderPurchaseCapturePreviewPayloadTextsFromDraft(draft!);
    const joined = texts.join("\n");
    expect(joined).toContain("สรุปใบซื้อ (มีรายการต้องแก้ไข)");
    expect(joined).toContain("รายการที่ต้องแก้ไขก่อนบันทึกเข้าสต๊อก");
    expect(joined).toContain("ตรวจใบซื้อใหม่");
    expect(joined).not.toContain('พิมพ์ "ยืนยันซื้อ"');
  });

  test("includes header, items, costs, totals, and review context", () => {
    const assembly = completeAssembly();
    const draft = buildPurchaseReceiptDraftInput({
      assembly,
      context,
      products: new Map([
        ["หมอนทอง", { raw_product_text: "หมอนทอง", product_key: "durian-monthong", active: true }],
      ]),
      units: new Map([
        ["โล", { raw_unit_text: "โล", unit_key: "kg", active: true }],
      ]),
    });
    const payload = buildPreviewConfirmationFromDraft(draft!);
    const text = renderPurchaseCapturePreviewText(payload);
    expect(text).toContain("ร้านเจ๊แดง");
    expect(text).toContain("หมอนทอง");
    expect(text).toContain("ค่าขนส่ง");
    expect(text).toContain("ยอดชำระสุทธิ");
  });
});
