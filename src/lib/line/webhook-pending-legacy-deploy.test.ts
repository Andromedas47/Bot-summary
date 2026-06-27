/**
 * Regression: pre-0042 pending_sessions rows finalized safely after 0042 deploy.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";

const MESSAGE_DATE = "2026-06-25";
const LO = "\u0E42\u0E25";
const GROUP = "group-legacy";
const BASE_TS = 1_700_000_000_000;

function textEvent(
  text: string,
  opts: {
    eventId: string;
    timestamp: number;
    replyToken?: string;
    groupId?: string;
  },
): import("./types").LineMessageEvent {
  return {
    type: "message",
    webhookEventId: opts.eventId,
    deliveryContext: { isRedelivery: false },
    timestamp: opts.timestamp,
    source: { type: "group", groupId: opts.groupId ?? GROUP, userId: "user-1" },
    mode: "active",
    replyToken: opts.replyToken,
    message: { id: opts.eventId, type: "text", text },
  } as unknown as import("./types").LineMessageEvent;
}

function openRound(groupId = GROUP, overrides: Partial<Row> = {}): Row {
  return {
    id: "wr-legacy",
    source_id: groupId,
    business_date: MESSAGE_DATE,
    seller_name: "กี้",
    market_name: "วัดทุ่งลานนา",
    round_seq: 1,
    status: "open",
    source_meta: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function itemLine(n: number): string {
  return `${n}มังคุด35บาท\n1${LO}`;
}

function svc(
  db: ReturnType<typeof memSupabase>,
  replies: string[] = [],
) {
  const background: Array<() => Promise<void>> = [];
  const service = new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
    scheduleBackgroundTask: (task) => { background.push(task); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return {
    service,
    async flushBackground() {
      while (background.length > 0) {
        const batch = background.splice(0, background.length);
        await Promise.all(batch.map((task) => task()));
      }
    },
  };
}

function seedPre0042PendingSession(
  db: ReturnType<typeof memSupabase>,
  itemNumbers: number[],
  header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569",
) {
  const generation = crypto.randomUUID();
  const accumulated = [header, ...itemNumbers.map((n) => itemLine(n))].join("\n");
  const createdAt = new Date(BASE_TS - 60_000).toISOString();

  const row: Row = {
    id: "pending-pre-0042",
    session_key: GROUP,
    session_generation: generation,
    accumulated_text: accumulated,
    latest_reply_token: "tok-legacy",
    line_user_id: "user-1",
    created_at: createdAt,
    updated_at: createdAt,
    close_event_timestamp_ms: null,
    close_requested_at: null,
    close_line_event_id: null,
    close_finalize_started_at: null,
  };

  db.from("pending_sessions").insert(row);

  return { generation, accumulated, header };
}

describe("WebhookService — pre-0042 pending session deploy compatibility", () => {
  it("finalizes pre-0042 accumulated items when close arrives after deploy", async () => {
    const db = memSupabase({ work_rounds: [openRound()] });
    seedPre0042PendingSession(db, [1, 2, 3]);

    expect(db._rows("pending_session_ingest")).toHaveLength(0);
    expect(db._rows("pending_session_admission")).toHaveLength(0);

    const { service, flushBackground } = svc(db);

    await service.processEvents([
      textEvent("จบรายการชั่งคืน", {
        eventId: "close-after-deploy",
        timestamp: BASE_TS + 100,
        replyToken: "tok-close",
      }),
    ], "dest");

    await flushBackground();

    expect(db._rows("produce_items")).toHaveLength(3);
    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("pending_sessions")).toHaveLength(0);
  });

  it("keeps pre-0042 items when one post-deploy item and close are appended", async () => {
    const db = memSupabase({ work_rounds: [openRound()] });
    seedPre0042PendingSession(db, [1, 2]);

    const { service, flushBackground } = svc(db);

    await service.processEvents([
      textEvent(itemLine(3), { eventId: "item-3", timestamp: BASE_TS + 3 }),
      textEvent("จบรายการชั่งคืน", {
        eventId: "close-hybrid",
        timestamp: BASE_TS + 50,
        replyToken: "tok-close",
      }),
    ], "dest");

    await flushBackground();

    expect(db._rows("produce_items")).toHaveLength(3);
    expect(db._rows("produce_items").map((row) => row.item_number)).toEqual([1, 2, 3]);
    expect(db._rows("pending_sessions")).toHaveLength(0);
  });

  it("header replacement after deploy creates a clean generation and uses the ledger", async () => {
    const db = memSupabase({ work_rounds: [openRound()] });
    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";
    const { generation: legacyGen } = seedPre0042PendingSession(db, [1, 2, 3], header);

    const { service, flushBackground } = svc(db);

    await service.processEvents([
      textEvent(header, { eventId: "hdr-new", timestamp: BASE_TS + 10 }),
    ], "dest");

    const current = db._rows("pending_sessions")[0];
    expect(current.session_generation).not.toBe(legacyGen);
    expect(db._rows("pending_session_ingest").filter((r) => r.session_generation === current.session_generation)).toHaveLength(1);

    await service.processEvents([
      textEvent(itemLine(9), { eventId: "item-9", timestamp: BASE_TS + 11 }),
      textEvent("จบรายการชั่งคืน", {
        eventId: "close-new-gen",
        timestamp: BASE_TS + 50,
        replyToken: "tok-close",
      }),
    ], "dest");

    await flushBackground();

    expect(db._rows("produce_items")).toHaveLength(1);
    expect(db._rows("produce_items")[0].item_number).toBe(9);
    expect(db._rows("pending_sessions")).toHaveLength(0);
  });

  it("blocks close for pre-0042 malformed accumulated_text with parse-review reply", async () => {
    const header = "โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569";
    const badLine = `9จีนหงส์ 3 ${LO}100บาท`;
    const accumulated = [
      header,
      "1ส้มไต้หวัน 40 บาท",
      `20${LO}`,
      badLine,
      "15.5ลูก",
    ].join("\n");

    const db = memSupabase({
      work_rounds: [openRound({ seller_name: "โอม", market_name: "ตลาดพาซิโอ้ผลไม้" })],
    });
    const generation = crypto.randomUUID();
    const createdAt = new Date(BASE_TS - 60_000).toISOString();
    db.from("pending_sessions").insert({
      id: "pending-om-malformed",
      session_key: GROUP,
      session_generation: generation,
      accumulated_text: accumulated,
      latest_reply_token: "tok-legacy",
      line_user_id: "user-1",
      created_at: createdAt,
      updated_at: createdAt,
      close_event_timestamp_ms: null,
      close_requested_at: null,
      close_line_event_id: null,
      close_finalize_started_at: null,
    });

    const replies: string[] = [];
    const { service, flushBackground } = svc(db, replies);

    await service.processEvents([
      textEvent("จบรายการเบิก", {
        eventId: "close-om-malformed",
        timestamp: BASE_TS + 100,
        replyToken: "tok-close",
      }),
    ], "dest");

    await flushBackground();

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    expect(db._rows("pending_sessions")).toHaveLength(1);
    const pending = db._rows("pending_sessions")[0];
    expect(String(pending.accumulated_text)).toContain(header);
    expect(String(pending.accumulated_text)).toContain("15.5ลูก");
    expect(pending.close_event_timestamp_ms).toBeNull();
    expect(replies.some((r) => r.includes("อ่านรายการไม่ครบ กรุณาแก้ไข:"))).toBe(true);
    expect(replies.some((r) => r.includes(badLine))).toBe(true);
    expect(replies.some((r) => r.includes("อ่านรายการไม่สำเร็จ"))).toBe(false);
    expect(replies.some((r) => r.includes("บันทึกแล้ว"))).toBe(false);
  });
});
