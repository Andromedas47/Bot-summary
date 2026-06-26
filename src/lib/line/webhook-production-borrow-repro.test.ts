/**
 * P0 production regression — the exact payloads reported from production.
 *
 * 1. A valid explicit "seller-market เบิก date" header must open a NEW V2 Work
 *    Round and must NEVER be routed through an existing-round resolver first
 *    (which produced the wrong "ไม่พบรายการที่เปิดอยู่" reply in production).
 *    This holds for both DD/MM and DD/MM/YYYY Buddhist date formats and even
 *    when an unrelated open round already exists for the same group+date.
 *
 * 2. The real production item payload (with malformed rows "5สาลี่12.บาท",
 *    "17น้อนหน่า@50บาท", "18ส้มเขียวหวาน@50บาท") must be handled fail-closed:
 *    every item-looking row is either parsed or named in a review error, no row
 *    is silently dropped, and a partial total is never finalized/persisted.
 *
 * Payloads below are byte-for-byte the production strings.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

let seq = 0;
function textEvent(text: string, replyToken?: string): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: seq * 1000,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `msg-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function svc(db: ReturnType<typeof memSupabase>, replies: string[] = []) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

function unrelatedOpenRound(): Row {
  return {
    id: "wr-other",
    source_id: "group-1",
    business_date: "2026-06-26",
    seller_name: "คนอื่น",
    market_name: "ตลาดอื่น",
    round_seq: 1,
    status: "open",
    source_meta: null,
    created_at: "",
    updated_at: "",
  };
}

// Item rows arrive as SEPARATE LINE messages (one item line + one quantity line),
// exactly as typed on a phone. Byte-for-byte the production payload.
const PRODUCTION_ITEM_MESSAGES = [
  "1แอปเปิ้ล20บาท", "15.ลูก",
  "2มหาชนก40บาท", "7.4.โล",
  "3ฝรั่ง35บาท", "4.7.โล",
  "4ส้มโอ20บาท", "8.ลูก",
  "5สาลี่12.บาท", "41.ลูก",
  "6ส้มไต้35บาท", "12.7.โล",
  "7เงาะ30บาท", "1.8.โล",
  "8ลองกอง30บาท", "2.3.โล",
  "9มังคุด35บาท", "8.4.โล",
  "10แก้วมังกร35บาท", "16.9.โล",
  "11จีนหง30บาท", "15.3.โล",
  "12พวงมะนี119บาท", "2.5.โล",
  "13หมอนทอง129บาท", "35.4.โล",
  "14ลองกอง40บาท", "19.5.โล",
  "15แตงไทย20บาท", "19.ลูก",
  "16สัปปรถ20บาท", "34.ลูก",
  "17น้อนหน่า@50บาท", "38.5.โล",
  "18ส้มเขียวหวาน@50บาท", "24.2.โล",
  "19ฝรั่ง35บาท", "19.2.โล",
  "20แอปเปิ้ล20บาท", "20.ลูก",
  "21ทุเรียนกล่อง70บาท", "12.กล่อง",
  "22ทุเรียนกล่อง100บาท", "3.กล่อง",
  "23ทุเรียนกล่อง120บาท", "1.กล่อง",
];

describe("P0 production repro — valid new-borrow header opens a new Work Round", () => {
  it("DD/MM date header opens a new borrow even with an unrelated open round present", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [unrelatedOpenRound()] });
    await svc(db, replies).processEvents(
      [textEvent("กี้-วัดทุ่งลานนา เบิก 26/6/2569", "tok-1")],
      "dest",
    );

    expect(replies[0]).toContain("รับหัวเบิกแล้ว");
    expect(replies[0]).toContain("กี้ — วัดทุ่งลานนา");
    expect(replies[0]).not.toContain("ไม่พบรายการที่เปิดอยู่");
    expect(db._rows("pending_sessions")).toHaveLength(1);
  });

  it("DD/MM/YYYY date header (exact production string) opens a new borrow", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [unrelatedOpenRound()] });
    await svc(db, replies).processEvents(
      [textEvent("กี้-วัดทุ่งลานนา เบิก 26/06/2569", "tok-2")],
      "dest",
    );

    expect(replies[0]).toContain("รับหัวเบิกแล้ว");
    expect(replies[0]).toContain("กี้ — วัดทุ่งลานนา");
    expect(replies[0]).not.toContain("ไม่พบรายการที่เปิดอยู่");
    expect(db._rows("pending_sessions")).toHaveLength(1);
  });

  it("complete valid header+items message creates exactly one NEW round, not the unrelated one", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [unrelatedOpenRound()] });
    await svc(db, replies).processEvents(
      [textEvent("กี้-วัดทุ่งลานนา เบิก 26/06/2569\n1.มะม่วง100บาท\n10โล\nจบรายการเบิก", "tok-3")],
      "dest",
    );

    const rounds = db._rows("work_rounds");
    expect(rounds).toHaveLength(2); // unrelated + the new one
    const created = rounds.find((r) => r.seller_name === "กี้");
    expect(created).toBeDefined();
    expect(created?.market_name).toBe("วัดทุ่งลานนา");
    expect(created?.id).not.toBe("wr-other");
  });
});

describe("P0 production repro — full item payload is handled fail-closed", () => {
  it("parser flags every malformed row, drops nothing, and exposes @50บาท / 12. rows", () => {
    const text = [
      "กี้-วัดทุ่งลานนา เบิก 26/06/2569",
      ...PRODUCTION_ITEM_MESSAGES,
      "จบรายการ",
    ].join("\n");
    const parsed = parseWeighSession(text, "2026-06-26");

    // 20 well-formed rows parse cleanly.
    expect(parsed.items).toHaveLength(20);
    expect(parsed.items.map((i) => i.item_number)).toEqual([
      1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23,
    ]);

    // Every malformed item-looking row is surfaced — none silently dropped.
    const reviewNumbers = parsed.review_issues.map((r) => r.item_number).sort((a, b) => Number(a) - Number(b));
    expect(reviewNumbers).toEqual([5, 17, 18]);
    expect(parsed.review_issues.find((r) => r.item_number === 5)?.line).toBe("5สาลี่12.บาท");
    expect(parsed.review_issues.find((r) => r.item_number === 17)?.line).toBe("17น้อนหน่า@50บาท");
    expect(parsed.review_issues.find((r) => r.item_number === 18)?.line).toBe("18ส้มเขียวหวาน@50บาท");

    // The orphaned quantity rows whose items failed are reported, not dropped.
    expect(parsed.parse_errors).toHaveLength(3);
    expect(parsed.parse_errors.join("\n")).toContain("41.ลูก");
    expect(parsed.parse_errors.join("\n")).toContain("38.5.โล");
    expect(parsed.parse_errors.join("\n")).toContain("24.2.โล");
  });

  it("webhook: header opens borrow, then the production payload returns a review error and finalizes nothing", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: [] });
    const s = svc(db, replies);

    // 1. Header opens the borrow (must pass before items are fed).
    await s.processEvents([textEvent("กี้-วัดทุ่งลานนา เบิก 26/06/2569", "tok-head")], "dest");
    expect(replies[0]).toContain("รับหัวเบิกแล้ว");
    expect(db._rows("pending_sessions")).toHaveLength(1);

    // 2. Each item/quantity row arrives as its own LINE message.
    for (const line of PRODUCTION_ITEM_MESSAGES) {
      await s.processEvents([textEvent(line)], "dest");
    }

    // 3. The closing marker triggers finalization.
    await s.processEvents([textEvent("จบรายการ", "tok-end")], "dest");

    const reviewReply = replies[replies.length - 1];
    // Specific review error naming every row that needs correction.
    expect(reviewReply).toContain("กรุณาแก้ไข");
    expect(reviewReply).toContain("#5");
    expect(reviewReply).toContain("#17");
    expect(reviewReply).toContain("#18");

    // No partial total finalized: nothing persisted, pending session cleared.
    expect(db._rows("produce_items")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("work_rounds")).toHaveLength(0);
    expect(db._rows("pending_sessions")).toHaveLength(0);
  });
});
