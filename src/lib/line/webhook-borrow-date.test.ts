/**
 * P0-A: Borrow header must carry an explicit date.
 * A seller-market เบิก or รายการเบิกเพิ่ม without a date in the header must be
 * rejected immediately — no pending session, no Work Round, zero DB writes.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";

const MESSAGE_DATE = "2026-06-26";

let seq = 0;
function textEvent(text: string, replyToken = "reply-tok"): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `msg-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function openRound(over: Record<string, unknown> = {}): Row {
  return {
    id: `wr-${Math.random().toString(36).slice(2, 8)}`,
    source_id: "group-1",
    business_date: MESSAGE_DATE,
    seller_name: "ตรวจรอบใหม่",
    market_name: "ตลาดตรวจ",
    round_seq: 1,
    status: "open",
    source_meta: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

function svc(db: ReturnType<typeof memSupabase>, replies: string[] = []) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

describe("P0-A — borrow header without date is rejected", () => {
  it("header-only without date → reject reply, zero DB writes", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents(
      [textEvent("ตรวจรอบใหม่-ตลาดตรวจ เบิก")],
      "dest",
    );

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("work_rounds")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(replies[0]).toContain("หัวเบิกยังขาดวันที่");
    expect(replies[0]).toContain("ตรวจรอบใหม่-ตลาดตรวจ เบิก");
  });

  it("item lines sent after rejected header accumulate no session or items", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    const service = svc(db, replies);

    // First message: header without date
    await service.processEvents([textEvent("ตรวจรอบใหม่-ตลาดตรวจ เบิก")], "dest");
    // Second message: item lines (would be ignored if pending session existed)
    await service.processEvents([textEvent("1.มะม่วง100บาท\n10โล\nจบรายการเบิก")], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("header with explicit date still opens normally", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents(
      [textEvent("ตรวจรอบใหม่-ตลาดตรวจ เบิก 26/6/2569")],
      "dest",
    );

    expect(db._rows("pending_sessions")).toHaveLength(1);
    expect(db._rows("work_rounds")).toHaveLength(0); // pending, not yet finalized
    expect(replies[0]).toContain("รับหัวเบิกแล้ว");
    expect(replies[0]).not.toContain("หัวเบิกยังขาดวันที่");
  });

  it("explicit produce-append header without date → reject, zero DB writes", async () => {
    const replies: string[] = [];
    const round = openRound({ status: "open" });
    const db = memSupabase({ work_rounds: [round] });
    await svc(db, replies).processEvents(
      [textEvent("ตรวจรอบใหม่-ตลาดตรวจ รายการเบิกเพิ่ม")],
      "dest",
    );

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(replies[0]).toContain("หัวเบิกยังขาดวันที่");
  });
});
