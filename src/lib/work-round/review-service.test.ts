import { describe, expect, it } from "bun:test";
import { memSupabase } from "@/lib/test-utils/mem-supabase";
import { reviewWorkRound } from "./review-service";

const roundBase = {
  id: "wr-a",
  source_id: "group-1",
  business_date: "2026-06-24",
  seller_name: "กี้",
  market_name: "วัดทุ่ง",
  round_seq: 1,
  source_meta: null,
  created_at: "2026-06-24T00:00:00.000Z",
  updated_at: "2026-06-24T00:00:00.000Z",
};

describe("reviewWorkRound", () => {
  it("marks a reviewable round as needs_correction without finalizing", async () => {
    const db = memSupabase({
      work_rounds: [{ ...roundBase, status: "ready_for_review" }],
      settlement_drafts: [{ id: "draft-a", work_round_id: "wr-a", status: "ready_for_review", version: 1 }],
    });

    const result = await reviewWorkRound(db as never, {
      workRoundId: "wr-a",
      action: "needs_correction",
      actor: "reviewer@example.com",
      reason: "ยอดใบขาวไม่ตรง",
    });

    expect(result.ok).toBe(true);
    expect(db._rows("work_rounds")[0].status).toBe("needs_correction");
    expect(db._rows("settlement_drafts")[0].status).toBe("needs_correction");
    expect(db._rows("settlement_finalizations")).toHaveLength(0);
    expect(db._rows("settlement_draft_history")[0].change_type).toBe("review_needs_correction");
  });

  it("rejects approval while evidence is still open", async () => {
    const db = memSupabase({
      work_rounds: [{ ...roundBase, status: "ready_for_review" }],
      settlement_drafts: [{ id: "draft-a", work_round_id: "wr-a", status: "ready_for_review", version: 1 }],
      manual_slip_sessions: [{ id: "manual-a", work_round_id: "wr-a", status: "open" }],
    });

    const result = await reviewWorkRound(db as never, {
      workRoundId: "wr-a",
      action: "approve",
      actor: "reviewer@example.com",
      push: async () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(db._rows("work_rounds")[0].status).toBe("ready_for_review");
  });

  it("approves a ready round and creates one finalization record", async () => {
    const db = memSupabase({
      work_rounds: [{ ...roundBase, status: "ready_for_review" }],
      settlement_drafts: [{
        id: "draft-a",
        work_round_id: "wr-a",
        status: "ready_for_review",
        version: 1,
        declared_transfer: 700,
        declared_cash: 300,
        declared_expenses: 0,
        declared_labor: 0,
        notes: null,
      }],
      produce_sessions: [{ id: "session-a", work_round_id: "wr-a" }],
      produce_items: [
        { id: "item-a1", session_id: "session-a", transaction_type: "เบิก", quantity: 10, price_per_unit: 100 },
        { id: "item-a2", session_id: "session-a", transaction_type: "ชั่งคืนเพิ่ม", quantity: 3, price_per_unit: 100 },
      ],
      slip_batches: [{ id: "batch-a", work_round_id: "wr-a", status: "completed" }],
      slip_evidences: [{ id: "evidence-a", batch_id: "batch-a", work_round_id: "wr-a" }],
      slip_checks: [{ id: "check-a", evidence_id: "evidence-a", status: "EXTRACTED", slip_type: "BANK_SLIP_QR", transfer_amount: 700 }],
    });

    const result = await reviewWorkRound(db as never, {
      workRoundId: "wr-a",
      action: "approve",
      actor: "reviewer@example.com",
      push: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(db._rows("work_rounds")[0].status).toBe("approved");
    expect(db._rows("settlement_drafts")[0].status).toBe("approved");
    expect(db._rows("settlement_drafts")[0].approved_by).toBe("reviewer@example.com");
    expect(db._rows("settlement_finalizations")).toHaveLength(1);

    const retry = await reviewWorkRound(db as never, {
      workRoundId: "wr-a",
      action: "approve",
      actor: "reviewer@example.com",
      push: async () => undefined,
    });
    expect(retry.ok).toBe(true);
    expect(db._rows("settlement_finalizations")).toHaveLength(1);
  });
});
