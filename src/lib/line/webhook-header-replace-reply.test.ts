/**
 * Regression: pending session replace-by-header must send the same opened reply
 * as a fresh header-only session (linked generic return was silent in production).
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";

const MESSAGE_DATE = "2026-06-25";

let seq = 0;
function textEvent(
  text: string,
  opts: { replyToken?: string } = {},
): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: seq * 1000,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: opts.replyToken ?? "reply-tok",
    message: { id: `msg-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function openRound(over: Record<string, unknown> = {}): Row {
  return {
    id: "wr-1",
    source_id: "group-1",
    business_date: MESSAGE_DATE,
    seller_name: "กี้",
    market_name: "วัดทุ่งลานนา",
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

function stalePending(accumulatedText: string): Row {
  return {
    id: "pending-stale",
    session_key: "group-1",
    accumulated_text: accumulatedText,
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("WebhookService — pending session replace header reply", () => {
  it("linked explicit ชั่งคืน header replaces pending session and sends confirmation", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [openRound()],
      pending_sessions: [stalePending("โอม-ตลาดเก่า เบิก 25/6/2569\n1มังคุด35บาท")],
    });
    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";

    await svc(db, replies).processEvents([textEvent(header)], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(1);
    expect(db._rows("pending_sessions")[0].accumulated_text).toBe(header);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("รับหัวชั่งคืนแล้ว");
    expect(replies[0]).toContain("กี้ — วัดทุ่งลานนา");
    expect(replies[0]).toContain("ส่งรายการสินค้าได้เลย");
  });

  it("linked explicit เบิก header replace still sends borrow confirmation", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [openRound({ seller_name: "โอม", market_name: "ตลาดพาซิโอ้ผลไม้" })],
      pending_sessions: [stalePending("กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569")],
    });
    const header = "โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569";

    await svc(db, replies).processEvents([textEvent(header)], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(1);
    expect(db._rows("pending_sessions")[0].accumulated_text).toBe(header);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("รับหัวเบิกแล้ว");
    expect(replies[0]).toContain("โอม — ตลาดพาซิโอ้ผลไม้");
    expect(replies[0]).toContain("จบรายการเบิก");
  });

  it("fresh header-only session reply unchanged (no prior pending)", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [openRound()] });

    await svc(db, replies).processEvents([
      textEvent("กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569"),
    ], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("รับหัวชั่งคืนแล้ว");
  });
});
