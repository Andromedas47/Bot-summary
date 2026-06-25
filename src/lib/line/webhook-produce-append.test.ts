/**
 * Regression tests for V2 "รายการเบิกเพิ่ม" append flow and multi-batch Work Rounds.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService, hasProduceAppendStart, hasSessionStart } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { computeRoundTotals } from "@/lib/work-round/expected-sales";

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
    seller_name: "โอม",
    market_name: "ตลาดพาซิโอ้ผลไม้",
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

function itemTotal(items: Row[]): number {
  return items.reduce(
    (sum, row) => sum + Number(row.price_per_unit) * Number(row.quantity ?? 0),
    0,
  );
}

const LO = "\u0E42\u0E25";

// Batch 1 items 1–11 (verified total 5,703.00)
const BATCH1_LINES = [
  "โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569",
  "1มังคุด35บาท", `18.3.${LO}`,
  "2ทุเรียนหมอน35บาท", `18.${LO}`,
  "3เงาะ40บาท", `16.7.${LO}`,
  "4เงาะ40บาท", `16.7.${LO}`,
  "5มะม่วง40บาท", `20.9.${LO}`,
  "6มะม่วง40บาท", `20.9.${LO}`,
  "7มะม่วง40บาท", `20.9.${LO}`,
  "8มะม่วง40บาท", `20.9.${LO}`,
  "9มะม่วง40บาท", `20.9.${LO}`,
  "10มะม่วง40บาท", `20.9.${LO}`,
  "11แอปเปิ้ล20บาท", "11.ลูก",
  "จบรายการเบิก",
];

// Batch 2 items 12–28 (verified total 13,826.00) — includes #17 ลองกอง and #18 เงาะ
const BATCH2_LINES = [
  "รายการเบิกเพิ่ม",
  "12แอปเปิ้ล20บาท", "40.ลูก",
  "13แอปเปิ้ล20บาท", "40.ลูก",
  "14แอปเปิ้ล20บาท", "40.ลูก",
  "15แอปเปิ้ล20บาท", "40.ลูก",
  "16แอปเปิ้ล20บาท", "40.ลูก",
  "17ลองกอง40บาท", `20.9.${LO}`,
  "18เงาะ40บาท", `16.7.${LO}`,
  "19เงาะ40บาท", `16.7.${LO}`,
  "20เงาะ40บาท", `16.7.${LO}`,
  "21เงาะ40บาท", `16.7.${LO}`,
  "22เงาะ40บาท", `16.7.${LO}`,
  "23เงาะ40บาท", `16.7.${LO}`,
  "24เงาะ40บาท", `16.7.${LO}`,
  "25เงาะ40บาท", `16.7.${LO}`,
  "26สับปะรดหัวละ20บาท", "19หัว",
  "27สับปะรดหัวละ20บาท", "19หัว",
  "28สับปะรดหัวละ 20บาท", "19หัว",
  "จบรายการ",
];

describe("produce append markers", () => {
  it("treats รายการเบิกเพิ่ม as append, not a new session header", () => {
    expect(hasProduceAppendStart("รายการเบิกเพิ่ม")).toBe(true);
    expect(hasSessionStart("รายการเบิกเพิ่ม")).toBe(false);
  });
});

describe("WebhookService — รายการเบิกเพิ่ม V2 regression", () => {
  it("full flow: header → 1–11 → จบรายการเบิก → รายการเบิกเพิ่ม → 12–28 → จบรายการ", async () => {
    const round = openRound();
    const db = memSupabase({ work_rounds: [round] });
    const replies: string[] = [];
    const s = svc(db, replies);

    for (const line of BATCH1_LINES) {
      await s.processEvents([textEvent(line)], "dest");
    }

    const afterBatch1 = db._rows("produce_sessions");
    expect(afterBatch1).toHaveLength(1);
    expect(afterBatch1[0].work_round_id).toBe(round.id as string);
    expect(afterBatch1[0].staff_name).toBe("โอม");
    expect(afterBatch1[0].is_append_session).toBe(false);

    for (const line of BATCH2_LINES) {
      const isEnd = line === "จบรายการ";
      await s.processEvents([textEvent(line, isEnd ? { replyToken: "tok-append-end" } : {})], "dest");
    }

    const rounds   = db._rows("work_rounds");
    const sessions = db._rows("produce_sessions");
    const items    = db._rows("produce_items");

    expect(rounds).toHaveLength(1);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((sess) => sess.work_round_id === round.id)).toBe(true);

    const appendSession = sessions.find((sess) => sess.is_append_session === true);
    expect(appendSession).toBeDefined();
    expect(appendSession?.staff_name).toBe("โอม");
    expect(appendSession?.session_title).toBe("ตลาดพาซิโอ้ผลไม้");

    expect(items).toHaveLength(28);

    const item17 = items.find((i) => i.item_number === 17);
    const item18 = items.find((i) => i.item_number === 18);
    expect(item17?.product_name).toBe("ลองกอง");
    expect(item17?.quantity).toBeCloseTo(20.9, 4);
    expect(item18?.product_name).toBe("เงาะ");
    expect(item18?.quantity).toBeCloseTo(16.7, 4);

    const batch1Parsed = parseWeighSession(BATCH1_LINES.join("\n"), MESSAGE_DATE);
    const batch2Parsed = parseWeighSession(BATCH2_LINES.join("\n"), MESSAGE_DATE);
    const expectedTotal = itemTotal(batch1Parsed.items as unknown as Row[])
      + itemTotal(batch2Parsed.items as unknown as Row[]);

    const roundTotal = await computeRoundTotals(db as never, round.id as string);
    expect(roundTotal.borrow).toBeCloseTo(expectedTotal, 0);
    expect(appendSession?.staff_name).toBe("โอม");
    expect(appendSession?.session_title).toBe("ตลาดพาซิโอ้ผลไม้");
  });

  it("rejects รายการเบิกเพิ่ม when no identifiable open Work Round exists", async () => {
    const db = memSupabase({ work_rounds: [] });
    const replies: string[] = [];

    await svc(db, replies).processEvents([
      textEvent("รายการเบิกเพิ่ม", { replyToken: "tok-1" }),
      textEvent("12แอปเปิ้ล20บาท"),
      textEvent("40.ลูก"),
      textEvent("จบรายการ"),
    ], "dest");

    expect(replies[0]).toContain("ไม่พบรอบเบิกที่ยังเปิดอยู่สำหรับรายการเพิ่ม");
    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("V2 produce session cannot persist without work_round_id, seller, or market", async () => {
    const db = memSupabase({ work_rounds: [] });
    const msg = ["รายการชั่งเบิก 25/6/2569", "1.มะม่วง100บาท", `10${LO}`, "จบรายการเบิก"].join("\n");

    await svc(db).processEvents([textEvent(msg)], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("accepts both จบรายการเบิก and จบรายการ as batch end markers", async () => {
    const round = openRound({ seller_name: "กี้", market_name: "วัดทุ่ง" });
    const db = memSupabase({ work_rounds: [round] });

    await svc(db).processEvents([
      textEvent("กี้-วัดทุ่ง เบิก 25/6/2569"),
      textEvent("1.มะม่วง100บาท"),
      textEvent(`10${LO}`),
      textEvent("จบรายการ"),
    ], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_sessions")[0].work_round_id).toBe(round.id as string);
    expect(db._rows("produce_items")).toHaveLength(1);
  });

  it("parser keeps 17ลองกอง and 18เงาะ with quantities in append batch", () => {
    const text = BATCH2_LINES.join("\n");
    const parsed = parseWeighSession(text, MESSAGE_DATE);

    expect(parsed.items.find((i) => i.item_number === 17)).toMatchObject({
      product_name: "ลองกอง", price_per_unit: 40, quantity: 20.9, unit: LO,
    });
    expect(parsed.items.find((i) => i.item_number === 18)).toMatchObject({
      product_name: "เงาะ", price_per_unit: 40, quantity: 16.7, unit: LO,
    });
    expect(parsed.parse_errors).toHaveLength(0);
    expect(parsed.items).toHaveLength(17);
  });
});
