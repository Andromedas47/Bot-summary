import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlipBatchService } from "./batch-service";
import { buildBatchSummaryMessage } from "./batch-finalizer";
import type { Database } from "@/types/database";

// ── SlipBatchService ────────────────────────────────────────────────────────

function makeChain(finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["eq", "neq", "gte", "lte", "is", "order", "limit", "in"];
  for (const m of methods) {
    chain[m] = () => chain;
  }
  chain["maybeSingle"] = async () => ({ data: finalValue, error: null });
  chain["single"]      = async () => ({ data: finalValue, error: null });
  return chain;
}

function makeSupabase(options: {
  findResult?: { id: string } | null;
  newBatchId?: string;
  rpcError?: string;
}) {
  const { findResult = null, newBatchId = "batch-new", rpcError } = options;
  const inserts: unknown[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  const client = {
    from(table: string) {
      if (table === "slip_batches") {
        return {
          select: () => makeChain(findResult),
          insert(row: unknown) {
            inserts.push(row);
            return {
              select: () => ({ single: async () => ({ data: { id: newBatchId }, error: null }) }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return { data: 1, error: rpcError ? { message: rpcError } : null };
    },
    _inserts: inserts,
    _rpcCalls: rpcCalls,
  };

  return client as unknown as SupabaseClient<Database> & {
    _inserts: unknown[];
    _rpcCalls: Array<{ fn: string; args: unknown }>;
  };
}

describe("SlipBatchService.getOrCreateBatch", () => {
  it("creates a new batch and returns isNewBatch=true when no active batch exists", async () => {
    const supabase = makeSupabase({ findResult: null, newBatchId: "batch-created" });
    const service = new SlipBatchService(supabase);

    const result = await service.getOrCreateBatch("group-1", "group", "user-1");

    expect(result.isNewBatch).toBe(true);
    expect(result.batchId).toBe("batch-created");
    expect(supabase._inserts).toHaveLength(1);
  });

  it("returns existing batch and isNewBatch=false when active batch exists within quiet window", async () => {
    const supabase = makeSupabase({ findResult: { id: "batch-existing" } });
    const service = new SlipBatchService(supabase);

    const result = await service.getOrCreateBatch("group-1", "group", "user-1");

    expect(result.isNewBatch).toBe(false);
    expect(result.batchId).toBe("batch-existing");
    expect(supabase._inserts).toHaveLength(0);
  });
});

describe("SlipBatchService.attachEvidence", () => {
  it("calls the attach_evidence_to_slip_batch RPC with correct arguments", async () => {
    const supabase = makeSupabase({});
    const service = new SlipBatchService(supabase);

    await service.attachEvidence("batch-1", "evidence-1");

    expect(supabase._rpcCalls).toEqual([{
      fn: "attach_evidence_to_slip_batch",
      args: { p_batch_id: "batch-1", p_evidence_id: "evidence-1" },
    }]);
  });

  it("throws when the RPC returns an error", async () => {
    const supabase = makeSupabase({ rpcError: "batch not found" });
    const service = new SlipBatchService(supabase);

    await expect(service.attachEvidence("batch-x", "ev-x")).rejects.toThrow(
      "Failed to attach evidence to batch",
    );
  });
});

// ── buildBatchSummaryMessage ────────────────────────────────────────────────

describe("buildBatchSummaryMessage", () => {
  it("returns all-failed message when every slip needs review", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "NEED_REVIEW",  transferAmount: null, paidAmount: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "FAILED",       transferAmount: null, paidAmount: null, failureReason: null },
    ]);
    expect(msg).toBe(
      "รับรูปหลักฐานแล้วทั้งหมด 2 รูป แต่ระบบอ่านข้อมูลไม่ครบ กรุณาให้แอดมินตรวจมือ",
    );
  });

  it("includes totals and review list for partial success", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED",   transferAmount: 1000, paidAmount: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "NEED_REVIEW", transferAmount: null, paidAmount: null, failureReason: null },
      { id: "e3", batchIndex: 3, checkStatus: "EXTRACTED",   transferAmount: 500,  paidAmount: null, failureReason: null },
    ]);
    expect(msg).toContain("สรุปรูปหลักฐานรอบนี้");
    expect(msg).toContain("รับทั้งหมด: 3 รูป");
    expect(msg).toContain("อ่านครบ: 2 รูป");
    expect(msg).toContain("รอตรวจมือ: 1 รูป");
    expect(msg).toContain("1,500");
    expect(msg).toContain("#2 ไม่พบข้อมูลครบถ้วน");
  });

  it("includes paid_amount fallback when transfer_amount is null", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED", transferAmount: null, paidAmount: 800, failureReason: null },
    ]);
    expect(msg).toContain("800");
  });

  it("omits amount line when total is zero", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED", transferAmount: null, paidAmount: null, failureReason: null },
    ]);
    expect(msg).not.toContain("ยอดรวม");
  });

  it("all successful — no review section", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED",         transferAmount: 300, paidAmount: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "PARTIAL_EXTRACTED", transferAmount: 200, paidAmount: null, failureReason: null },
    ]);
    expect(msg).toContain("รอตรวจมือ: 0 รูป");
    expect(msg).not.toContain("รูปที่ต้องตรวจมือ");
  });

  it("returns empty string for empty evidence list", () => {
    expect(buildBatchSummaryMessage([])).toBe("");
  });

  it("shows FAILED reason for known failure codes", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED", transferAmount: 100, paidAmount: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "FAILED",    transferAmount: null, paidAmount: null, failureReason: "evidence_download_failed" },
    ]);
    expect(msg).toContain("#2 ดาวน์โหลดรูปไม่สำเร็จ");
  });

  it("treats PROCESSING status as needing manual review", () => {
    const msg = buildBatchSummaryMessage([
      { id: "e1", batchIndex: 1, checkStatus: "EXTRACTED",  transferAmount: 500, paidAmount: null, failureReason: null },
      { id: "e2", batchIndex: 2, checkStatus: "PROCESSING", transferAmount: null, paidAmount: null, failureReason: null },
    ]);
    expect(msg).toContain("#2 ยังไม่ได้ตรวจสอบ");
  });
});
