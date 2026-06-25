/**
 * Integration tests: slip & manual-slip evidence attach to the right Work Round.
 * Uses the in-memory Supabase double with the real Slip/ManualSlip services.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";

let seq = 0;
function textEvent(text: string, userId = "user-1"): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    source: { type: "group", groupId: "group-1", userId },
    mode: "active",
    message: { id: `msg-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function round(over: Record<string, unknown> = {}): Row {
  return {
    id: "wr-1", source_id: "group-1", business_date: "2026-06-24",
    seller_name: "กี้", market_name: "วัดทุ่ง", round_seq: 1, status: "open",
    source_meta: null, created_at: "", updated_at: "", ...over,
  };
}

const svc = (db: ReturnType<typeof memSupabase>) =>
  new WebhookService(db as never, { produceEndSettleMs: 0 });

describe("slip session evidence → Work Round", () => {
  it("links the slip batch to the single eligible round", async () => {
    const db = memSupabase({ work_rounds: [round()] });
    await svc(db).processEvents([textEvent("กี้ วัดทุ่ง สลิปเงินโอน 24/06/2569")], "dest");

    const batches = db._rows("slip_batches");
    expect(batches).toHaveLength(1);
    expect(batches[0].work_round_id).toBe("wr-1");
  });

  it("isolates evidence: routes to the round matching the slip header seller+market", async () => {
    const db = memSupabase({
      work_rounds: [
        round({ id: "wr-a", seller_name: "กี้",   market_name: "วัดทุ่ง" }),
        round({ id: "wr-b", seller_name: "พี่ดำ", market_name: "วิหาร" }),
      ],
    });
    await svc(db).processEvents([textEvent("พี่ดำ วิหาร สลิปเงินโอน 24/06/2569")], "dest");

    const batches = db._rows("slip_batches");
    expect(batches).toHaveLength(1);
    expect(batches[0].work_round_id).toBe("wr-b");
  });

  it("opens a pending selection when multiple rounds match and the header does not", async () => {
    const db = memSupabase({
      work_rounds: [
        round({ id: "wr-a", seller_name: "x", market_name: "A" }),
        round({ id: "wr-b", seller_name: "y", market_name: "B" }),
      ],
    });
    await svc(db).processEvents([textEvent("ใครก็ได้ ตลาดไหน สลิปเงินโอน 24/06/2569")], "dest");

    expect(db._rows("slip_batches")).toHaveLength(0);
    const sels = db._rows("work_round_selections");
    expect(sels).toHaveLength(1);
    expect(sels[0].intent).toBe("slip");
  });

  it("legacy: opens a batch with null link when no rounds exist", async () => {
    const db = memSupabase({ work_rounds: [] });
    await svc(db).processEvents([textEvent("กี้ วัดทุ่ง สลิปเงินโอน 24/06/2569")], "dest");

    const batches = db._rows("slip_batches");
    expect(batches).toHaveLength(1);
    expect(batches[0].work_round_id ?? null).toBeNull();
  });
});

describe("manual slip session evidence → Work Round", () => {
  it("links the manual slip session to the single eligible round", async () => {
    const db = memSupabase({ work_rounds: [round()] });
    await svc(db).processEvents([textEvent("ส่งสลิปมือ 24/06/2569")], "dest");

    const sessions = db._rows("manual_slip_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].work_round_id).toBe("wr-1");
  });

  it("opens a pending selection when multiple rounds are eligible", async () => {
    const db = memSupabase({
      work_rounds: [
        round({ id: "wr-a", market_name: "A" }),
        round({ id: "wr-b", seller_name: "พี่ดำ", market_name: "B" }),
      ],
    });
    await svc(db).processEvents([textEvent("ส่งสลิปมือ 24/06/2569")], "dest");

    expect(db._rows("manual_slip_sessions")).toHaveLength(0);
    const sels = db._rows("work_round_selections");
    expect(sels).toHaveLength(1);
    expect(sels[0].intent).toBe("manual_slip");
  });
});
