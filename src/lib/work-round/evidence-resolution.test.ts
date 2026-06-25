import { describe, expect, it } from "bun:test";
import { WorkRoundService } from "./work-round-service";
import { memSupabase } from "@/lib/test-utils/mem-supabase";

function round(over: Record<string, unknown> = {}) {
  return {
    id: "wr-1", source_id: "G1", business_date: "2026-06-24",
    seller_name: "กี้", market_name: "วัดทุ่ง", round_seq: 1, status: "open",
    source_meta: null, created_at: "", updated_at: "", ...over,
  };
}

describe("WorkRoundService.resolveForEvidence", () => {
  it("returns legacy when no rounds exist for the date", async () => {
    const db  = memSupabase({ work_rounds: [] });
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveForEvidence("G1", "2026-06-24");
    expect(res.mode).toBe("legacy");
  });

  it("links when exactly one eligible round exists", async () => {
    const db  = memSupabase({ work_rounds: [round()] });
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveForEvidence("G1", "2026-06-24");
    expect(res.mode).toBe("linked");
    if (res.mode === "linked") expect(res.workRound.id).toBe("wr-1");
  });

  it("requires selection when multiple eligible rounds exist", async () => {
    const db  = memSupabase({ work_rounds: [round(), round({ id: "wr-2", seller_name: "พี่ดำ", market_name: "วิหาร" })] });
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveForEvidence("G1", "2026-06-24");
    expect(res.mode).toBe("select");
    if (res.mode === "select") expect(res.candidates).toHaveLength(2);
  });

  it("prefers a unique seller+market match among multiple eligible rounds", async () => {
    const db  = memSupabase({ work_rounds: [
      round(),
      round({ id: "wr-2", seller_name: "พี่ดำ", market_name: "วิหาร" }),
    ] });
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveForEvidence("G1", "2026-06-24", { sellerName: "พี่ดำ", marketName: "วิหาร" });
    expect(res.mode).toBe("linked");
    if (res.mode === "linked") expect(res.workRound.id).toBe("wr-2");
  });

  it("blocks when rounds exist for the date but none are eligible", async () => {
    const db  = memSupabase({ work_rounds: [round({ status: "approved" })] });
    const svc = new WorkRoundService(db as never);
    const res = await svc.resolveForEvidence("G1", "2026-06-24");
    expect(res.mode).toBe("blocked");
  });

  it("validateChoice rejects a round from a different source/date", async () => {
    const db  = memSupabase({ work_rounds: [round()] });
    const svc = new WorkRoundService(db as never);
    const ok  = await svc.validateChoice("wr-1", "G1", "2026-06-24", ["open"]);
    expect(ok?.id).toBe("wr-1");
    expect(await svc.validateChoice("wr-1", "G-other", "2026-06-24", ["open"])).toBeNull();
    expect(await svc.validateChoice("wr-1", "G1", "2026-06-25", ["open"])).toBeNull();
    expect(await svc.validateChoice("wr-1", "G1", "2026-06-24", ["approved"])).toBeNull();
  });
});
