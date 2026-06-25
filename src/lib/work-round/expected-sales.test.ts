import { describe, expect, it } from "bun:test";
import { computeRoundTotals } from "./expected-sales";
import { memSupabase } from "@/lib/test-utils/mem-supabase";

function seed(items: Array<{ q: number; p: number; t: string }>) {
  return memSupabase({
    produce_sessions: [{ id: "s1", work_round_id: "wr-1" }],
    produce_items: items.map((it, i) => ({
      id: `i${i}`, session_id: "s1", quantity: it.q, price_per_unit: it.p, transaction_type: it.t,
    })),
  });
}

describe("computeRoundTotals", () => {
  it("computes expected = borrow - return - badReturn", async () => {
    const db = seed([
      { q: 10, p: 100, t: "เบิก" },   // 1000 borrow
      { q: 2,  p: 100, t: "คืน" },    // 200 return
      { q: 1,  p: 100, t: "คืนเสีย" }, // 100 bad
    ]);
    const r = await computeRoundTotals(db as never, "wr-1");
    expect(r.borrow).toBe(1000);
    expect(r.ret).toBe(200);
    expect(r.badReturn).toBe(100);
    expect(r.expected).toBe(700);
  });

  it("counts ชั่งคืนเพิ่ม (append return) toward the return bucket", async () => {
    const db = seed([
      { q: 10, p: 100, t: "เบิก" },        // 1000 borrow
      { q: 3,  p: 100, t: "ชั่งคืนเพิ่ม" }, // 300 return
    ]);
    const r = await computeRoundTotals(db as never, "wr-1");
    expect(r.ret).toBe(300);
    expect(r.expected).toBe(700);
  });

  it("counts เบิกเพิ่ม toward borrow", async () => {
    const db = seed([
      { q: 10, p: 100, t: "เบิก" },
      { q: 5,  p: 100, t: "เบิกเพิ่ม" },
    ]);
    const r = await computeRoundTotals(db as never, "wr-1");
    expect(r.borrow).toBe(1500);
    expect(r.expected).toBe(1500);
  });

  it("returns zeros when the round has no sessions", async () => {
    const db = memSupabase({ produce_sessions: [], produce_items: [] });
    const r = await computeRoundTotals(db as never, "wr-x");
    expect(r.expected).toBe(0);
  });
});
