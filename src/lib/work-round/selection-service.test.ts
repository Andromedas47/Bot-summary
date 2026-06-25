import { describe, expect, it } from "bun:test";
import {
  WorkRoundSelectionService,
  parseNumericSelection,
  buildSelectionMessage,
} from "./selection-service";
import { memSupabase } from "@/lib/test-utils/mem-supabase";
import type { SelectionCandidate } from "./types";

const cands: SelectionCandidate[] = [
  { work_round_id: "wr-1", seller_name: "กี้",   market_name: "วัดทุ่ง", round_seq: 1, expected_sales: 1000 },
  { work_round_id: "wr-2", seller_name: "พี่ดำ", market_name: "วิหาร",  round_seq: 1, expected_sales: 2000 },
];

describe("parseNumericSelection", () => {
  it("parses a bare number", () => {
    expect(parseNumericSelection("1")).toBe(1);
    expect(parseNumericSelection(" 2 ")).toBe(2);
  });
  it("rejects non-numeric or zero", () => {
    expect(parseNumericSelection("โอน 730")).toBeNull();
    expect(parseNumericSelection("0")).toBeNull();
    expect(parseNumericSelection("1. 100 บาท")).toBeNull();
  });
});

describe("buildSelectionMessage", () => {
  it("includes seller, market, and expected sales", () => {
    const msg = buildSelectionMessage("settlement", cands);
    expect(msg).toContain("1. กี้ — วัดทุ่ง");
    expect(msg).toContain("ยอดส่ง 1,000");
    expect(msg).toContain("2. พี่ดำ — วิหาร");
  });
});

describe("WorkRoundSelectionService", () => {
  it("creates a pending selection and finds it for the same sender", async () => {
    const db  = memSupabase();
    const svc = new WorkRoundSelectionService(db as never);
    await svc.create({
      sourceId: "G1", lineUserId: "U1", businessDate: "2026-06-24",
      intent: "settlement", candidates: cands,
    });
    const active = await svc.findActive("G1", "U1");
    expect(active?.intent).toBe("settlement");
    expect(active?.candidates).toHaveLength(2);
  });

  it("does NOT return a selection for a different sender in the same group", async () => {
    const db  = memSupabase();
    const svc = new WorkRoundSelectionService(db as never);
    await svc.create({
      sourceId: "G1", lineUserId: "U1", businessDate: "2026-06-24",
      intent: "settlement", candidates: cands,
    });
    expect(await svc.findActive("G1", "U2")).toBeNull();
  });

  it("creating a new selection expires the prior pending one for that sender", async () => {
    const db  = memSupabase();
    const svc = new WorkRoundSelectionService(db as never);
    await svc.create({ sourceId: "G1", lineUserId: "U1", businessDate: "2026-06-24", intent: "settlement", candidates: cands });
    await svc.create({ sourceId: "G1", lineUserId: "U1", businessDate: "2026-06-24", intent: "slip",       candidates: cands });

    const rows = db._rows("work_round_selections");
    const pending = rows.filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].intent).toBe("slip");
  });

  it("treats an expired selection as inactive", async () => {
    const db  = memSupabase();
    const svc = new WorkRoundSelectionService(db as never);
    await svc.create({
      sourceId: "G1", lineUserId: "U1", businessDate: "2026-06-24",
      intent: "settlement", candidates: cands, ttlMs: -1000, // already expired
    });
    expect(await svc.findActive("G1", "U1")).toBeNull();
    // It was lazily flipped to expired.
    expect(db._rows("work_round_selections")[0].status).toBe("expired");
  });

  it("resolve marks the selection resolved with the chosen round", async () => {
    const db  = memSupabase();
    const svc = new WorkRoundSelectionService(db as never);
    const sel = await svc.create({
      sourceId: "G1", lineUserId: "U1", businessDate: "2026-06-24",
      intent: "settlement", candidates: cands,
    });
    await svc.resolve(sel.id, "wr-2");
    const row = db._rows("work_round_selections")[0];
    expect(row.status).toBe("resolved");
    expect(row.resolved_work_round_id).toBe("wr-2");
  });
});
