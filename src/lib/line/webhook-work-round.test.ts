/**
 * Integration tests for the V2 Work-Round-gated webhook flows.
 *
 * Uses the in-memory Supabase double and omits replyToken so no LINE network
 * calls happen — assertions are made against the resulting DB rows.
 *
 * Covers the P0/P1 guarantees:
 *  - explicit complete session creates + attaches a Work Round
 *  - generic complete session with ONE open round attaches and persists
 *  - generic complete session with NO round persists NOTHING
 *  - generic complete session with MULTIPLE rounds persists NOTHING + opens selection
 *  - append return (ชั่งคืนเพิ่ม) creates a separate session, prior rows untouched
 *  - settlement command with multiple rounds NEVER auto-selects (selection only)
 *  - numeric reply resolves a pending selection
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";
const MESSAGE_DATE = "2026-06-24";

// A complete, parseable produce message (header + 1 item + quantity + end).
function produceMsg(header: string): string {
  return [header, "1.มะม่วง100บาท", "10โล", "จบรายการเบิก"].join("\n");
}

let seq = 0;
function textEvent(text: string, userId = "user-1"): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    source: { type: "group", groupId: "group-1", userId },
    mode: "active",
    // No replyToken → no network replies; we assert on DB state.
    message: { id: `msg-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function openRound(over: Record<string, unknown> = {}): Row {
  return {
    id: `wr-${Math.random().toString(36).slice(2, 8)}`,
    source_id: "group-1", business_date: MESSAGE_DATE,
    seller_name: "กี้", market_name: "วัดทุ่ง", round_seq: 1, status: "open",
    source_meta: null, created_at: "", updated_at: "",
    ...over,
  };
}

function svc(db: ReturnType<typeof memSupabase>) {
  return new WebhookService(db as never, { produceEndSettleMs: 0 });
}

describe("WebhookService — Work Round gated produce", () => {
  it("explicit complete session creates and attaches a Work Round", async () => {
    const db = memSupabase();
    await svc(db).processEvents([textEvent(produceMsg("กี้-วัดทุ่ง เบิก 24/06/2569"))], "dest");

    const sessions = db._rows("produce_sessions");
    const rounds   = db._rows("work_rounds");
    expect(sessions).toHaveLength(1);
    expect(rounds).toHaveLength(1);
    expect(sessions[0].work_round_id).toBe(rounds[0].id as string);
    expect(rounds[0].business_date).toBe("2026-06-24");
    expect(sessions[0].is_append_session).toBe(false);
  });

  it("generic complete session with ONE open round attaches and persists", async () => {
    const round = openRound();
    const db = memSupabase({ work_rounds: [round] });
    await svc(db).processEvents([textEvent(produceMsg("รายการชั่งเบิก 24/06/2569"))], "dest");

    const sessions = db._rows("produce_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].work_round_id).toBe(round.id as string);
    // No new round created — attached to the existing one.
    expect(db._rows("work_rounds")).toHaveLength(1);
  });

  it("generic complete session with NO round persists NOTHING", async () => {
    const db = memSupabase({ work_rounds: [] });
    await svc(db).processEvents([textEvent(produceMsg("รายการชั่งเบิก 24/06/2569"))], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    expect(db._rows("work_round_selections")).toHaveLength(0);
  });

  it("generic complete session with MULTIPLE rounds persists NOTHING and opens a selection", async () => {
    const db = memSupabase({
      work_rounds: [
        openRound({ id: "wr-a", seller_name: "กี้",   market_name: "A" }),
        openRound({ id: "wr-b", seller_name: "พี่ดำ", market_name: "B" }),
      ],
    });
    await svc(db).processEvents([textEvent(produceMsg("รายการชั่งเบิก 24/06/2569"))], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    const sels = db._rows("work_round_selections");
    expect(sels).toHaveLength(1);
    expect(sels[0].intent).toBe("produce_attach");
    expect(sels[0].status).toBe("pending");
  });

  it("append return (ชั่งคืนเพิ่ม) creates a separate session and does not mutate prior rows", async () => {
    const round = openRound();
    const db = memSupabase({
      work_rounds: [round],
      produce_sessions: [{ id: "prior", work_round_id: round.id, is_append_session: false, staff_name: "กี้" }],
    });
    const msg = ["ชั่งคืนเพิ่ม 24/06/2569", "1.มะม่วง50บาท", "5โล", "จบรายการคืน"].join("\n");
    await svc(db).processEvents([textEvent(msg)], "dest");

    const sessions = db._rows("produce_sessions");
    expect(sessions).toHaveLength(2); // prior + new append
    const appendSession = sessions.find((s) => s.id !== "prior");
    expect(appendSession?.is_append_session).toBe(true);
    expect(appendSession?.work_round_id).toBe(round.id as string);
    // prior row untouched
    expect(sessions.find((s) => s.id === "prior")?.is_append_session).toBe(false);
    // items carry ชั่งคืนเพิ่ม transaction type
    expect(db._rows("produce_items").some((i) => i.transaction_type === "ชั่งคืนเพิ่ม")).toBe(true);
  });

  it("append return after close moves the round to needs_correction", async () => {
    const db = memSupabase({
      work_rounds: [openRound({ id: "wr-a", status: "awaiting_settlement" })],
      produce_sessions: [{ id: "prior", work_round_id: "wr-a", is_append_session: false, staff_name: "กี้" }],
    });
    const msg = ["กี้-วัดทุ่ง ชั่งคืนเพิ่ม 24/06/2569", "1.มะม่วง50บาท", "5โล", "จบรายการคืน"].join("\n");
    await svc(db).processEvents([textEvent(msg)], "dest");

    expect(db._rows("produce_sessions").find((s) => s.id !== "prior")?.work_round_id).toBe("wr-a");
    expect(db._rows("work_rounds")[0].status).toBe("needs_correction");
  });

  it("append return after submitted settlement moves the round to needs_correction", async () => {
    const db = memSupabase({
      work_rounds: [openRound({ id: "wr-a", status: "awaiting_slips" })],
      produce_sessions: [{ id: "prior", work_round_id: "wr-a", is_append_session: false, staff_name: "กี้" }],
    });
    const msg = ["กี้-วัดทุ่ง ชั่งคืนเพิ่ม 24/06/2569", "1.มะม่วง50บาท", "5โล", "จบรายการคืน"].join("\n");
    await svc(db).processEvents([textEvent(msg)], "dest");

    expect(db._rows("produce_sessions").find((s) => s.id !== "prior")?.work_round_id).toBe("wr-a");
    expect(db._rows("work_rounds")[0].status).toBe("needs_correction");
  });

  it("append return after approval is blocked and does not create a session", async () => {
    const db = memSupabase({
      work_rounds: [openRound({ id: "wr-a", status: "approved" })],
      produce_sessions: [{ id: "prior", work_round_id: "wr-a", is_append_session: false, staff_name: "กี้" }],
    });
    const msg = ["กี้-วัดทุ่ง ชั่งคืนเพิ่ม 24/06/2569", "1.มะม่วง50บาท", "5โล", "จบรายการคืน"].join("\n");
    await svc(db).processEvents([textEvent(msg)], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("work_rounds")[0].status).toBe("approved");
  });
});

describe("WebhookService — settlement never auto-selects", () => {
  it("blocks settlement while the work round is still open", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" },
      ],
    });
    await svc(db).processEvents([textEvent("ส่งเงิน 24/06/2569")], "dest");

    expect(db._rows("settlement_drafts")).toHaveLength(0);
  });

  it("close-round command requires confirmation before settlement is allowed", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" },
      ],
    });
    const s = svc(db);
    await s.processEvents([textEvent("ปิดรอบ 24/06/2569")], "dest");
    expect(db._rows("work_rounds")[0].status).toBe("open");
    expect(db._rows("work_round_selections")[0].intent).toBe("close_round_confirm");

    await s.processEvents([textEvent("ยืนยันปิดรอบ")], "dest");
    expect(db._rows("work_rounds")[0].status).toBe("awaiting_settlement");

    await s.processEvents([textEvent("ส่งเงิน 24/06/2569")], "dest");
    expect(db._rows("settlement_drafts")).toHaveLength(1);
  });

  it("close-round selection supports multiple open rounds", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้",   market_name: "A", round_seq: 1, status: "open" },
        { id: "wr-b", source_id: "group-1", business_date: "2026-06-24", seller_name: "พี่ดำ", market_name: "B", round_seq: 1, status: "open" },
      ],
    });
    const s = svc(db);
    await s.processEvents([textEvent("ปิดรอบ 24/06/2569")], "dest");
    expect(db._rows("work_round_selections")[0].intent).toBe("close_round");
    await s.processEvents([textEvent("2")], "dest");
    expect(db._rows("work_rounds").find((r) => r.id === "wr-b")?.status).toBe("open");
    expect(db._rows("work_round_selections").at(-1)?.intent).toBe("close_round_confirm");
    await s.processEvents([textEvent("ยืนยันปิดรอบ")], "dest");
    expect(db._rows("work_rounds").find((r) => r.id === "wr-b")?.status).toBe("awaiting_settlement");
    expect(db._rows("work_rounds").find((r) => r.id === "wr-a")?.status).toBe("open");
  });

  it("multiple eligible rounds → pending selection, NO draft created", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้",   market_name: "A", round_seq: 1, status: "awaiting_settlement" },
        { id: "wr-b", source_id: "group-1", business_date: "2026-06-24", seller_name: "พี่ดำ", market_name: "B", round_seq: 1, status: "awaiting_settlement" },
      ],
    });
    await svc(db).processEvents([textEvent("ส่งเงิน 24/06/2569")], "dest");

    expect(db._rows("settlement_drafts")).toHaveLength(0);
    const sels = db._rows("work_round_selections");
    expect(sels).toHaveLength(1);
    expect(sels[0].intent).toBe("settlement");
  });

  it("single eligible round → opens a draft (no selection)", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "awaiting_settlement" },
      ],
    });
    await svc(db).processEvents([textEvent("ส่งเงิน 24/06/2569")], "dest");

    expect(db._rows("work_round_selections")).toHaveLength(0);
    const drafts = db._rows("settlement_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].work_round_id).toBe("wr-a");
  });

  it("numeric reply resolves a settlement selection and opens the chosen draft", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้",   market_name: "A", round_seq: 1, status: "awaiting_settlement" },
        { id: "wr-b", source_id: "group-1", business_date: "2026-06-24", seller_name: "พี่ดำ", market_name: "B", round_seq: 1, status: "awaiting_settlement" },
      ],
    });
    const s = svc(db);
    await s.processEvents([textEvent("ส่งเงิน 24/06/2569")], "dest");
    await s.processEvents([textEvent("2")], "dest"); // choose พี่ดำ — B

    const drafts = db._rows("settlement_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].work_round_id).toBe("wr-b");
    expect(db._rows("work_round_selections")[0].status).toBe("resolved");
  });

  it("a DIFFERENT sender's numeric reply does not resolve the selection", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้",   market_name: "A", round_seq: 1, status: "awaiting_settlement" },
        { id: "wr-b", source_id: "group-1", business_date: "2026-06-24", seller_name: "พี่ดำ", market_name: "B", round_seq: 1, status: "awaiting_settlement" },
      ],
    });
    const s = svc(db);
    await s.processEvents([textEvent("ส่งเงิน 24/06/2569", "user-1")], "dest");
    await s.processEvents([textEvent("2", "user-2")], "dest"); // different sender

    expect(db._rows("settlement_drafts")).toHaveLength(0);
    expect(db._rows("work_round_selections")[0].status).toBe("pending");
  });
});

describe("WebhookService — multi-message settlement", () => {
  it("opens draft, records amounts in a later message, then confirms", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "awaiting_settlement" },
      ],
    });
    const s = svc(db);
    await s.processEvents([textEvent("ส่งเงิน 24/06/2569")], "dest");
    expect(db._rows("settlement_drafts")[0].status).toBe("pending");

    await s.processEvents([textEvent("โอน 730 สด 1420 ค่าใช้จ่าย 410 ค่าแรง 400")], "dest");
    const declared = db._rows("settlement_drafts")[0];
    expect(declared.status).toBe("declared");
    expect(declared.declared_transfer).toBe(730);

    await s.processEvents([textEvent("ยืนยันส่งเงิน")], "dest");
    const submitted = db._rows("settlement_drafts")[0];
    expect(submitted.status).toBe("submitted");
    // round advanced to awaiting_slips
    expect(db._rows("work_rounds")[0].status).toBe("awaiting_slips");
  });

  it("a different sender cannot declare amounts on someone else's draft", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "awaiting_settlement" },
      ],
    });
    const s = svc(db);
    await s.processEvents([textEvent("ส่งเงิน 24/06/2569", "user-1")], "dest");
    await s.processEvents([textEvent("โอน 999", "user-2")], "dest");

    const draft = db._rows("settlement_drafts")[0];
    expect(draft.status).toBe("pending");          // untouched
    expect(draft.declared_transfer ?? null).toBeNull();
  });
});
