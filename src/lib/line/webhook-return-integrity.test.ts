import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";
import { parseWeighSession, buildParseReviewReply, hasParseReviewBlockers } from "@/lib/parsers/weigh-session/parser";

const MESSAGE_DATE = "2026-06-25";
const LO = "\u0E42\u0E25";

let seq = 0;
function textEvent(text: string, userId = "user-1", replyToken = "reply-tok"): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    source: { type: "group", groupId: "group-1", userId },
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
    seller_name: "โอม",
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

const PRODUCTION_20_ITEM = [
  "โอม ชั่งคืน 25/6/2569",
  "1ส้มไต้หวัน 40 บาท",
  `2.20${LO}`,
  "2ฝรั่ง 40บาท",
  `3.3${LO}`,
  "3ลองกอง 40บาท",
  `11${LO}`,
  "4สาลี่หอม 35 บาท",
  `10.2${LO}`,
  "5แก้วมังกร 35 บาท",
  `48.1${LO}`,
  "6มังคุด 35บาท",
  `39.6${LO}`,
  "7เงาะ 40บาท",
  `16.6${LO}`,
  "8เขียวมรกต 35 บาท",
  `12.5${LO}`,
  `9จีนหงส์ 3 ${LO}100บาท`,
  `15.5${LO}`,
  "10สายน้ำผึ้ง 50 บาท",
  `48.6${LO}`,
  `11น้อยหน่า${LO}ละ 50 บาท`,
  `20.1${LO}`,
  "12ฝรั่งขาว40 บาท",
  `34.7${LO}`,
  `13มหาชนก${LO}ละ35บาท`,
  `50.1${LO}`,
  `14องุ่นแดง ${LO}ละ130 บาท`,
  `7.4${LO}`,
  "15แตงไทย 20 บาท",
  "20ลูก",
  "16ส้มโอ 20 บาท",
  "12ลูก",
  "17apple 20 บาท",
  "40ลูก",
  `18แตง${LO} 40 บาท`,
  "9ลูก",
  "19มะละกอ 16 บาท",
  "13ลูก",
  "20สาลี่ 12 บาท",
  "75ลูก",
  "จบรายการ",
].join("\n");

// Exact production payload that reproduced the ordering bug (spaced item number).
const PRODUCTION_SPACED_BAD = [
  "ทดสอบกำกวม-ตลาดกำกวม เบิก 1/7/2569",
  `9 จีนหงส์ 3 ${LO}100บาท`,
  `15.5 ${LO}`,
  "จบรายการเบิก",
].join("\n");

describe("WebhookService — return parser integrity", () => {
  it("single-message: spaced item number + ambiguous price gives parse-review reply, not generic error", async () => {
    // Production bug: "9 จีนหงส์ 3 โล100บาท" (space after 9) → items=[] + review_issues=[#9]
    // Old behaviour: items.length===0 guard fired first → "อ่านรายการไม่สำเร็จ"
    // Required:      hasParseReviewBlockers fires first → "#9 จีนหงส์..." reply
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents([textEvent(PRODUCTION_SPACED_BAD)], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    expect(replies[0]).toContain("อ่านรายการไม่ครบ");
    expect(replies[0]).toContain("กรุณาแก้ไข");
    expect(replies[0]).toContain("#9");
    expect(replies[0]).toContain("จีนหงส์");
    expect(replies[0]).not.toContain("อ่านรายการไม่สำเร็จ");
    expect(replies[0]).not.toContain("บันทึกแล้ว");
  });

  it("multi-message: spaced item number + ambiguous price gives parse-review reply via pending session path", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    const service = svc(db, replies);

    await service.processEvents([textEvent("ทดสอบกำกวม-ตลาดกำกวม เบิก 1/7/2569")], "dest");
    await service.processEvents([
      textEvent([`9 จีนหงส์ 3 ${LO}100บาท`, `15.5 ${LO}`, "จบรายการเบิก"].join("\n")),
    ], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    const finalReply = replies[replies.length - 1];
    expect(finalReply).toContain("อ่านรายการไม่ครบ");
    expect(finalReply).toContain("#9");
    expect(finalReply).toContain("จีนหงส์");
    expect(finalReply).not.toContain("อ่านรายการไม่สำเร็จ");
    expect(finalReply).not.toContain("บันทึกแล้ว");
  });

  it("does not persist 20-item payload when #9 is ambiguous — full reply format", async () => {
    const replies: string[] = [];
    const round = openRound();
    const db = memSupabase({ work_rounds: [round] });
    await svc(db, replies).processEvents([textEvent(PRODUCTION_20_ITEM)], "dest");

    // Zero DB writes — even the 19 valid rows must not be persisted.
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    // Reply identifies the bad row; no success message leaks through.
    expect(replies[0]).toContain("อ่านรายการไม่ครบ");
    expect(replies[0]).toContain("กรุณาแก้ไข");
    expect(replies[0]).toContain("#9");
    expect(replies[0]).toContain("จีนหงส์");
    expect(replies[0]).not.toContain("บันทึกแล้ว");
  });

  it("multi-message (pending session): malformed row in accumulated text blocks finalization", async () => {
    // Tests the pending-session accumulation path: header, items with bad row,
    // then end command in separate messages. The gate must hold across all three.
    const replies: string[] = [];
    const round = openRound();
    const db = memSupabase({ work_rounds: [round] });
    const service = svc(db, replies);

    await service.processEvents([textEvent("โอม ชั่งคืน 25/6/2569")], "dest");
    await service.processEvents([
      textEvent([
        "1ส้มไต้หวัน 40 บาท",
        `20${LO}`,
        `9จีนหงส์ 3 ${LO}100บาท`,
        `15.5${LO}`,
      ].join("\n")),
    ], "dest");
    await service.processEvents([textEvent("จบรายการ")], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    const finalReply = replies[replies.length - 1];
    expect(finalReply).toContain("อ่านรายการไม่ครบ");
    expect(finalReply).toContain("#9");
    expect(finalReply).not.toContain("บันทึกแล้ว");
  });

  it("apple in borrow session persists correctly — E2E", async () => {
    // The success reply goes through replyLineMessage (HTTP), not the mock.
    // Proof of correctness is in the DB state; the mock captures only error-path replies.
    const replies: string[] = [];
    const round = openRound({ status: "open" });
    const db = memSupabase({ work_rounds: [round] });
    await svc(db, replies).processEvents([
      textEvent([
        "โอม-วัดทุ่งลานนา เบิก 25/6/2569",
        "1apple 20 บาท",
        "40ลูก",
        "จบรายการ",
      ].join("\n")),
    ], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_items")).toHaveLength(1);
    const item = db._rows("produce_items")[0] as Record<string, unknown>;
    expect(item["product_name"]).toBe("apple");
    expect(item["quantity"]).toBe(40);
    expect(item["price_per_unit"]).toBe(20);
    // No parse-error reply: none of the mock replies should contain a block message.
    expect(replies.every((r) => !r.includes("อ่านรายการไม่ครบ"))).toBe(true);
  });

  it("seller-only return header hydrates seller + market from the unique Work Round", async () => {
    const replies: string[] = [];
    const round = openRound({ seller_name: "โอม", market_name: "วัดทุ่งลานนา" });
    const db = memSupabase({ work_rounds: [round] });

    await svc(db, replies).processEvents([
      textEvent("โอม ชั่งคืน 25/6/2569"),
    ], "dest");

    expect(replies[0]).toContain("รับหัวชั่งคืนแล้ว");
    expect(replies[0]).not.toContain("รับหัวเบิกแล้ว");
    expect(replies[0]).toContain("โอม — วัดทุ่งลานนา");
    expect(db._rows("work_rounds")).toHaveLength(1);
  });

  it("seller-only return with zero matching rounds rejects without pending session", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [] });

    await svc(db, replies).processEvents([
      textEvent("โอม ชั่งคืน 25/6/2569"),
    ], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(replies[0]).not.toContain("รับหัวเบิกแล้ว");
  });

  it("seller-only return with multiple matching rounds rejects without persisting", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [
        openRound({ id: "wr-a", market_name: "วัดทุ่งลานนา" }),
        openRound({ id: "wr-b", market_name: "อีกตลาด" }),
      ],
    });

    await svc(db, replies).processEvents([
      textEvent(["โอม ชั่งคืน 25/6/2569", "1หมอนทอง129บาท", `2${LO}`, "จบรายการ"].join("\n")),
    ], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("work_round_selections").length).toBeGreaterThan(0);
    expect(replies.some((r) => r.includes("รับหัวเบิกแล้ว"))).toBe(false);
  });
});

describe("parseWeighSession — review reply helper", () => {
  it("buildParseReviewReply lists flagged item numbers one per line with snippet", () => {
    const parsed = parseWeighSession(PRODUCTION_20_ITEM, MESSAGE_DATE);
    expect(hasParseReviewBlockers(parsed)).toBe(true);
    const reply = buildParseReviewReply(parsed);
    expect(reply).toContain("อ่านรายการไม่ครบ");
    expect(reply).toContain("กรุณาแก้ไข");
    expect(reply).toContain("#9");
    // The problematic line text must appear so the user knows what to fix.
    expect(reply).toContain("จีนหงส์");
    // Each issue on its own line (newline-per-issue format).
    expect(reply.split("\n").some((l) => l.startsWith("#9"))).toBe(true);
  });
});
