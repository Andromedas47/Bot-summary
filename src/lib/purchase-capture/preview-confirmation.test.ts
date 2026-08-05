import { describe, expect, test } from "bun:test";
import {
  buildPreviewConfirmationFromDraft,
  computeLineAmountSatang,
  roundHalfAwayFromZero,
} from "./preview-confirmation";
import type { PurchaseReceiptDraftInput } from "@/lib/purchase-receipts/types";
import { renderPurchaseCapturePreviewText } from "./preview";

describe("preview confirmation exact money", () => {
  test("roundHalfAwayFromZero matches PostgreSQL half-away-from-zero", () => {
    expect(roundHalfAwayFromZero(BigInt(5), BigInt(10))).toBe(BigInt(1));
    expect(roundHalfAwayFromZero(BigInt(4), BigInt(10))).toBe(BigInt(0));
  });

  test("computeLineAmountSatang matches round(quantity * unit_cost * 100)", () => {
    expect(computeLineAmountSatang("2.5", "12.3456")).toBe("3086");
    expect(computeLineAmountSatang("1", "0.005")).toBe("1");
  });

  test("MISSING_UNIT_COST is blocking and makes payable non-computable", () => {
    const draft: PurchaseReceiptDraftInput = {
      documentNamespace: "line-text",
      documentKey: "evt-1",
      contractVersion: "p2b-slice-a-v1",
      businessDate: "2026-07-29",
      freightSatang: "0",
      handlingSatang: "0",
      discountSatang: "0",
      vat: { kind: "NONE" },
      items: [{
        productKey: "p",
        rawProductText: "p",
        productIdentityStatus: "RESOLVED",
        quantity: "3",
        unitKey: "kg",
        rawUnit: "kg",
        unitIdentityStatus: "RESOLVED",
        unitCost: null,
        priceUnitStatus: "NOT_APPLICABLE",
      }],
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
    };
    const payload = buildPreviewConfirmationFromDraft(draft);
    expect(payload.has_blocking_blockers).toBe(true);
    expect(payload.blockers.some((b) => b.code === "MISSING_UNIT_COST")).toBe(true);
    expect(payload.totals.payable_total_satang).toBeNull();
    const text = renderPurchaseCapturePreviewText(payload);
    expect(text).toContain("ไม่สามารถคำนวณ");
    expect(text).toContain("มีรายการต้องแก้ไข");
  });

  test("review flags alone stay non-blocking", () => {
    const draft: PurchaseReceiptDraftInput = {
      documentNamespace: "line-text",
      documentKey: "evt-2",
      contractVersion: "p2b-slice-a-v1",
      businessDate: "2026-07-29",
      freightSatang: "0",
      handlingSatang: "0",
      discountSatang: "0",
      vat: { kind: "NONE" },
      items: [{
        productKey: "p",
        rawProductText: "p",
        productIdentityStatus: "RESOLVED",
        quantity: "1",
        unitKey: "kg",
        rawUnit: "kg",
        unitIdentityStatus: "RESOLVED",
        unitCost: "10",
        priceUnitStatus: "NOT_APPLICABLE",
      }],
      reviewFlags: [{ code: "NO_REFERENCE", severity: "REVIEW", detail: "test" }],
      sourceType: "group",
      sourceId: "G1",
      senderLineUserId: "U1",
    };
    const payload = buildPreviewConfirmationFromDraft(draft);
    expect(payload.has_blocking_blockers).toBe(false);
    expect(payload.blockers.some((b) => b.code === "SOURCE_REVIEW_FLAGS")).toBe(true);
    const text = renderPurchaseCapturePreviewText(payload);
    expect(text).toContain("รอยืนยัน");
    expect(text).toContain("หมายเหตุจากการตรวจสอบ");
  });
});
