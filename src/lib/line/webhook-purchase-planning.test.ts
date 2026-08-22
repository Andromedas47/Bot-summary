import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import {
  PURCHASE_PLANNING_TITLE,
  STATUS_HEADINGS,
} from "@/lib/summary/purchase-planning-message";
import { FakeDatabase, type Row } from "@/lib/summary/test-fake-supabase";

/**
 * Command integration for `สรุปสินค้าขายดี` — real WebhookService, real
 * dispatch order, read-only from end to end.
 */

const BUSINESS_DATE = "2026-08-21";
const ROUND = "11111111-1111-4111-8111-111111111111";

function produceRow(overrides: Row = {}): Row {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    session_id: "session-1",
    market_name: "ตลาด72",
    staff_name: "โอม",
    product_name: "แอปเปิ้ล",
    quantity: 100,
    unit: "ลูก",
    transaction_type: "เบิก",
    base_transaction_type: "เบิก",
    price_per_unit: 20,
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
    raw_message_id: "raw-seed-1",
    session_kind: "main",
    item_created_at: "2026-08-21T02:00:00.000Z",
    accountability_round_id: ROUND,
    transaction_date: BUSINESS_DATE,
    ...overrides,
  };
}

let eventSequence = 0;
function textEvent(text: string, replyToken?: string): LineMessageEvent {
  eventSequence += 1;
  return {
    type: "message",
    webhookEventId: `purchase-event-${eventSequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.parse("2026-08-22T03:00:00.000Z"),
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `purchase-message-${eventSequence}`, type: "text", text },
  } as LineMessageEvent;
}

function service(db: FakeDatabase, replies: string[] = []) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
    replyMessages: async (_token, texts) => { replies.push(texts.join("\n\n")); },
  });
}

function seedDay(db: FakeDatabase): FakeDatabase {
  return db
    .seed("produce_transactions", [
      produceRow({ transaction_type: "เบิก", quantity: 100 }),
      produceRow({ transaction_type: "คืน", quantity: 80 }),
    ])
    .seed("accountability_rounds", [
      { id: ROUND, seller_label: "โอม", market_label: "ตลาด72" },
    ]);
}

describe("สรุปสินค้าขายดี command integration", () => {
  it("answers for the date in the command without touching any produce session", async () => {
    const db = seedDay(new FakeDatabase());
    const replies: string[] = [];

    const result = await service(db, replies).processEvents(
      [textEvent("สรุปสินค้าขายดี 21/08/2569", "purchase-reply")],
      "destination",
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(PURCHASE_PLANNING_TITLE);
    expect(replies[0]).toContain("ข้อมูลวันที่ 21 สิงหาคม 2569");
    // 100 out, 80 weighed back → 20% → ควรลดการซื้อ.
    expect(replies[0]).toContain(STATUS_HEADINGS.reduce);
    expect(replies[0]).toContain("แอปเปิ้ล");
    expect(replies[0]).toContain("ขายออก 20%");
    expect(db.appendCalls).toBe(0);
    expect(result[0]!.status).toBe("saved");
  });

  it("is read out of an exported LINE line, prefix and all", async () => {
    const db = seedDay(new FakeDatabase());
    const replies: string[] = [];

    await service(db, replies).processEvents(
      [textEvent("09:12 พี่ไก่ สรุปสินค้าขายดี 21/08/2569", "purchase-reply-2")],
      "destination",
    );

    expect(replies[0]).toContain(PURCHASE_PLANNING_TITLE);
    expect(db.appendCalls).toBe(0);
  });

  it("is not swallowed by an OPEN pending produce session", async () => {
    const openSession: Row = {
      id: "pending-1",
      session_key: "group:group-1:user:user-1",
      source_id: "group-1",
      session_generation: "33333333-3333-4333-8333-333333333333",
      accumulated_text: "โอม-พาซิโอ้ผลไม้ เบิก 21/08/2569",
      latest_reply_token: null,
      line_user_id: "user-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      close_event_timestamp_ms: null,
      close_requested_at: null,
      close_line_event_id: null,
      close_finalize_started_at: null,
      terminalized: false,
      next_attempt_at: null,
      close_deadline_at: null,
      close_session_generation: null,
      expected_item_count: null,
      ingest_revision: 0,
      finalization_status: "pending",
    };
    const db = seedDay(new FakeDatabase()).seed("pending_sessions", [openSession]);
    const replies: string[] = [];

    await service(db, replies).processEvents(
      [textEvent("สรุปสินค้าขายดี 21/08/2569", "purchase-reply-open")],
      "destination",
    );

    expect(replies[0]).toContain(PURCHASE_PLANNING_TITLE);
    expect(db.appendCalls).toBe(0);
    expect(db.rpcCalls).toHaveLength(0);
    // The open document is untouched — not appended to, not closed.
    expect(db.rows("pending_sessions")[0]!.accumulated_text)
      .toBe(openSession.accumulated_text);
  });

  it("control — a normal produce item line DOES reach the open session", async () => {
    const openSession: Row = {
      id: "pending-1",
      session_key: "group:group-1:user:user-1",
      source_id: "group-1",
      session_generation: "33333333-3333-4333-8333-333333333333",
      accumulated_text: "โอม-พาซิโอ้ผลไม้ เบิก 21/08/2569",
      latest_reply_token: null,
      line_user_id: "user-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      close_event_timestamp_ms: null,
      close_requested_at: null,
      close_line_event_id: null,
      close_finalize_started_at: null,
      terminalized: false,
      next_attempt_at: null,
      close_deadline_at: null,
      close_session_generation: null,
      expected_item_count: null,
      ingest_revision: 0,
      finalization_status: "pending",
    };
    const db = seedDay(new FakeDatabase()).seed("pending_sessions", [openSession]);

    await service(db).processEvents(
      [textEvent("1.ทุเรียน100บาท\n2โล")],
      "destination",
    );

    // Proves the previous test's zero is a real bypass, not an inert harness.
    expect(db.appendCalls + db.rpcCalls.length).toBeGreaterThan(0);
  });

  it("does not answer a neighbouring summary command", async () => {
    const db = seedDay(new FakeDatabase());
    const replies: string[] = [];

    await service(db, replies).processEvents(
      [textEvent("สรุปสินค้าขายดีรวม", "purchase-reply-3")],
      "destination",
    );

    expect(replies.join("\n")).not.toContain(PURCHASE_PLANNING_TITLE);
  });
});
