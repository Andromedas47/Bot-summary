/**
 * P0 regression — a valid explicit "seller-market เบิก date" header must always
 * reach the NEW Work Round creation path and must never be routed through an
 * existing-round / append resolver first.
 *
 * Root cause this guards against: a non-ASCII dash (en/em/fullwidth/…) between
 * seller and market made SELLER_MARKET fail, so the header was misclassified as
 * a generic header and rejected with "ไม่พบรายการที่เปิดอยู่" even though it was
 * a complete, valid new borrow header.
 *
 * Exact production payloads are used verbatim below.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase } from "@/lib/test-utils/mem-supabase";

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

function svc(db: ReturnType<typeof memSupabase>, replies: string[] = []) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

const HEADER       = "กี้-วัดทุ่งลานนา เบิก 26/06/2569";
const HEADER_ENDASH = "กี้\u2013วัดทุ่งลานนา เบิก 26/06/2569";
const HEADER_NO_MARKET = "กี้ เบิก 26/06/2569";
const HEADER_APPEND = "กี้-วัดทุ่งลานนา รายการเบิกเพิ่ม 26/06/2569";
const ITEMS_AND_END = "1.มะม่วง100บาท\n10โล\nจบรายการเบิก";

describe("P0 — valid explicit borrow header opens a new Work Round", () => {
  it("ASCII-hyphen header-only → ack opens borrow, no existing round required", async () => {
    const replies: string[] = [];
    const db = memSupabase(); // zero pre-existing work_rounds
    await svc(db, replies).processEvents([textEvent(HEADER)], "dest");

    expect(replies[0]).toContain("รับหัวเบิกแล้ว");
    expect(replies[0]).toContain("กี้ — วัดทุ่งลานนา");
    expect(replies[0]).not.toContain("ไม่พบรายการที่เปิดอยู่");
    expect(db._rows("pending_sessions")).toHaveLength(1);
  });

  it("ASCII-hyphen complete message → creates exactly one new Work Round", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents(
      [textEvent(`${HEADER}\n${ITEMS_AND_END}`)],
      "dest",
    );

    const rounds = db._rows("work_rounds");
    expect(rounds).toHaveLength(1);
    expect(rounds[0].seller_name).toBe("กี้");
    expect(rounds[0].market_name).toBe("วัดทุ่งลานนา");
    expect(db._rows("produce_sessions")).toHaveLength(1);
  });

  it("en-dash header-only → still opens borrow (was production bug)", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents([textEvent(HEADER_ENDASH)], "dest");

    expect(replies[0]).toContain("รับหัวเบิกแล้ว");
    expect(replies[0]).not.toContain("ไม่พบรายการที่เปิดอยู่");
    expect(db._rows("pending_sessions")).toHaveLength(1);
  });

  it("en-dash complete message → creates a new Work Round with clean identity", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents(
      [textEvent(`${HEADER_ENDASH}\n${ITEMS_AND_END}`)],
      "dest",
    );

    const rounds = db._rows("work_rounds");
    expect(rounds).toHaveLength(1);
    expect(rounds[0].seller_name).toBe("กี้");
    expect(rounds[0].market_name).toBe("วัดทุ่งลานนา");
  });
});

describe("P0 — incomplete seller-only borrow header stays rejected", () => {
  it("seller-only header → missing-market guidance, zero DB writes", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents([textEvent(HEADER_NO_MARKET)], "dest");

    // Rejected with missing-market guidance (no seller-market identity present).
    expect(replies[0]).toContain("ตลาด");
    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(db._rows("work_rounds")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
  });

  it("seller-only complete message → reject, zero DB writes", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents(
      [textEvent(`${HEADER_NO_MARKET}\n${ITEMS_AND_END}`)],
      "dest",
    );

    expect(db._rows("work_rounds")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });
});

describe("P0 — explicit append remains append-only", () => {
  it("รายการเบิกเพิ่ม with no existing round → does NOT create a Work Round", async () => {
    const replies: string[] = [];
    const db = memSupabase(); // no pre-existing rounds
    await svc(db, replies).processEvents(
      [textEvent(`${HEADER_APPEND}\n${ITEMS_AND_END}`)],
      "dest",
    );

    expect(db._rows("work_rounds")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(replies[0]).toContain("ไม่พบรอบเบิกที่ยังเปิดอยู่");
  });

  it("รายการเบิกเพิ่ม header-only with no existing round → rejected", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    await svc(db, replies).processEvents([textEvent(HEADER_APPEND)], "dest");

    expect(db._rows("work_rounds")).toHaveLength(0);
    expect(db._rows("pending_sessions")).toHaveLength(0);
  });
});
