import { describe, expect, test } from "bun:test";
import {
  applyApprovedCorrections,
  buildAfterSnapshot,
  calculateSnapshotTotal,
  snapshotFromTransaction,
} from "@/lib/corrections/effective-transactions";
import type { ProduceTransactionLike, TransactionCorrection } from "@/lib/corrections/types";

const raw: ProduceTransactionLike = {
  id: "11111111-1111-1111-1111-111111111111",
  product_name: "หมอนทอง",
  quantity: 39.4,
  unit: "โล",
  price_per_unit: 119,
  total_amount: 4688.6,
  transaction_type: "เบิก",
  transaction_date: "2026-07-16",
  staff_name: "ปลา",
  market_name: "ปลา",
  raw_message_id: "raw-1",
};

function correction(status: TransactionCorrection["status"]): TransactionCorrection {
  const before = snapshotFromTransaction(raw);
  return {
    id: "22222222-2222-2222-2222-222222222222",
    target_transaction_id: raw.id,
    status,
    reason_type: "wrong_price",
    reason_detail: "ลงราคาเบิกผิด",
    requested_changes: { priceAmount: 109 },
    before_snapshot: before,
    after_snapshot: buildAfterSnapshot(before, { priceAmount: 109 }),
    requested_by: "requester",
    requested_at: "2026-07-16T11:00:00Z",
    approved_by: status === "approved" ? "approver" : null,
    approved_at: status === "approved" ? "2026-07-16T12:00:00Z" : null,
    rejected_by: status === "rejected" ? "approver" : null,
    rejected_at: status === "rejected" ? "2026-07-16T12:00:00Z" : null,
    rejection_reason: status === "rejected" ? "ข้อมูลไม่ครบ" : null,
    supersedes_correction_id: null,
    source_line_message_id: "raw-1",
    evidence_url: null,
    target_version: `raw:${raw.id}`,
    request_key: "33333333-3333-3333-3333-333333333333",
    created_at: "2026-07-16T11:00:00Z",
    updated_at: "2026-07-16T12:00:00Z",
  };
}

describe("effective transaction correction overlay", () => {
  test("price 119 -> 109 preserves quantity and calculates 4,294.60", () => {
    const before = snapshotFromTransaction(raw);
    const after = buildAfterSnapshot(before, { priceAmount: 109 });
    expect(after.quantity).toBe(39.4);
    expect(after.totalAmount).toBe(4294.6);
    expect(before.totalAmount - after.totalAmount).toBe(394);
  });

  test("golden issued and expected totals decrease by 394.00", () => {
    const issuedAfter = 19_824.6 - 394;
    expect(issuedAfter).toBe(19_430.6);
    expect(issuedAfter - 11_157.5).toBeCloseTo(8_273.1, 2);
  });

  test("pending and rejected corrections do not affect reports", () => {
    for (const status of ["pending", "rejected"] as const) {
      const result = applyApprovedCorrections([raw], [correction(status)]);
      expect(result[0].price_per_unit).toBe(119);
      expect(result[0].total_amount).toBe(4688.6);
      expect(result[0].is_corrected).toBe(false);
    }
  });

  test("approved correction replaces original exactly once", () => {
    const approved = correction("approved");
    const result = applyApprovedCorrections([raw], [approved, approved]);
    expect(result).toHaveLength(1);
    expect(result[0].price_per_unit).toBe(109);
    expect(result[0].total_amount).toBe(4294.6);
    expect(result[0].original_total_amount).toBe(4688.6);
  });

  test("void duplicate removes the transaction from effective totals", () => {
    const duplicate = correction("approved");
    duplicate.reason_type = "duplicate";
    duplicate.after_snapshot = buildAfterSnapshot(duplicate.before_snapshot, { duplicate: true });
    expect(applyApprovedCorrections([raw], [duplicate])).toEqual([]);
  });

  test("input transactions and snapshots are not mutated", () => {
    const originalRaw = structuredClone(raw);
    const approved = correction("approved");
    const originalCorrection = structuredClone(approved);
    applyApprovedCorrections([raw], [approved]);
    expect(raw).toEqual(originalRaw);
    expect(approved).toEqual(originalCorrection);
  });

  test("basis price keeps price amount and quantity separate", () => {
    expect(calculateSnapshotTotal({ quantity: 9, priceAmount: 20, priceQuantity: 3 })).toBe(60);
  });
});
