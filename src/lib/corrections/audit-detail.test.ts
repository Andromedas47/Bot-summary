import { describe, expect, test } from "bun:test";
import { mapCorrectionAuditDetail } from "@/lib/corrections/audit-detail";
import type { CorrectionSnapshot, TransactionCorrection } from "@/lib/corrections/types";

const before: CorrectionSnapshot = {
  sourceTransactionId: "11111111-1111-1111-1111-111111111111",
  sourceLineMessageId: "line-123",
  sourceVersion: "raw:11111111-1111-1111-1111-111111111111",
  productName: "หมอนทอง",
  sourceNames: ["หมอนทอง"],
  quantity: 39.4,
  unit: "กก.",
  priceAmount: 119,
  priceQuantity: 1,
  totalAmount: 4688.6,
  transactionType: "เบิก",
  transactionDate: "2026-07-16",
  staffName: "ปลา",
  marketName: "ตลาดกลาง",
  voided: false,
};

const correction: TransactionCorrection = {
  id: "22222222-2222-2222-2222-222222222222",
  target_transaction_id: before.sourceTransactionId,
  status: "approved",
  reason_type: "wrong_price",
  reason_detail: "ราคาผิด",
  requested_changes: { priceAmount: 109, priceQuantity: 1 },
  before_snapshot: before,
  after_snapshot: { ...before, priceAmount: 109, totalAmount: 4294.6 },
  requested_by: "33333333-3333-3333-3333-333333333333",
  requested_at: "2026-07-16T10:00:00Z",
  approved_by: "44444444-4444-4444-4444-444444444444",
  approved_at: "2026-07-16T11:00:00Z",
  rejected_by: null,
  rejected_at: null,
  rejection_reason: null,
  supersedes_correction_id: "55555555-5555-5555-5555-555555555555",
  source_line_message_id: "line-123",
  evidence_url: "https://example.test/evidence",
  target_version: before.sourceVersion,
  request_key: "66666666-6666-6666-6666-666666666666",
  created_at: "2026-07-16T10:00:00Z",
  updated_at: "2026-07-16T11:00:00Z",
};

describe("correction audit detail mapper", () => {
  test("exposes the complete approval and financial audit record", () => {
    const detail = mapCorrectionAuditDetail(
      correction,
      "77777777-7777-7777-7777-777777777777",
    );
    expect(detail).toMatchObject({
      targetTransactionId: before.sourceTransactionId,
      requestedBy: correction.requested_by,
      requestedAt: correction.requested_at,
      approvedBy: correction.approved_by,
      approvedAt: correction.approved_at,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      sourceLineMessageId: "line-123",
      evidenceUrl: "https://example.test/evidence",
      supersedesCorrectionId: correction.supersedes_correction_id,
      supersededById: "77777777-7777-7777-7777-777777777777",
      beforeProductName: "หมอนทอง",
      afterProductName: "หมอนทอง",
      beforeQuantity: 39.4,
      afterQuantity: 39.4,
      beforePriceAmount: 119,
      afterPriceAmount: 109,
      beforePriceQuantity: 1,
      afterPriceQuantity: 1,
      beforeTotalAmount: 4688.6,
      afterTotalAmount: 4294.6,
      financialDelta: -394,
      targetVersion: before.sourceVersion,
      beforeSourceVersion: before.sourceVersion,
      afterSourceVersion: before.sourceVersion,
    });
  });
});
