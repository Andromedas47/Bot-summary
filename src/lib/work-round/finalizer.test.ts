import { describe, expect, it } from "bun:test";
import { memSupabase } from "@/lib/test-utils/mem-supabase";
import { tryFinalizeWorkRound } from "./finalizer";

const roundBase = {
  source_id: "group-1",
  business_date: "2026-06-24",
  round_seq: 1,
  source_meta: null,
  created_at: "2026-06-24T00:00:00.000Z",
  updated_at: "2026-06-24T00:00:00.000Z",
};

describe("tryFinalizeWorkRound", () => {
  it("reconciles only the selected work round and waits for approval before notifying", async () => {
    const db = memSupabase({
      work_rounds: [
        { ...roundBase, id: "wr-a", seller_name: "กี้", market_name: "วัดทุ่ง", status: "awaiting_slips" },
        { ...roundBase, id: "wr-b", seller_name: "พี่ดำ", market_name: "วิหาร", status: "awaiting_slips" },
      ],
      settlement_drafts: [
        {
          id: "draft-a",
          work_round_id: "wr-a",
          status: "submitted",
          version: 1,
          declared_transfer: 700,
          declared_cash: 300,
          declared_expenses: 0,
          declared_labor: 0,
          notes: null,
        },
      ],
      produce_sessions: [
        { id: "session-a", work_round_id: "wr-a" },
        { id: "session-b", work_round_id: "wr-b" },
      ],
      produce_items: [
        { id: "item-a1", session_id: "session-a", transaction_type: "เบิก", quantity: 10, price_per_unit: 100 },
        { id: "item-a2", session_id: "session-a", transaction_type: "ชั่งคืนเพิ่ม", quantity: 3, price_per_unit: 100 },
        { id: "item-b1", session_id: "session-b", transaction_type: "เบิก", quantity: 999, price_per_unit: 999 },
      ],
      slip_batches: [
        { id: "batch-a", work_round_id: "wr-a", status: "completed" },
        { id: "batch-b", work_round_id: "wr-b", status: "completed" },
      ],
      slip_evidences: [
        { id: "evidence-a", batch_id: "batch-a", work_round_id: "wr-a" },
        { id: "evidence-b", batch_id: "batch-b", work_round_id: "wr-b" },
      ],
      slip_checks: [
        { id: "check-a", evidence_id: "evidence-a", status: "EXTRACTED", slip_type: "TRANSFER", transfer_amount: 700 },
        { id: "check-b", evidence_id: "evidence-b", status: "EXTRACTED", slip_type: "TRANSFER", transfer_amount: 999999 },
      ],
    });
    const pushes: Array<{ to: string; text: string; retryKey?: string }> = [];

    const result = await tryFinalizeWorkRound(db as never, "wr-a", async (to, text, retryKey) => {
      pushes.push({ to, text, retryKey });
    });

    expect(result).toBe("review_pending");
    expect(pushes).toHaveLength(0);

    const reconciliations = db._rows("transfer_reconciliations");
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0].work_round_id).toBe("wr-a");
    expect(reconciliations[0].ai_verified_total).toBe(700);
    expect(reconciliations[0].submitted_transfer_total).toBe(700);
    expect(reconciliations[0].matched).toBe(true);

    const finalizations = db._rows("settlement_finalizations");
    expect(finalizations).toHaveLength(0);

    expect(db._rows("work_rounds").find((r) => r.id === "wr-a")?.status).toBe("ready_for_review");
    expect(db._rows("work_rounds").find((r) => r.id === "wr-b")?.status).toBe("awaiting_slips");
    expect(db._rows("settlement_drafts")[0].status).toBe("ready_for_review");
  });

  it("approved round sends exactly one final summary with a work-round retry key", async () => {
    const db = memSupabase({
      work_rounds: [
        { ...roundBase, id: "wr-a", seller_name: "กี้", market_name: "วัดทุ่ง", status: "approved" },
      ],
      settlement_drafts: [
        {
          id: "draft-a",
          work_round_id: "wr-a",
          status: "approved",
          version: 1,
          declared_transfer: 700,
          declared_cash: 300,
          declared_expenses: 0,
          declared_labor: 0,
          notes: null,
        },
      ],
      produce_sessions: [{ id: "session-a", work_round_id: "wr-a" }],
      produce_items: [
        { id: "item-a1", session_id: "session-a", transaction_type: "เบิก", quantity: 10, price_per_unit: 100 },
        { id: "item-a2", session_id: "session-a", transaction_type: "ชั่งคืนเพิ่ม", quantity: 3, price_per_unit: 100 },
      ],
      slip_batches: [{ id: "batch-a", work_round_id: "wr-a", status: "completed" }],
      slip_evidences: [{ id: "evidence-a", batch_id: "batch-a", work_round_id: "wr-a" }],
      slip_checks: [{ id: "check-a", evidence_id: "evidence-a", status: "EXTRACTED", slip_type: "BANK_SLIP_QR", transfer_amount: 700 }],
    });
    const pushes: Array<{ to: string; text: string; retryKey?: string }> = [];

    const first = await tryFinalizeWorkRound(db as never, "wr-a", async (to, text, retryKey) => {
      pushes.push({ to, text, retryKey });
    });
    const second = await tryFinalizeWorkRound(db as never, "wr-a", async (to, text, retryKey) => {
      pushes.push({ to, text, retryKey });
    });

    expect(first).toBe("finalized");
    expect(second).toBe("already_done");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].to).toBe("group-1");
    expect(pushes[0].text).toContain("กี้");
    expect(db._rows("settlement_finalizations")).toHaveLength(1);
    expect(db._rows("settlement_finalizations")[0].work_round_id).toBe("wr-a");
  });

  it("does not finalize while V2 evidence is still open", async () => {
    const db = memSupabase({
      work_rounds: [
        { ...roundBase, id: "wr-a", seller_name: "กี้", market_name: "วัดทุ่ง", status: "awaiting_slips" },
      ],
      settlement_drafts: [
        { id: "draft-a", work_round_id: "wr-a", status: "submitted", version: 1, declared_transfer: 700 },
      ],
      manual_slip_sessions: [
        { id: "manual-a", work_round_id: "wr-a", status: "open" },
      ],
    });
    const pushes: unknown[] = [];

    const result = await tryFinalizeWorkRound(db as never, "wr-a", async (...args) => {
      pushes.push(args);
    });

    expect(result).toBe("not_ready");
    expect(pushes).toHaveLength(0);
    expect(db._rows("transfer_reconciliations")).toHaveLength(0);
    expect(db._rows("settlement_finalizations")).toHaveLength(0);
  });
});
