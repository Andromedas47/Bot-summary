import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlipBatchService } from "./batch-service";
import { buildBatchSummaryMessage } from "./batch-finalizer";
import type { Database } from "@/types/database";

// ── RPC fake helpers ────────────────────────────────────────────────────────

type RpcResponse = { data: unknown; error: { message: string } | null };

function makeRpcSupabase(
  handler: (fn: string, args: unknown) => RpcResponse,
) {
  const calls: Array<{ fn: string; args: unknown }> = [];

  const client = {
    async rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return handler(fn, args);
    },
    _calls: calls,
  };

  return client as unknown as SupabaseClient<Database> & {
    _calls: Array<{ fn: string; args: unknown }>;
  };
}

function batchRow(batchId: string, isNew: boolean) {
  return [{ batch_id: batchId, is_new_batch: isNew }];
}

// ── SlipBatchService.getOrCreateBatch ──────────────────────────────────────

describe("SlipBatchService.getOrCreateBatch", () => {
  it("creates a new batch when the RPC returns is_new_batch=true", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: batchRow("batch-new", true),
      error: null,
    }));
    const service = new SlipBatchService(supabase);

    const result = await service.getOrCreateBatch("group-1", "group", "user-1");

    expect(result.isNewBatch).toBe(true);
    expect(result.batchId).toBe("batch-new");
  });

  it("returns existing batch when the RPC returns is_new_batch=false", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: batchRow("batch-existing", false),
      error: null,
    }));
    const service = new SlipBatchService(supabase);

    const result = await service.getOrCreateBatch("group-1", "group", "user-1");

    expect(result.isNewBatch).toBe(false);
    expect(result.batchId).toBe("batch-existing");
  });

  it("passes all arguments to the RPC", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: batchRow("batch-x", true),
      error: null,
    }));
    const service = new SlipBatchService(supabase);

    await service.getOrCreateBatch("src-abc", "group", "user-xyz");

    expect(supabase._calls[0]).toMatchObject({
      fn: "get_or_create_slip_batch",
      args: {
        p_source_id:   "src-abc",
        p_source_type: "group",
        p_sender_id:   "user-xyz",
        p_quiet_seconds: 20,
      },
    });
  });

  it("passes null sender_id through to the RPC (room / anonymous)", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: batchRow("batch-room", true),
      error: null,
    }));
    const service = new SlipBatchService(supabase);

    const result = await service.getOrCreateBatch("room-1", "room", null);

    expect(supabase._calls[0]).toMatchObject({
      fn: "get_or_create_slip_batch",
      args: { p_sender_id: null },
    });
    expect(result.isNewBatch).toBe(true);
  });

  it("throws when the RPC returns an error", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: null,
      error: { message: "db unavailable" },
    }));
    const service = new SlipBatchService(supabase);

    await expect(
      service.getOrCreateBatch("group-1", "group", "user-1"),
    ).rejects.toThrow("get_or_create_slip_batch failed");
  });

  it("throws when the RPC returns an empty array", async () => {
    const supabase = makeRpcSupabase(() => ({ data: [], error: null }));
    const service = new SlipBatchService(supabase);

    await expect(
      service.getOrCreateBatch("group-1", "group", "user-1"),
    ).rejects.toThrow("returned no row");
  });

  // Simulates what the DB-level advisory lock guarantees:
  // two concurrent TS calls for the same source/sender will get serialized
  // by the RPC so only one sees is_new_batch=true.
  it("concurrent calls receive at most one isNewBatch=true (DB lock simulation)", async () => {
    let callIndex = 0;
    const supabase = makeRpcSupabase(() => {
      callIndex += 1;
      // First call: batch created. Second call: existing batch found.
      return { data: batchRow("batch-shared", callIndex === 1), error: null };
    });
    const service = new SlipBatchService(supabase);

    const [r1, r2] = await Promise.all([
      service.getOrCreateBatch("group-1", "group", "user-1"),
      service.getOrCreateBatch("group-1", "group", "user-1"),
    ]);

    const ackCount = [r1, r2].filter((r) => r.isNewBatch).length;
    expect(ackCount).toBe(1);
    expect(r1.batchId).toBe("batch-shared");
    expect(r2.batchId).toBe("batch-shared");
  });
});

// ── SlipBatchService.attachEvidence ────────────────────────────────────────

describe("SlipBatchService.attachEvidence", () => {
  it("calls attach_evidence_to_slip_batch RPC with correct arguments", async () => {
    const supabase = makeRpcSupabase(() => ({ data: 1, error: null }));
    const service = new SlipBatchService(supabase);

    await service.attachEvidence("batch-1", "evidence-1");

    expect(supabase._calls).toEqual([{
      fn: "attach_evidence_to_slip_batch",
      args: { p_batch_id: "batch-1", p_evidence_id: "evidence-1" },
    }]);
  });

  it("throws when the RPC returns an error", async () => {
    const supabase = makeRpcSupabase(() => ({
      data: null,
      error: { message: "batch not found" },
    }));
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
