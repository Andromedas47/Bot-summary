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
import { computeRoundTotals } from "@/lib/work-round/expected-sales";
import type { WorkRoundStatus } from "@/lib/work-round/types";
const MESSAGE_DATE = "2026-06-24";

// A complete, parseable produce message (header + 1 item + quantity + end).
function produceMsg(header: string): string {
  return [header, "1.มะม่วง100บาท", "10โล", "จบรายการเบิก"].join("\n");
}

let seq = 0;
function textEvent(text: string, userId = "user-1", replyToken?: string): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    source: { type: "group", groupId: "group-1", userId },
    mode: "active",
    replyToken,
    // Most tests omit replyToken → no network replies; assertions are made on DB state.
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

// ── ชั่งคืนเพิ่ม eligibility is an explicit allowlist over the status enum ──────
//
// Every WorkRoundStatus is covered exactly once across these two arrays, so a new
// enum member forces an update here (and the unit-level exhaustiveness test fails).
const RETURN_APPEND_ELIGIBLE: WorkRoundStatus[] = [
  "open", "produce_complete", "awaiting_settlement", "awaiting_slips", "needs_correction",
];
const RETURN_APPEND_NON_ELIGIBLE: WorkRoundStatus[] = [
  "approved", "variance_found", "ready_for_review",
];
// Statuses where a successful return append reopens the round to needs_correction.
const REOPEN_TO_CORRECTION: WorkRoundStatus[] = [
  "awaiting_settlement", "awaiting_slips", "needs_correction",
];

function returnAppendMsg(): string {
  return ["กี้-วัดทุ่ง ชั่งคืนเพิ่ม 24/06/2569", "1.มะม่วง50บาท", "5โล", "จบรายการคืน"].join("\n");
}

describe("WebhookService — ชั่งคืนเพิ่ม eligibility allowlist", () => {
  for (const status of RETURN_APPEND_ELIGIBLE) {
    it(`accepts return append on ${status} (creates append session)`, async () => {
      const db = memSupabase({
        work_rounds: [openRound({ id: "wr-a", status })],
        produce_sessions: [{ id: "prior", work_round_id: "wr-a", is_append_session: false, staff_name: "กี้" }],
      });
      await svc(db).processEvents([textEvent(returnAppendMsg())], "dest");

      const sessions = db._rows("produce_sessions");
      expect(sessions).toHaveLength(2); // prior + new append
      const appendSession = sessions.find((s) => s.id !== "prior");
      expect(appendSession?.is_append_session).toBe(true);
      expect(appendSession?.work_round_id).toBe("wr-a");
      expect(db._rows("produce_items").some((i) => i.transaction_type === "ชั่งคืนเพิ่ม")).toBe(true);

      const expectedStatus = REOPEN_TO_CORRECTION.includes(status) ? "needs_correction" : status;
      expect(db._rows("work_rounds")[0].status).toBe(expectedStatus);
    });
  }

  for (const status of RETURN_APPEND_NON_ELIGIBLE) {
    it(`rejects return append on ${status} (no session, item, selection, or total change)`, async () => {
      const db = memSupabase({
        work_rounds: [openRound({ id: "wr-a", status })],
        produce_sessions: [{ id: "prior", work_round_id: "wr-a", is_append_session: false, staff_name: "กี้" }],
        produce_items: [
          { id: "it-1", session_id: "prior", item_number: 1, product_name: "มะม่วง", transaction_type: "เบิก", price_per_unit: 100, quantity: 10 },
        ],
      });

      const borrowBefore = (await computeRoundTotals(db as never, "wr-a")).borrow;
      expect(borrowBefore).toBeCloseTo(1000, 2);

      await svc(db).processEvents([textEvent(returnAppendMsg())], "dest");

      // No new session and no new item — only the seeded rows remain.
      expect(db._rows("produce_sessions")).toHaveLength(1);
      expect(db._rows("produce_items")).toHaveLength(1);
      // No pending session and no selection opened.
      expect(db._rows("pending_sessions")).toHaveLength(0);
      expect(db._rows("work_round_selections")).toHaveLength(0);
      // Status untouched and totals unchanged.
      expect(db._rows("work_rounds")[0].status).toBe(status);
      const borrowAfter = (await computeRoundTotals(db as never, "wr-a")).borrow;
      expect(borrowAfter).toBeCloseTo(borrowBefore, 2);
      expect((await computeRoundTotals(db as never, "wr-a")).ret).toBe(0);
    });
  }
});

describe("WebhookService — settlement never auto-selects", () => {
  it("close-round prompt shows borrow, return, bad return, and expected sales before confirmation", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" },
      ],
      produce_sessions: [
        { id: "borrow-session", work_round_id: "wr-a" },
        { id: "return-session", work_round_id: "wr-a" },
        { id: "bad-return-session", work_round_id: "wr-a" },
      ],
      produce_items: [
        { id: "i1", session_id: "borrow-session", transaction_type: "เบิก", product_name: "มะม่วง", quantity: 10, price_per_unit: 100 },
        { id: "i2", session_id: "return-session", transaction_type: "คืน", product_name: "มะม่วง", quantity: 2, price_per_unit: 100 },
        { id: "i3", session_id: "bad-return-session", transaction_type: "คืนเสีย", product_name: "มะม่วง", quantity: 1, price_per_unit: 100 },
      ],
    });
    const s = new WebhookService(db as never, {
      produceEndSettleMs: 0,
      replyMessage: async (_replyToken, text) => { replies.push(text); },
    });

    await s.processEvents([textEvent("ปิดรอบ 24/06/2569", "user-1", "reply-1")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("กี้ — A");
    expect(replies[0]).toContain("24 มิถุนายน 2569");
    expect(replies[0]).toContain("ยอดเบิก: 1,000.00 บาท");
    expect(replies[0]).toContain("ยอดชั่งคืน: 200.00 บาท");
    expect(replies[0]).toContain("ยอดคืนเสีย: 100.00 บาท");
    expect(replies[0]).toContain("ยอดที่ต้องขายได้: 700.00 บาท");
    expect(replies[0]).toContain("ยืนยันปิดรอบ");
    expect(replies[0]).not.toContain("เกิน");
    expect(replies[0]).not.toContain("ขาด");
  });

  it("close-round prompt treats missing returns as zero", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" },
      ],
      produce_sessions: [
        { id: "borrow-session", work_round_id: "wr-a" },
      ],
      produce_items: [
        { id: "i1", session_id: "borrow-session", transaction_type: "เบิก", product_name: "มะม่วง", quantity: 10, price_per_unit: 100 },
      ],
    });
    const s = new WebhookService(db as never, {
      produceEndSettleMs: 0,
      replyMessage: async (_replyToken, text) => { replies.push(text); },
    });

    await s.processEvents([textEvent("ปิดรอบ 24/06/2569", "user-1", "reply-1")], "dest");

    expect(replies[0]).toContain("ยอดเบิก: 1,000.00 บาท");
    expect(replies[0]).toContain("ยอดชั่งคืน: 0.00 บาท");
    expect(replies[0]).toContain("ยอดคืนเสีย: 0.00 บาท");
    expect(replies[0]).toContain("ยอดที่ต้องขายได้: 1,000.00 บาท");
  });

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

  it("records a same-line bare transfer amount without finalizing", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "awaiting_settlement" },
      ],
    });

    await svc(db).processEvents([textEvent("ส่งเงิน 24/06/2569 1925 บาท")], "dest");

    const draft = db._rows("settlement_drafts")[0];
    expect(draft.status).toBe("declared");
    expect(draft.declared_transfer).toBe(1925);
    expect(db._rows("settlement_finalizations")).toHaveLength(0);
  });

  it("records a two-line bare transfer amount without finalizing", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24", seller_name: "กี้", market_name: "A", round_seq: 1, status: "awaiting_settlement" },
      ],
    });

    await svc(db).processEvents([textEvent("ส่งเงิน 24/06/2569\n1925")], "dest");

    const draft = db._rows("settlement_drafts")[0];
    expect(draft.status).toBe("declared");
    expect(draft.declared_transfer).toBe(1925);
    expect(db._rows("settlement_finalizations")).toHaveLength(0);
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

describe("WebhookService — incident regression for canonical Work Round resolver", () => {
  it("keeps borrow, seller-only returns, close, settlement, and slip on one Work Round", async () => {
    const db = memSupabase();
    const replies: string[] = [];
    const s = new WebhookService(db as never, {
      produceEndSettleMs: 0,
      replyMessage: async (_replyToken, text) => { replies.push(text); },
    });

    await s.processEvents([textEvent("กี้-วัดทุ่งลานนา เบิก 25/6/2569", "seller-1")], "dest");
    await s.processEvents([textEvent("1หมอนทอง129บาท", "seller-1")], "dest");
    await s.processEvents([textEvent("10โล", "seller-1")], "dest");
    await s.processEvents([textEvent("จบรายการเบิก", "seller-1")], "dest");

    const round = db._rows("work_rounds")[0];
    expect(round.source_id).toBe("group-1");
    expect(round.business_date).toBe("2026-06-25");
    expect(round.seller_name).toBe("กี้");
    expect(round.market_name).toBe("วัดทุ่งลานนา");

    await s.processEvents([textEvent("กี้ ชั่งคืน 25/6/2569", "seller-1")], "dest");
    await s.processEvents([textEvent("1หมอนทอง129บาท", "seller-1")], "dest");
    await s.processEvents([textEvent("2โล", "seller-1")], "dest");
    await s.processEvents([textEvent("จบรายการ", "seller-1")], "dest");

    await s.processEvents([textEvent("กี้ คืนเสีย 25/6/2569", "seller-1")], "dest");
    await s.processEvents([textEvent("1หมอนทอง129บาท", "seller-1")], "dest");
    await s.processEvents([textEvent("1โล", "seller-1")], "dest");
    await s.processEvents([textEvent("จบรายการ", "seller-1")], "dest");

    const workRoundId = round.id as string;
    const sessions = db._rows("produce_sessions");
    expect(sessions).toHaveLength(3);
    expect(sessions.every((session) => session.work_round_id === workRoundId)).toBe(true);

    const totals = await computeRoundTotals(db as never, workRoundId);
    expect(totals.borrow).toBeCloseTo(1290, 2);
    expect(totals.ret).toBeCloseTo(258, 2);
    expect(totals.badReturn).toBeCloseTo(129, 2);
    expect(totals.expected).toBeCloseTo(903, 2);

    await s.processEvents([textEvent("ปิดรอบ 25/6/2569", "seller-1", "close-reply")], "dest");
    expect(replies.at(-1)).toContain("กี้");
    expect(replies.at(-1)).toContain("วัดทุ่งลานนา");
    expect(replies.at(-1)).toContain("ยอดที่ต้องขายได้: 903.00 บาท");
    expect(db._rows("work_rounds")[0].status).toBe("open");

    await s.processEvents([textEvent("ยืนยันปิดรอบ", "seller-1")], "dest");
    expect(db._rows("work_rounds")[0].status).toBe("awaiting_settlement");

    await s.processEvents([textEvent("ส่งเงิน 25/6/2569 903 บาท", "seller-1")], "dest");
    const draft = db._rows("settlement_drafts")[0];
    expect(draft.work_round_id).toBe(workRoundId);
    expect(draft.declared_transfer).toBe(903);
    expect(draft.status).toBe("declared");

    await s.processEvents([textEvent("ยืนยันส่งเงิน", "seller-1")], "dest");
    expect(db._rows("work_rounds")[0].status).toBe("awaiting_slips");

    await s.processEvents([textEvent("กี้ วัดทุ่งลานนา สลิปเงินโอน 25/6/2569", "seller-1")], "dest");
    const batches = db._rows("slip_batches");
    expect(batches).toHaveLength(1);
    expect(batches[0].work_round_id).toBe(workRoundId);
    expect(batches[0].seller_name).toBe("กี้");
    expect(batches[0].market_name).toBe("วัดทุ่งลานนา");

    expect(db._rows("produce_sessions").some((session) => session.work_round_id == null)).toBe(false);
    expect(db._rows("slip_batches").some((batch) => batch.work_round_id == null)).toBe(false);
    expect(db._rows("settlement_finalizations")).toHaveLength(0);
  });

  it("does not auto-pick a seller-only return when the seller has multiple open rounds", async () => {
    const db = memSupabase({
      work_rounds: [
        openRound({ id: "wr-a", business_date: "2026-06-25", seller_name: "กี้", market_name: "วัดทุ่งลานนา" }),
        openRound({ id: "wr-b", business_date: "2026-06-25", seller_name: "กี้", market_name: "อีกตลาด" }),
      ],
    });

    await svc(db).processEvents([
      textEvent(["กี้ ชั่งคืน 25/6/2569", "1หมอนทอง129บาท", "2โล", "จบรายการ"].join("\n")),
    ], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    const selections = db._rows("work_round_selections");
    expect(selections).toHaveLength(1);
    expect(selections[0].intent).toBe("produce_attach");
  });

  it("uses V2 actionable wording when slips are sent before the round can accept evidence", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [
        openRound({ id: "wr-a", business_date: "2026-06-25", seller_name: "กี้", market_name: "วัดทุ่งลานนา", status: "open" }),
      ],
    });
    const s = new WebhookService(db as never, {
      produceEndSettleMs: 0,
      replyMessage: async (_replyToken, text) => { replies.push(text); },
    });

    await s.processEvents([textEvent("กี้ วัดทุ่งลานนา สลิปเงินโอน 25/6/2569", "seller-1", "slip-reply")], "dest");

    expect(db._rows("slip_batches")).toHaveLength(0);
    expect(replies[0]).toContain("พบรอบงานของ กี้");
    expect(replies[0]).toContain("ยังไม่พร้อมรับสลิป");
    expect(replies[0]).not.toContain("ไม่พบงวดที่เปิดอยู่");
  });
});

describe("WebhookService — ยืนยันปิดรอบ confirmation", () => {
  function svcR(db: ReturnType<typeof memSupabase>, replies: string[]) {
    return new WebhookService(db as never, {
      produceEndSettleMs: 0,
      replyMessage: async (_tok, text) => { replies.push(text); },
    });
  }

  it("ปิดรอบ → ยืนยันปิดรอบ transitions round to awaiting_settlement", async () => {
    const db = memSupabase({
      work_rounds: [{ id: "wr-a", source_id: "group-1", business_date: MESSAGE_DATE, seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" }],
    });
    const s = svc(db);
    await s.processEvents([textEvent("ปิดรอบ 24/06/2569")], "dest");
    expect(db._rows("work_round_selections")[0]?.intent).toBe("close_round_confirm");

    await s.processEvents([textEvent("ยืนยันปิดรอบ")], "dest");
    expect(db._rows("work_rounds")[0]?.status).toBe("awaiting_settlement");
    expect(db._rows("work_round_selections")[0]?.status).toBe("resolved");
  });

  it("webhook retry of ยืนยันปิดรอบ leaves round unchanged and replies with actionable error", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [{ id: "wr-a", source_id: "group-1", business_date: MESSAGE_DATE, seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" }],
    });
    const s = svcR(db, replies);
    await s.processEvents([textEvent("ปิดรอบ 24/06/2569")], "dest");
    await s.processEvents([textEvent("ยืนยันปิดรอบ")], "dest");
    expect(db._rows("work_rounds")[0]?.status).toBe("awaiting_settlement");
    replies.length = 0;

    await s.processEvents([textEvent("ยืนยันปิดรอบ", "user-1", "reply-retry")], "dest");
    expect(db._rows("work_rounds")[0]?.status).toBe("awaiting_settlement");
    expect(replies[0]).toContain("ไม่พบรายการปิดรอบที่รอยืนยัน");
  });

  it("ยืนยันปิดรอบ without prior ปิดรอบ gives actionable error, no state change", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [{ id: "wr-a", source_id: "group-1", business_date: MESSAGE_DATE, seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" }],
    });
    const s = svcR(db, replies);
    await s.processEvents([textEvent("ยืนยันปิดรอบ", "user-1", "reply-1")], "dest");
    expect(db._rows("work_rounds")[0]?.status).toBe("open");
    expect(replies[0]).toContain("ไม่พบรายการปิดรอบที่รอยืนยัน");
  });

  it("stale confirmation (round already awaiting_settlement) replies safely, no mutation", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [{ id: "wr-a", source_id: "group-1", business_date: MESSAGE_DATE, seller_name: "กี้", market_name: "A", round_seq: 1, status: "awaiting_settlement" }],
      work_round_selections: [{
        id: "sel-stale", source_id: "group-1", line_user_id: "user-1", business_date: MESSAGE_DATE,
        intent: "close_round_confirm", status: "pending",
        candidates: [{ work_round_id: "wr-a", seller_name: "กี้", market_name: "A", round_seq: 1, expected_sales: 0 }],
        payload: null, created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        resolved_at: null, resolved_work_round_id: null,
      }],
    });
    const s = svcR(db, replies);
    await s.processEvents([textEvent("ยืนยันปิดรอบ", "user-1", "reply-1")], "dest");
    expect(db._rows("work_rounds")[0]?.status).toBe("awaiting_settlement");
    expect(replies[0]).toContain("รอบมีการเปลี่ยนแปลงหลังสรุป");
  });

  it("success reply includes seller, totals, and settlement command hint", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [{ id: "wr-a", source_id: "group-1", business_date: MESSAGE_DATE, seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" }],
      produce_sessions: [{ id: "ps-1", work_round_id: "wr-a" }],
      produce_items: [
        { id: "i1", session_id: "ps-1", transaction_type: "เบิก", product_name: "มะม่วง", quantity: 10, price_per_unit: 100 },
        { id: "i2", session_id: "ps-1", transaction_type: "คืน", product_name: "มะม่วง", quantity: 2, price_per_unit: 100 },
      ],
    });
    const s = svcR(db, replies);
    await s.processEvents([textEvent("ปิดรอบ 24/06/2569", "user-1", "reply-preview")], "dest");
    replies.length = 0;
    await s.processEvents([textEvent("ยืนยันปิดรอบ", "user-1", "reply-confirm")], "dest");
    expect(replies[0]).toContain("ปิดรอบเรียบร้อย ✅");
    expect(replies[0]).toContain("กี้ — A");
    expect(replies[0]).toContain("800");
    expect(replies[0]).toContain("ส่งเงิน");
    expect(replies[0]).toContain("2569");
  });

  it("rpc returning PGRST202 falls through to JS claim path and confirms successfully", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [{ id: "wr-a", source_id: "group-1", business_date: MESSAGE_DATE, seller_name: "กี้", market_name: "A", round_seq: 1, status: "open" }],
    });
    // Simulate production: supabase has rpc but function doesn't exist (migration 0040 not applied).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).rpc = () => Promise.resolve({
      data: null,
      error: { message: "Could not find the function public.claim_work_round_selection(p_allowed_statuses, p_choice, p_line_user_id, p_selection_id, p_source_id) in the schema cache" },
    });
    const s = svcR(db, replies);
    await s.processEvents([textEvent("ปิดรอบ 24/06/2569", "user-1", "reply-preview")], "dest");
    replies.length = 0;
    await s.processEvents([textEvent("ยืนยันปิดรอบ", "user-1", "reply-confirm")], "dest");
    expect(db._rows("work_rounds")[0]?.status).toBe("awaiting_settlement");
    expect(replies[0]).toContain("ปิดรอบเรียบร้อย");
  });
});

describe("WebhookService — produce append with future business_date", () => {
  function svcA(db: ReturnType<typeof memSupabase>, replies: string[]) {
    return new WebhookService(db as never, {
      produceEndSettleMs: 0,
      replyMessage: async (_tok, text) => { replies.push(text); },
    });
  }

  const FUTURE_DATE = "2026-06-28";

  it("generic รายการเบิกเพิ่ม resolves to the single append-eligible round regardless of its business_date", async () => {
    const replies: string[] = [];
    const db = memSupabase({
      work_rounds: [{ id: "wr-f", source_id: "group-1", business_date: FUTURE_DATE, seller_name: "ทดลองใหม่", market_name: "ตลาดจำลอง", round_seq: 1, status: "open" }],
    });
    const s = svcA(db, replies);
    await s.processEvents([textEvent(
      ["รายการเบิกเพิ่ม", "3 มังคุด 35 บาท", "2 โล", "จบรายการเบิกเพิ่ม"].join("\n"),
      "user-1", "reply-1",
    )], "dest");
    expect(replies[0] ?? "").not.toContain("ไม่พบรอบ");
    const sessions = db._rows("produce_sessions");
    expect(sessions.some((s) => s.work_round_id === "wr-f" && s.is_append_session === true)).toBe(true);
  });

  it("generic append with no eligible round returns actionable error, no DB mutation", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    const s = svcA(db, replies);
    await s.processEvents([textEvent(
      ["รายการเบิกเพิ่ม", "3 มังคุด 35 บาท", "2 โล", "จบรายการ"].join("\n"),
      "user-1", "reply-1",
    )], "dest");
    expect(replies[0]).toContain("ไม่พบรอบเบิก");
    expect(db._rows("produce_sessions")).toHaveLength(0);
  });

  it("full E2E: explicit borrow on future date → append (no date) → close preview → confirm", async () => {
    const replies: string[] = [];
    const db = memSupabase();
    const s = svcA(db, replies);

    // 1. Open borrow with future business_date
    await s.processEvents([textEvent(
      ["ทดลองใหม่-ตลาดจำลอง เบิก 28/6/2569", "1 มังคุด 100 บาท", "10 โล", "จบรายการเบิก"].join("\n"),
      "user-1", "reply-borrow",
    )], "dest");
    const wr = db._rows("work_rounds").find((r) => r.seller_name === "ทดลองใหม่");
    expect(wr?.business_date).toBe(FUTURE_DATE);
    expect(wr?.status).toBe("open");

    // 2. Append (no date — must resolve by status, not date)
    replies.length = 0;
    await s.processEvents([textEvent(
      ["รายการเบิกเพิ่ม", "2 แอปเปิ้ล 50 บาท", "3 ลูก", "จบรายการเบิกเพิ่ม"].join("\n"),
      "user-1", "reply-append",
    )], "dest");
    expect(replies[0] ?? "").not.toContain("ไม่พบรอบ");
    const appendSessions = db._rows("produce_sessions").filter((s) => s.is_append_session);
    expect(appendSessions).toHaveLength(1);
    expect(appendSessions[0]?.work_round_id).toBe(wr?.id);

    // 3. Close preview
    replies.length = 0;
    await s.processEvents([textEvent("ปิดรอบ 28/6/2569", "user-1", "reply-preview")], "dest");
    expect(replies[0]).toBeTruthy();
    expect(db._rows("work_round_selections")[0]?.intent).toBe("close_round_confirm");

    // 4. Confirm — must transition to awaiting_settlement
    replies.length = 0;
    await s.processEvents([textEvent("ยืนยันปิดรอบ", "user-1", "reply-confirm")], "dest");
    expect(db._rows("work_rounds").find((r) => r.seller_name === "ทดลองใหม่")?.status).toBe("awaiting_settlement");
    expect(replies[0]).toContain("ปิดรอบเรียบร้อย");
    expect(replies[0]).toContain("ส่งเงิน");
    expect(replies[0]).toContain("2569");
  });
});
