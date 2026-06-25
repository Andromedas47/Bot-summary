import { describe, expect, it } from "bun:test";
import { nextStatus, WorkRoundStatusService } from "./status";
import { memSupabase } from "@/lib/test-utils/mem-supabase";

describe("nextStatus", () => {
  it("produce_attached keeps an open round open (no-op)", () => {
    expect(nextStatus("open", "produce_attached")).toBeNull();
  });

  it("produce_attached reverts a later status back to open", () => {
    expect(nextStatus("awaiting_settlement", "produce_attached")).toBe("open");
  });

  it("produce_attached does not revert an approved round", () => {
    expect(nextStatus("approved", "produce_attached")).toBeNull();
  });

  it("produce_closed: open → produce_complete", () => {
    expect(nextStatus("open", "produce_closed")).toBe("produce_complete");
  });

  it("settlement_opened: open → awaiting_settlement", () => {
    expect(nextStatus("open", "settlement_opened")).toBe("awaiting_settlement");
  });

  it("settlement_confirmed: awaiting_settlement → awaiting_slips", () => {
    expect(nextStatus("awaiting_settlement", "settlement_confirmed")).toBe("awaiting_slips");
  });

  it("reconciled_match: awaiting_slips → ready_for_review", () => {
    expect(nextStatus("awaiting_slips", "reconciled_match")).toBe("ready_for_review");
  });

  it("reconciled_variance: awaiting_slips → variance_found", () => {
    expect(nextStatus("awaiting_slips", "reconciled_variance")).toBe("variance_found");
  });

  it("variance can recover to ready_for_review on a later match", () => {
    expect(nextStatus("variance_found", "reconciled_match")).toBe("ready_for_review");
  });

  it("approved: ready_for_review → approved", () => {
    expect(nextStatus("ready_for_review", "approved")).toBe("approved");
  });

  it("approved: variance_found → approved", () => {
    expect(nextStatus("variance_found", "approved")).toBe("approved");
  });

  it("needs_correction can be flagged from ready_for_review", () => {
    expect(nextStatus("ready_for_review", "needs_correction")).toBe("needs_correction");
  });

  it("needs_correction cannot be flagged on an approved round", () => {
    expect(nextStatus("approved", "needs_correction")).toBeNull();
  });

  it("settlement_confirmed does not apply from open (no-op)", () => {
    expect(nextStatus("open", "settlement_confirmed")).toBeNull();
  });

  it("approved does not apply from open (no-op)", () => {
    expect(nextStatus("open", "approved")).toBeNull();
  });
});

describe("WorkRoundStatusService.applyEvent", () => {
  it("updates the row when the transition applies", async () => {
    const db  = memSupabase({ work_rounds: [{ id: "wr-1", status: "awaiting_settlement" }] });
    const svc = new WorkRoundStatusService(db as never);
    const res = await svc.applyEvent("wr-1", "settlement_confirmed");
    expect(res).toBe("awaiting_slips");
    expect(db._rows("work_rounds")[0].status).toBe("awaiting_slips");
  });

  it("is a no-op when the transition does not apply", async () => {
    const db  = memSupabase({ work_rounds: [{ id: "wr-1", status: "open" }] });
    const svc = new WorkRoundStatusService(db as never);
    const res = await svc.applyEvent("wr-1", "approved");
    expect(res).toBeNull();
    expect(db._rows("work_rounds")[0].status).toBe("open");
  });

  it("tolerates a missing round", async () => {
    const db  = memSupabase({ work_rounds: [] });
    const svc = new WorkRoundStatusService(db as never);
    expect(await svc.applyEvent("nope", "approved")).toBeNull();
  });
});
