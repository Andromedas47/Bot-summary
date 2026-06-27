/**
 * P0 regression — explicit seller-market คืนเสีย must open pending sessions and
 * finalize with จบรายการคืนเสีย, matching the ชั่งคืน hotfix behaviour.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";

const MESSAGE_DATE = "2026-06-27";
const LO = "\u0E42\u0E25";
const GROUP = "group-bad-return";

let seq = 0;
function textEvent(text: string, opts: { replyToken?: string; timestamp?: number } = {}): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: opts.timestamp ?? seq * 1000,
    source: { type: "group", groupId: GROUP, userId: "user-1" },
    mode: "active",
    replyToken: opts.replyToken ?? "reply-tok",
    message: { id: `msg-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function openRound(over: Partial<Row> = {}): Row {
  return {
    id: "wr-daeng",
    source_id: GROUP,
    business_date: MESSAGE_DATE,
    seller_name: "แดง",
    market_name: "ตลาดนัดจตุจักร",
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

const HEADER = "แดง-ตลาดนัดจตุจักร คืนเสีย 27/6/2569";
const PRODUCTION_ONE_SHOT = [
  HEADER,
  "1. แตงโม 40 บาท",
  `3 ${LO}`,
  "2. ส้มโอ 25 บาท",
  `2 ${LO}`,
  "จบรายการคืนเสีย",
].join("\n");

describe("WebhookService — คืนเสีย pending session hotfix", () => {
  it("explicit คืนเสีย header opens pending session with confirmation", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [openRound()] });

    await svc(db, replies).processEvents([textEvent(HEADER)], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(1);
    expect(replies[0]).toContain("รับหัวคืนเสียแล้ว");
    expect(replies[0]).toContain("แดง — ตลาดนัดจตุจักร");
    expect(replies[0]).toContain("จบรายการคืนเสีย");
    expect(replies[0]).not.toContain("ไม่พบรายการที่เปิดอยู่");
  });

  it("production one-shot payload finalizes with bad-return summary", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [openRound()] });

    await svc(db, replies).processEvents([textEvent(PRODUCTION_ONE_SHOT, { replyToken: "tok-close" })], "dest");

    expect(db._rows("produce_items")).toHaveLength(2);
    expect(db._rows("produce_items").every((row) => row.transaction_type === "คืนเสีย")).toBe(true);
    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("pending_sessions")).toHaveLength(0);
  });

  it("จบรายการคืนเสีย without session uses guidance mentioning all work types", async () => {
    const replies: string[] = [];
    const db = memSupabase();

    await svc(db, replies).processEvents([textEvent("จบรายการคืนเสีย")], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(replies[0]).toContain("รายการนี้มาหลังปิดรอบแล้ว");
    expect(replies[0]).not.toContain("กี้-วัดทุ่งลานนา เบิก 24/06/2569");
  });

  it("คืนเสีย header without open round replies with explicit seller-market-date prompt", async () => {
    const replies: string[] = [];
    const db = memSupabase();

    await svc(db, replies).processEvents([textEvent(HEADER)], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(replies[0]).toContain("ไม่พบรอบที่ตรงกับ");
    expect(replies[0]).toContain("แดง — ตลาดนัดจตุจักร");
    expect(replies[0]).toContain("27/6/2569");
    expect(replies[0]).not.toContain("ทดสอบ2");
  });

  it("จบรายการคืนเสีย does not close an open borrow pending session", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [openRound({ seller_name: "กี้", market_name: "วัดทุ่งลานนา" })],
      pending_sessions: [{
        id: "pending-borrow",
        session_key: GROUP,
        accumulated_text: "กี้-วัดทุ่งลานนา เบิก 27/6/2569\n1.มะม่วง100บาท",
        latest_reply_token: null,
        line_user_id: "user-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });

    await svc(db, replies).processEvents([textEvent("จบรายการคืนเสีย", { replyToken: "tok-wrong" })], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(1);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("ชั่งคืn explicit header still opens pending session after คืนเสีย fix", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [openRound({ seller_name: "กี้", market_name: "วัดทุ่งลานนา" })] });
    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 27/6/2569";

    await svc(db, replies).processEvents([textEvent(header)], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(1);
    expect(replies[0]).toContain("รับหัวชั่งคืนแล้ว");
    expect(replies[0]).not.toContain("ไม่พบรายการที่เปิดอยู่");
  });
});
