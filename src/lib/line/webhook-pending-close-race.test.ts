/**

 * Regression: generation-scoped ingest ledger + admission barrier.

 */



import { describe, expect, it } from "bun:test";

import { WebhookService } from "./webhook-service";

import { PendingSessionService, rebuildPendingSessionFromIngest } from "./pending-session-service";

import type { LineMessageEvent } from "./types";

import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";



const MESSAGE_DATE = "2026-06-25";

const LO = "\u0E42\u0E25";

const GROUP = "group-burst";

const BASE_TS = 1_700_000_000_000;



function textEvent(

  text: string,

  opts: {

    eventId: string;

    timestamp: number;

    replyToken?: string;

    groupId?: string;

  },

): LineMessageEvent {

  return {

    type: "message",

    webhookEventId: opts.eventId,

    deliveryContext: { isRedelivery: false },

    timestamp: opts.timestamp,

    source: { type: "group", groupId: opts.groupId ?? GROUP, userId: "user-1" },

    mode: "active",

    replyToken: opts.replyToken,

    message: { id: opts.eventId, type: "text", text },

  } as unknown as LineMessageEvent;

}



function openRound(groupId = GROUP): Row {

  return {

    id: "wr-burst",

    source_id: groupId,

    business_date: MESSAGE_DATE,

    seller_name: "กี้",

    market_name: "วัดทุ่งลานนา",

    round_seq: 1,

    status: "open",

    source_meta: null,

    created_at: "",

    updated_at: "",

  };

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



function itemLine(n: number): string {

  return `${n}มังคุด35บาท\n1${LO}`;

}



describe("WebhookService — generation-scoped pending close ledger", () => {

  it("defers finalize until admitted events are ingested into the ledger", async () => {

    const db = memSupabase({ work_rounds: [openRound()] });

    const replies: string[] = [];

    const { service, flushBackground } = svc(db, replies);

    const pendingService = new PendingSessionService(db as never);



    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";

    const closeTs = BASE_TS + 100;



    await service.processEvents([

      textEvent(header, { eventId: "hdr", timestamp: BASE_TS }),

    ], "dest");



    for (let n = 1; n <= 13; n += 1) {

      await service.processEvents([

        textEvent(itemLine(n), { eventId: `item-${n}`, timestamp: BASE_TS + n }),

      ], "dest");

    }



    for (let n = 14; n <= 19; n += 1) {

      await pendingService.admit(GROUP, `item-${n}`, BASE_TS + n);

    }



    const closeResult = await service.processEvents([

      textEvent("จบรายการชั่งคืน", {

        eventId: "close",

        timestamp: closeTs,

        replyToken: "tok-close",

      }),

    ], "dest");



    expect(closeResult[0].parsed).toBeFalsy();

    expect(db._rows("produce_sessions")).toHaveLength(0);



    for (let n = 14; n <= 19; n += 1) {

      await service.processEvents([

        textEvent(itemLine(n), { eventId: `item-${n}`, timestamp: BASE_TS + n }),

      ], "dest");

    }



    await flushBackground();



    expect(db._rows("produce_items").length).toBe(19);

    expect(db._rows("produce_sessions")).toHaveLength(1);

  });



  it("finalizes all 19 items when close races ahead of concurrent item handlers", async () => {

    const db = memSupabase({ work_rounds: [openRound()] });

    const { service, flushBackground } = svc(db);



    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";

    const closeTs = BASE_TS + 100;



    await service.processEvents([

      textEvent(header, { eventId: "hdr", timestamp: BASE_TS }),

    ], "dest");



    const itemEvents = Array.from({ length: 19 }, (_, i) => {

      const n = i + 1;

      return service.processEvents([

        textEvent(itemLine(n), { eventId: `burst-${n}`, timestamp: BASE_TS + n }),

      ], "dest");

    });



    const closeEvent = service.processEvents([

      textEvent("จบรายการชั่งคืน", {

        eventId: "burst-close",

        timestamp: closeTs,

        replyToken: "tok-burst-close",

      }),

    ], "dest");



    await Promise.all([...itemEvents, closeEvent]);

    await flushBackground();



    expect(db._rows("produce_items").length).toBe(19);

    expect(db._rows("produce_sessions")).toHaveLength(1);

  });



  it("rejects produce item lines that arrive after pending session was closed", async () => {

    const db = memSupabase({ work_rounds: [openRound()] });

    const replies: string[] = [];

    const { service, flushBackground } = svc(db, replies);



    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";

    await service.processEvents([textEvent(header, { eventId: "hdr", timestamp: BASE_TS })], "dest");

    await service.processEvents([

      textEvent(itemLine(1), { eventId: "item-1", timestamp: BASE_TS + 1 }),

      textEvent("จบรายการชั่งคืน", {

        eventId: "close",

        timestamp: BASE_TS + 50,

        replyToken: "tok",

      }),

    ], "dest");

    await flushBackground();



    await service.processEvents([

      textEvent(itemLine(99), {

        eventId: "late",

        timestamp: BASE_TS + 99,

        replyToken: "tok-late",

      }),

    ], "dest");



    expect(db._rows("produce_items").length).toBe(1);

    expect(replies.some((r) => r.includes("รายการนี้มาหลังปิดรอบแล้ว"))).toBe(true);

  });



  it("finalizes 22 items in timestamp order when append completions are scrambled", async () => {

    const SCRAMBLE = [2, 1, 3, 13, 4, 15, 16, 5, 6, 7, 17, 8, 18, 19, 9, 20, 10, 0, 21, 11, 22, 12, 14];

    const rankByEvent = new Map<string, number>();

    for (let i = 0; i < SCRAMBLE.length; i += 1) {

      const token = SCRAMBLE[i];

      const eventId = token === 0 ? "close" : `item-${token}`;

      rankByEvent.set(eventId, i);

    }



    const db = memSupabase(

      { work_rounds: [openRound()] },

      {

        rpcBefore: {

          append_pending_session: async (params) => {

            const eventId = String(params.p_line_event_id ?? "");

            const rank = rankByEvent.get(eventId) ?? 999;

            await new Promise((resolve) => setTimeout(resolve, rank * 8));

          },

        },

      },

    );

    const replies: string[] = [];

    const { service, flushBackground } = svc(db, replies);



    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";

    const closeTs = BASE_TS + 100;



    await service.processEvents([

      textEvent(header, { eventId: "hdr", timestamp: BASE_TS }),

    ], "dest");



    const itemEvents = Array.from({ length: 22 }, (_, i) => {

      const n = i + 1;

      return service.processEvents([

        textEvent(itemLine(n), { eventId: `item-${n}`, timestamp: BASE_TS + n }),

      ], "dest");

    });



    const closeEvent = service.processEvents([

      textEvent("จบรายการชั่งคืน", {

        eventId: "close",

        timestamp: closeTs,

        replyToken: "tok-close",

      }),

    ], "dest");



    await Promise.all([...itemEvents, closeEvent]);



    const pendingBeforeFinalize = db._rows("pending_sessions")[0];

    if (pendingBeforeFinalize) {

      const generation = pendingBeforeFinalize.session_generation;

      const ingestBeforeFinalize = db._rows("pending_session_ingest").filter(

        (row) => row.session_generation === generation,

      );

      const rebuilt = rebuildPendingSessionFromIngest(

        pendingBeforeFinalize as import("./pending-session-service").PendingSession,

        ingestBeforeFinalize as Array<{

          line_event_id: string;

          line_timestamp_ms: number;

          raw_text: string;

        }>,

      );

      const parsedBeforeFinalize = parseWeighSession(rebuilt, MESSAGE_DATE);

      expect(parsedBeforeFinalize.items.map((item) => item.item_number)).toEqual(

        Array.from({ length: 22 }, (_, i) => i + 1),

      );

      expect(parsedBeforeFinalize.parse_errors).toHaveLength(0);

    }



    await flushBackground();



    expect(db._rows("produce_items")).toHaveLength(22);

    expect(replies.some((r) => r.includes("#14 #14"))).toBe(false);

    expect(replies.some((r) => r.includes("#14"))).toBe(false);

  });



  it("does not stall close when unrelated group chat arrives during an open session", async () => {

    const db = memSupabase({ work_rounds: [openRound()] });

    const { service, flushBackground } = svc(db);



    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";

    await service.processEvents([textEvent(header, { eventId: "hdr", timestamp: BASE_TS })], "dest");

    await service.processEvents([

      textEvent(itemLine(1), { eventId: "item-1", timestamp: BASE_TS + 1 }),

    ], "dest");



    db._rows("raw_messages").push({

      id: "raw-chatter",

      line_event_id: "chatter-1",

      destination: "dest",

      event_type: "message",

      source_type: "group",

      source_id: GROUP,

      user_id: "user-2",

      message_id: "chatter-1",

      message_type: "text",

      raw_text: "สวัสดีครับ วันนี้อากาศดี",

      payload: { timestamp: BASE_TS + 2 },

      is_processed: false,

      created_at: new Date().toISOString(),

    });



    await service.processEvents([

      textEvent("จบรายการชั่งคืน", {

        eventId: "close",

        timestamp: BASE_TS + 50,

        replyToken: "tok",

      }),

    ], "dest");

    await flushBackground();



    expect(db._rows("produce_items")).toHaveLength(1);

    expect(db._rows("pending_sessions")).toHaveLength(0);

  });



  it("header replacement creates a fresh generation and ignores prior ingest rows", async () => {

    const db = memSupabase({ work_rounds: [openRound()] });

    const { service, flushBackground } = svc(db);



    const headerA = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";

    await service.processEvents([textEvent(headerA, { eventId: "hdr-a", timestamp: BASE_TS })], "dest");

    await service.processEvents([

      textEvent(itemLine(1), { eventId: "old-item", timestamp: BASE_TS + 1 }),

    ], "dest");



    const genA = db._rows("pending_sessions")[0].session_generation as string;

    expect(db._rows("pending_session_ingest").filter((r) => r.session_generation === genA)).toHaveLength(2);



    await service.processEvents([

      textEvent(headerA, { eventId: "hdr-b", timestamp: BASE_TS + 10 }),

    ], "dest");



    const genB = db._rows("pending_sessions")[0].session_generation as string;

    expect(genB).not.toBe(genA);

    expect(db._rows("pending_session_ingest").filter((r) => r.session_generation === genB)).toHaveLength(1);



    await service.processEvents([

      textEvent(itemLine(2), { eventId: "new-item", timestamp: BASE_TS + 11 }),

      textEvent("จบรายการชั่งคืน", {

        eventId: "close-b",

        timestamp: BASE_TS + 50,

        replyToken: "tok",

      }),

    ], "dest");

    await flushBackground();



    expect(db._rows("produce_items")).toHaveLength(1);

    expect(db._rows("produce_items")[0].item_number).toBe(2);

  });



  it("defers close when admission precedes ingest for a pre-close item", async () => {

    const db = memSupabase({ work_rounds: [openRound()] });

    const { service, flushBackground } = svc(db);

    const pendingService = new PendingSessionService(db as never);



    const header = "กี้-วัดทุ่งลานนา ชั่งคืน 25/6/2569";

    await service.processEvents([textEvent(header, { eventId: "hdr", timestamp: BASE_TS })], "dest");

    await service.processEvents([

      textEvent(itemLine(1), { eventId: "item-1", timestamp: BASE_TS + 1 }),

    ], "dest");



    await pendingService.admit(GROUP, "item-2", BASE_TS + 2);



    await service.processEvents([

      textEvent("จบรายการชั่งคืน", {

        eventId: "close",

        timestamp: BASE_TS + 50,

        replyToken: "tok",

      }),

    ], "dest");



    expect(db._rows("produce_sessions")).toHaveLength(0);



    await service.processEvents([
      textEvent(itemLine(2), { eventId: "item-2", timestamp: BASE_TS + 2 }),
    ], "dest");

    await flushBackground();



    expect(db._rows("produce_items")).toHaveLength(2);

  });

});


