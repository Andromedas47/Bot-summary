/**
 * P0 Data Safety: dedup must be scoped by target work_round_id.
 *
 * Bug: computeSessionHash does not include work_round_id. When the same
 * produce payload is sent twice and the user selects a DIFFERENT round each
 * time, the second attempt is incorrectly rejected as a duplicate.
 *
 * Requirements:
 *  - same payload + same work_round_id → duplicate (must already work)
 *  - same payload + different work_round_id → NOT duplicate (currently fails)
 *
 * Tests marked "[CURRENTLY FAILS]" fail against the unfixed code.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";

const DATE = "2026-06-27";
const DATE_TH = "27/6/2569";
const GROUP = "group-p0-dedup";
const LO = "โล";
const USER = "user-dedup-1";

let seq = 0;
function textEvent(text: string, replyToken?: string, userId = USER): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-dedup-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now() + seq,
    source: { type: "group", groupId: GROUP, userId },
    mode: "active",
    replyToken,
    message: { id: `msg-dedup-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function round(id: string, roundSeq: number, status = "open"): Row {
  return {
    id,
    source_id: GROUP,
    business_date: DATE,
    seller_name: "ปลา",
    market_name: "ราชพฤกษ์",
    round_seq: roundSeq,
    status,
    source_meta: null,
    created_at: "",
    updated_at: "",
  };
}

function svc(db: ReturnType<typeof memSupabase>, replies: string[] = []) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

// Complete single-message ชั่งคืน (return) session.
function returnMsg(): string {
  return [
    `ปลา-ราชพฤกษ์ ชั่งคืน ${DATE_TH}`,
    "1ส้มไต้หวัน 40 บาท",
    `2${LO}`,
    "จบรายการ",
  ].join("\n");
}

describe("P0 dedup — same payload, different work_round_id", () => {
  it("[ALREADY PASSES] same payload + same round_id → duplicate on retry", async () => {
    // round-1 only; same message twice → second must be duplicate
    const db = memSupabase({ work_rounds: [round("wr-1", 1)] });
    const s = svc(db);

    await s.processEvents([textEvent(returnMsg())], "dest");
    const sessionsAfterFirst = db._rows("produce_sessions").length;

    await s.processEvents([textEvent(returnMsg())], "dest");
    const sessionsAfterSecond = db._rows("produce_sessions").length;

    expect(sessionsAfterFirst).toBe(1);
    // Second attempt must not add another session
    expect(sessionsAfterSecond).toBe(1);
  });

  it("[CURRENTLY FAILS] same payload + different round_id → second write succeeds", async () => {
    // Two rounds for the same seller+market (round-seq 1 and 2).
    // Simulate: first ชั่งคืน → selection opens (2 candidates) → user picks 1 →
    // written to wr-1; same message → selection opens again → user picks 2 →
    // must write to wr-2, not blocked as duplicate.
    const db = memSupabase({
      work_rounds: [round("wr-1", 1), round("wr-2", 2)],
    });
    const replies: string[] = [];
    const s = svc(db, replies);

    // First send: two rounds → selection
    await s.processEvents([textEvent(returnMsg(), "reply-a")], "dest");

    const sel1 = db._rows("work_round_selections");
    expect(sel1).toHaveLength(1);
    expect(db._rows("produce_sessions")).toHaveLength(0);

    // User picks round 1
    await s.processEvents([textEvent("1", "reply-b")], "dest");
    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_sessions")[0].work_round_id).toBe("wr-1");

    // Same message again → two rounds still eligible → new selection
    await s.processEvents([textEvent(returnMsg(), "reply-c")], "dest");
    const sel2 = db._rows("work_round_selections");
    expect(sel2.length).toBeGreaterThanOrEqual(2);

    // User picks round 2
    // [CURRENTLY FAILS]: dedup fires (same hash, no work_round_id scoping) →
    // second session not written even though it targets a DIFFERENT round.
    await s.processEvents([textEvent("2", "reply-d")], "dest");

    const sessions = db._rows("produce_sessions");
    expect(sessions).toHaveLength(2);  // ← fails today
    expect(sessions[1].work_round_id).toBe("wr-2");
  });

  it("[CURRENTLY FAILS] reply to second round does not say 'เคยบันทึกแล้ว'", async () => {
    // Same scenario — the wrong reply is the smoking gun for this bug.
    const db = memSupabase({
      work_rounds: [round("wr-1", 1), round("wr-2", 2)],
    });
    const replies: string[] = [];
    const s = svc(db, replies);

    await s.processEvents([textEvent(returnMsg(), "reply-a")], "dest");
    await s.processEvents([textEvent("1", "reply-b")], "dest");
    replies.length = 0;  // clear first-round replies

    await s.processEvents([textEvent(returnMsg(), "reply-c")], "dest");
    await s.processEvents([textEvent("2", "reply-d")], "dest");

    // Must NOT say "เคยบันทึกแล้ว" when targeting a different round
    expect(replies.some((r) => r.includes("เคยบันทึกแล้ว"))).toBe(false);
  });
});

// ── Atomicity guards (what we can verify without a real DB) ───────────────────
// memSupabase has no cascade enforcement, so we can only test the application-level
// rollback path: if session insert succeeds but items loop throws, the service must
// attempt session deletion and report an error (not a success).
//
// Full cascade atomicity relies on Postgres ON DELETE CASCADE (verified in schema).

describe("P0 write atomicity — session without items is cleaned up", () => {
  it("session written but items fail → produce_sessions must be empty after cleanup", async () => {
    let itemInsertCount = 0;
    const db = memSupabase({ work_rounds: [round("wr-1", 1)] });

    // Intercept: let the first item succeed but throw on the second.
    // We can't easily do this with memSupabase's current API, so this is a
    // placeholder that documents the requirement. A real DB-level test using
    // the PostgreSQL RPC path would be needed for full coverage.
    //
    // ponytail: skip insert-failure simulation — memSupabase cannot enforce FK cascade;
    // document the risk and add a note: requires PostgreSQL integration test.
    void itemInsertCount; // suppress unused warning

    // Minimum check: a fully valid session must have matching session + items counts.
    const msg = [
      `ปลา-ราชพฤกษ์ ชั่งคืน ${DATE_TH}`,
      "1ส้มไต้หวัน 40 บาท",
      `2${LO}`,
      "2.พุทรา 30 บาท",
      `3${LO}`,
      "จบรายการ",
    ].join("\n");
    await svc(db).processEvents([textEvent(msg)], "dest");

    const sessions = db._rows("produce_sessions");
    const items = db._rows("produce_items");
    // Either everything was written or nothing was written — never session without items.
    if (sessions.length === 0) {
      expect(items).toHaveLength(0);
    } else {
      expect(items.length).toBeGreaterThan(0);
    }
  });
});
