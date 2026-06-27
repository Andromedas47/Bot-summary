/**
 * P0 Data Safety: parse gate must block ALL writes when the session is incomplete.
 *
 * Requirements:
 *  - parse_errors (orphan quantity, unrecognized lines) → no session, no items, no dedup record
 *  - item header with no quantity (trailing pending) → no write
 *  - valid items + unrecognized line → no write
 *
 * Tests marked "[CURRENTLY FAILS]" fail against the unfixed code and must be made
 * green by the P0 fix. Tests marked "[ALREADY PASSES]" are regression guards.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase } from "@/lib/test-utils/mem-supabase";

const DATE = "27/6/2569";
const GROUP = "group-p0-parse";
const LO = "โล";

let seq = 0;
function textEvent(text: string, replyToken?: string): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-parse-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    source: { type: "group", groupId: GROUP, userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `msg-parse-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function svc(db: ReturnType<typeof memSupabase>, replies: string[] = []) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

// ── Orphan quantity ────────────────────────────────────────────────────────────
// "2โล" on a line with no preceding item header goes to parse_errors, not
// review_issues. P0 requires: any parse_errors → no write.

describe("P0 parse gate — orphan quantity", () => {
  it("[CURRENTLY FAILS] orphan quantity after valid item → no session written", async () => {
    // "1ส้มไต้หวัน 40 บาท" + "2โล" → item finalized (quantity attached)
    // "15โล" → orphan (no pendingItem) → parse_errors → must block write
    const db = memSupabase();
    const msg = [
      `ปลา-ราชพฤกษ์ เบิก ${DATE}`,
      "1ส้มไต้หวัน 40 บาท",
      `2${LO}`,
      `15${LO}`,    // orphan: item 1 is already finalized
      "จบรายการเบิก",
    ].join("\n");

    await svc(db).processEvents([textEvent(msg)], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    expect(db._rows("imported_sessions")).toHaveLength(0);
  });

  it("[CURRENTLY FAILS] orphan quantity with no preceding item at all → no session written", async () => {
    // First line is a bare quantity with no item header above it.
    const db = memSupabase();
    const msg = [
      `ปลา-ราชพฤกษ์ เบิก ${DATE}`,
      `5${LO}`,             // orphan: no item above
      "1ส้มไต้หวัน 40 บาท",
      `2${LO}`,
      "จบรายการเบิก",
    ].join("\n");

    await svc(db).processEvents([textEvent(msg)], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("[CURRENTLY FAILS] reply tells user to fix list when orphan quantity present", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    const msg = [
      `ปลา-ราชพฤกษ์ เบิก ${DATE}`,
      "1ส้มไต้หวัน 40 บาท",
      `2${LO}`,
      `15${LO}`,
      "จบรายการเบิก",
    ].join("\n");

    await svc(db, replies).processEvents([textEvent(msg, "reply-tok")], "dest");

    // Must reply with a correction prompt, never with a success summary.
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain("บันทึกแล้ว");
    expect(replies[0]).not.toContain("รายการนี้เคยบันทึกแล้ว");
  });
});

// ── Valid item + unrecognized line → no write ──────────────────────────────────
// An unrecognized non-indexed line goes to parse_errors. P0 requires block.

describe("P0 parse gate — valid item + unrecognized line", () => {
  it("[CURRENTLY FAILS] valid item + truly unrecognized line → no session written", async () => {
    const db = memSupabase();
    // "กรอกผิด" is not a section keyword, item, or quantity → parse_errors
    const msg = [
      `ปลา-ราชพฤกษ์ เบิก ${DATE}`,
      "1ส้มไต้หวัน 40 บาท",
      `2${LO}`,
      "กรอกผิดบรรทัดนี้ขอแก้",  // unrecognized → parse_errors
      "จบรายการเบิก",
    ].join("\n");

    await svc(db).processEvents([textEvent(msg)], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });
});

// ── Item header with no quantity → no write ───────────────────────────────────
// When the session closes and a pendingItem still has no quantity, the parser
// currently finishes the item at SESSION_END without checking for missing quantity
// (it should add a review_issue or the write layer should block null-quantity items).
// Both the single-message and the multi-message paths hit this gap.

describe("P0 parse gate — item header without quantity", () => {
  it("[CURRENTLY FAILS] single-message: item with no quantity line → no session written", async () => {
    const db = memSupabase();
    const msg = [
      `ปลา-ราชพฤกษ์ เบิก ${DATE}`,
      "1ส้มไต้หวัน 40 บาท",  // item header only, no quantity line
      "จบรายการเบิก",          // closes before quantity arrives
    ].join("\n");

    await svc(db).processEvents([textEvent(msg)], "dest");

    // Currently writes a session with a null-quantity item — must be blocked.
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });

  it("[CURRENTLY FAILS] produce_items must never have null quantity", async () => {
    const db = memSupabase();
    const msg = [
      `ปลา-ราชพฤกษ์ เบิก ${DATE}`,
      "1ส้มไต้หวัน 40 บาท",
      "จบรายการเบิก",
    ].join("\n");

    await svc(db).processEvents([textEvent(msg)], "dest");

    const items = db._rows("produce_items");
    // If anything was written (current bug) the item has null quantity — both are wrong.
    expect(items.every((i) => i.quantity !== null && (i.quantity as number) > 0)).toBe(true);
  });
});

// ── Partial write during multi-message pending session ─────────────────────────
// When accumulation contains parse_errors, finalize must not write.

describe("P0 parse gate — pending session with parse_errors on close", () => {
  it("[CURRENTLY FAILS] multi-message session with orphan quantity on close → no session", async () => {
    const db = memSupabase();

    await svc(db).processEvents(
      [textEvent(`ปลา-ราชพฤกษ์ เบิก ${DATE}`)],
      "dest",
    );
    await svc(db).processEvents(
      [textEvent(`1ส้มไต้หวัน 40 บาท\n2${LO}`)],
      "dest",
    );
    await svc(db).processEvents(
      // orphan quantity + close in the same message
      [textEvent(`15${LO}\nจบรายการเบิก`)],
      "dest",
    );

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });
});
