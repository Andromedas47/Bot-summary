/**
 * Regression tests for produce-session pending-buffer contamination.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

const MESSAGE_DATE = "2026-06-25";

let seq = 0;
function textEvent(
  text: string,
  opts: { replyToken?: string; timestamp?: number; groupId?: string } = {},
): LineMessageEvent {
  seq += 1;
  const ts = opts.timestamp ?? seq * 1000;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: ts,
    source: { type: "group", groupId: opts.groupId ?? "group-1", userId: "user-1" },
    mode: "active",
    replyToken: opts.replyToken,
    message: { id: `msg-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function openRound(over: Record<string, unknown> = {}): Row {
  return {
    id: `wr-${Math.random().toString(36).slice(2, 8)}`,
    source_id: "group-1",
    business_date: MESSAGE_DATE,
    seller_name: "น้อย",
    market_name: "วัดตะกล่ำ",
    round_seq: 1,
    status: "open",
    source_meta: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

function svc(
  db: ReturnType<typeof memSupabase>,
  replies: string[] = [],
) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

const STALE_BUFFER = [
  "ยอดคืน 11349.20บาท",
  "ยอดเบิก 18342.20บาท",
  "ส่งเงินจริง 4778บาท",
  "old test message",
  "failed attempt line",
].join("\n");

describe("WebhookService — produce pending contamination", () => {
  it("replaces stale pending buffer when a fresh valid explicit header arrives", async () => {
    const round = openRound();
    const db = memSupabase({
      work_rounds: [round],
      pending_sessions: [{
        id: "pending-stale",
        session_key: "group-1",
        accumulated_text: STALE_BUFFER,
        latest_reply_token: null,
        line_user_id: "user-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });
    const header = "น้อย-วัดตะกล่ำ เบิก 25/06/2569";
    const msg = [header, "1.หมอนทอง129บาท", "37.4.โล", "จบรายการเบิก"].join("\n");

    await svc(db).processEvents([textEvent(msg)], "dest");

    const pending = db._rows("pending_sessions");
    expect(pending).toHaveLength(0);

    const items = db._rows("produce_items");
    expect(items).toHaveLength(1);
    expect(items[0].product_name).toBe("หมอนทอง");
    expect(items.some((i) => String(i.product_name).includes("ยอด"))).toBe(false);
  });

  it("rejects incomplete header with immediate missing-market guidance and no accumulation", async () => {
    const db = memSupabase({
      work_rounds: [openRound()],
      pending_sessions: [{
        id: "pending-stale",
        session_key: "group-1",
        accumulated_text: STALE_BUFFER,
        latest_reply_token: null,
        line_user_id: "user-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });
    const replies: string[] = [];

    await svc(db, replies).processEvents([
      textEvent("น้อย เบิก 25/6/2569", { replyToken: "tok-1" }),
      textEvent("1.หมอนทอง129บาท"),
      textEvent("37.4.โล"),
      textEvent("จบรายการเบิก"),
    ], "dest");

    expect(replies[0]).toContain("หัวเบิกยังขาดชื่อตลาด");
    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("aborts pending state after failed end marker and allows a clean restart", async () => {
    const round = openRound({ seller_name: "กี้", market_name: "วัดทุ่ง" });
    const db = memSupabase({ work_rounds: [round] });
    const s = svc(db);

    await s.processEvents([textEvent("กี้-วัดทุ่ง เบิก 25/06/2569")], "dest");
    expect(db._rows("pending_sessions")).toHaveLength(1);

    await s.processEvents([textEvent("จบรายการเบิก", { replyToken: "tok-fail" })], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);

    await s.processEvents([
      textEvent("กี้-วัดทุ่ง เบิก 25/06/2569"),
      textEvent("1.มะม่วง100บาท"),
      textEvent("10โล"),
      textEvent("จบรายการเบิก"),
    ], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_items")).toHaveLength(1);
    expect(db._rows("pending_sessions")).toHaveLength(0);
  });

  it("processes one webhook batch (header → items → end) as a single clean session", async () => {
    const round = openRound();
    const db = memSupabase({ work_rounds: [round] });

    await svc(db).processEvents([
      textEvent("น้อย-วัดตะกล่ำ เบิก 25/06/2569", { timestamp: 1000 }),
      textEvent("1.หมอนทอง129บาท", { timestamp: 2000 }),
      textEvent("37.4.โล", { timestamp: 3000 }),
      textEvent("จบรายการเบิก", { timestamp: 4000 }),
    ], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_items")).toHaveLength(1);
    expect(db._rows("pending_sessions")).toHaveLength(0);
  });
});

describe("parseWeighSession — reserved financial lines", () => {
  const financeLines = [
    "ยอดเบิก 18342.20บาท",
    "ยอดคืน 11349.20บาท",
    "ยอดคืนเสีย 100บาท",
    "ยอดที่ต้องขายได้ 5000บาท",
    "ยอดเงินโอน 2638บาท",
    "ยอดสลิปมือ 500บาท",
    "ยอดรวม 999บาท",
    "ยอดรวมสลิป 888บาท",
    "ส่งเงินจริง 4778บาท",
    "ส่งเงินขาด 10บาท",
    "ส่งเงินเกิน 20บาท",
    "เงินโอนไม่ขาด 30บาท",
    "ยอดเงินขาด 40บาท",
  ];

  for (const line of financeLines) {
    it(`does not parse "${line}" as a produce item`, () => {
      const text = [
        "น้อย-วัดตะกล่ำ เบิก 25/06/2569",
        line,
        "1.หมอนทอง129บาท",
        "37.4.โล",
        "จบรายการเบิก",
      ].join("\n");
      const parsed = parseWeighSession(text, MESSAGE_DATE);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].product_name).toBe("หมอนทอง");
    });
  }

  it("still parses legitimate numbered produce lines after financial text", () => {
    const text = [
      "เสือ-ตลาด72 เบิก",
      "ยอดเบิก 999บาท",
      "1.หมอนทอง119บาท",
      "38โล",
      "จบรายการเบิก",
    ].join("\n");
    const parsed = parseWeighSession(text, MESSAGE_DATE);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].product_name).toBe("หมอนทอง");
  });

  it("blocks ตรวจสลิป and ขาดจากยอดเงินโอน from becoming produce items", () => {
    for (const line of ["ตรวจสลิป", "ขาดจากยอดเงินโอน 0"]) {
      const text = [
        "เสือ-ตลาด72 เบิก",
        line,
        "1.หมอนทอง119บาท",
        "38โล",
        "จบรายการเบิก",
      ].join("\n");
      const parsed = parseWeighSession(text, MESSAGE_DATE);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].product_name).toBe("หมอนทอง");
    }
  });
});

describe("WebhookService — V2 incomplete borrow header regression (กี้ เบิก 25/6/2569 incident)", () => {
  it("rejects standalone incomplete header with missing-market message; no pending session or Work Round created", async () => {
    const db = memSupabase();
    const replies: string[] = [];

    await svc(db, replies).processEvents([
      textEvent("กี้ เบิก 25/6/2569", { replyToken: "tok-header" }),
    ], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("หัวเบิกยังขาดชื่อตลาด");
    expect(replies[0]).toContain("กี้-วัดทุ่งลานนา เบิก 25/6/2569");
    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("work_rounds")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("item lines after rejected incomplete header are not accumulated or persisted", async () => {
    const db = memSupabase();
    const s = svc(db);

    await s.processEvents([textEvent("กี้ เบิก 25/6/2569")], "dest");
    await s.processEvents([textEvent("1.หมอนทอง119บาท")], "dest");
    await s.processEvents([textEvent("38โล")], "dest");
    await s.processEvents([textEvent("จบรายการเบิก")], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("finance phrases after rejected incomplete header do not create produce items", async () => {
    const db = memSupabase();
    const s = svc(db);

    await s.processEvents([textEvent("กี้ เบิก 25/6/2569")], "dest");
    for (const line of [
      "ยอดที่ต้องขายได้ 20218.90",
      "ยอดเงินโอน 7702.30",
      "ยอดสลิปมือ 500",
      "ส่งเงินจริง 7702.30",
      "ส่งเงินเกิน 0",
      "ตรวจสลิป",
      "ขาดจากยอดเงินโอน 0",
    ]) {
      await s.processEvents([textEvent(line)], "dest");
    }

    expect(db._rows("produce_items")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
  });

  it("full valid flow (เบิก → ชั่งคืน → คืนเสีย) stays attached to one Work Round throughout", async () => {
    const db = memSupabase();
    const s = svc(db);

    await s.processEvents([
      textEvent("กี้-วัดทุ่งลานนา เบิก 25/6/2569", { timestamp: 1000 }),
      textEvent("1.หมอนทอง119บาท", { timestamp: 2000 }),
      textEvent("38โล", { timestamp: 3000 }),
      textEvent("จบรายการเบิก", { timestamp: 4000, replyToken: "tok-borrow" }),
    ], "dest");

    expect(db._rows("work_rounds")).toHaveLength(1);
    const wrId = String(db._rows("work_rounds")[0].id);

    await s.processEvents([
      textEvent("กี้ ชั่งคืน 25/6/2569", { timestamp: 5000 }),
      textEvent("1.หมอนทอง119บาท", { timestamp: 6000 }),
      textEvent("10โล", { timestamp: 7000 }),
      textEvent("จบรายการ", { timestamp: 8000, replyToken: "tok-return" }),
    ], "dest");

    await s.processEvents([
      textEvent("กี้ คืนเสีย 25/6/2569", { timestamp: 9000 }),
      textEvent("1.หมอนทอง119บาท", { timestamp: 10000 }),
      textEvent("5โล", { timestamp: 11000 }),
      textEvent("จบรายการ", { timestamp: 12000, replyToken: "tok-bad-return" }),
    ], "dest");

    expect(db._rows("work_rounds")).toHaveLength(1);
    expect(db._rows("produce_sessions")).toHaveLength(3);
    expect(
      db._rows("produce_sessions").every((r) => String(r.work_round_id) === wrId),
    ).toBe(true);
  });

  it("slip no-round error uses V2 wording (รอบ/ปิดรอบ), not legacy term (งวด)", async () => {
    const db = memSupabase();
    const replies: string[] = [];

    await svc(db, replies).processEvents([
      textEvent("กี้ วัดทุ่งลานนา สลิปเงินโอน 25/6/2569", { replyToken: "tok-slip" }),
    ], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain("งวด");
    expect(replies[0]).toContain("รอบ");
  });
});
