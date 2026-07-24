import { describe, expect, test } from "bun:test";
import {
  applyGlobalDuplicateExclusions,
  buildBatchSummaryMessage,
  type EvidenceWithCheck,
} from "./batch-finalizer";

function evidence(
  overrides: Partial<EvidenceWithCheck> = {},
): EvidenceWithCheck {
  return {
    id: "evidence-current",
    checkId: "check-current",
    batchIndex: 1,
    checkStatus: "EXTRACTED",
    slipType: "BANK_SLIP_QR",
    transferAmount: 500,
    paidAmount: null,
    transactionTime: null,
    referenceId: "REF-001",
    failureReason: null,
    ...overrides,
  };
}

describe("batch finalizer global slip dedupe", () => {
  test("keeps the original authoritative and excludes a later global duplicate", async () => {
    const db = {
      from(table: string) {
        if (table !== "slip_checks") throw new Error(`unexpected table: ${table}`);
        const builder = {
          select: () => builder,
          in: () => builder,
          order: () => builder,
          then: (resolve: (value: unknown) => void) => resolve({
            data: [
              {
                id: "check-original",
                reference_id: "REF-001",
                created_at: "2026-07-23T00:00:00Z",
              },
              {
                id: "check-current",
                reference_id: "REF-001",
                created_at: "2026-07-23T00:01:00Z",
              },
            ],
            error: null,
          }),
        };
        return {
          select: builder.select,
        };
      },
    };

    const marked = await applyGlobalDuplicateExclusions(
      db as never,
      [
        evidence({ id: "original", checkId: "check-original", batchIndex: 1 }),
        evidence({ id: "duplicate", checkId: "check-current", batchIndex: 2 }),
        evidence({
          id: "missing-reference",
          checkId: "check-no-reference",
          batchIndex: 3,
          referenceId: null,
          transferAmount: 100,
        }),
      ],
    );

    expect(marked[0].globallyDuplicate).toBe(false);
    expect(marked[1].globallyDuplicate).toBe(true);
    expect(marked[2].globallyDuplicate).toBe(false);

    const message = buildBatchSummaryMessage(marked);
    expect(message).toContain("อ่านครบ: 2 รูป");
    expect(message).toMatch(/600(?:[,.]0+)? บาท/);
    expect(message).toContain("สลิปซ้ำ");
    expect(message).not.toContain("REF-001");
  });
});
