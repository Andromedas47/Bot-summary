/**
 * P2b — fail-open shadow dual-write of produce_round_events into LINE webhook.
 */

import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";
import { isProduceRoundEventsDualWriteEnabled } from "@/lib/produce-round-events/config";
import { projectEvents } from "@/lib/produce-round-events/projector";
import { ProduceRoundEventService } from "@/lib/produce-round-events/event-service";

const MESSAGE_DATE = "2026-06-25";
const LO = "\u0E42\u0E25";

let seq = 0;
function textEvent(
  text: string,
  opts: { replyToken?: string; timestamp?: number; eventId?: string; groupId?: string } = {},
): LineMessageEvent {
  seq += 1;
  const ts = opts.timestamp ?? seq * 1000;
  const eventId = opts.eventId ?? `evt-${seq}`;
  return {
    type: "message",
    webhookEventId: eventId,
    deliveryContext: { isRedelivery: false },
    timestamp: ts,
    source: { type: "group", groupId: opts.groupId ?? "group-1", userId: "user-1" },
    mode: "active",
    replyToken: opts.replyToken,
    message: { id: `msg-${eventId}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function memDb(
  seed: Record<string, Row[]> = {},
  rpcErrors?: Record<string, { message: string; code?: string }>,
) {
  return memSupabase(seed, { rpcErrors });
}

function svc(
  db: ReturnType<typeof memSupabase>,
  replies: string[] = [],
  dualWrite = false,
) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    produceRoundEventsDualWriteEnabled: dualWrite,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

async function runBorrowCloseFlow(
  s: WebhookService,
  lines: string[],
  closeReplyToken = "tok-close",
) {
  for (const line of lines) {
    const isClose = line === "จบรายการเบิก";
    await s.processEvents(
      [textEvent(line, isClose ? { replyToken: closeReplyToken } : {})],
      "dest",
    );
  }
}

describe("isProduceRoundEventsDualWriteEnabled", () => {
  it("defaults to disabled", () => {
    expect(isProduceRoundEventsDualWriteEnabled()).toBe(false);
    expect(isProduceRoundEventsDualWriteEnabled(undefined)).toBe(false);
  });

  it("respects explicit override", () => {
    expect(isProduceRoundEventsDualWriteEnabled(true)).toBe(true);
    expect(isProduceRoundEventsDualWriteEnabled(false)).toBe(false);
  });
});

describe("WebhookService — produce round events dual-write (P2b)", () => {
  it("dual-write disabled: no event rows and legacy behavior unchanged", async () => {
    const db = memDb({ work_rounds: [] });
    const replies: string[] = [];
    const s = svc(db, replies, false);

    await runBorrowCloseFlow(s, [
      "โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569",
      "1มังคุด35บาท", `18.3.${LO}`,
      "จบรายการเบิก",
    ]);

    expect(db._rows("produce_round_events")).toHaveLength(0);
    expect(db._rows("work_rounds")).toHaveLength(1);
    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_items").length).toBeGreaterThan(0);
  });

  it("dual-write enabled: events captured while legacy tables stay identical", async () => {
    const dbOff = memDb({ work_rounds: [] });
    const repliesOff: string[] = [];
    const sOff = svc(dbOff, repliesOff, false);
    await runBorrowCloseFlow(sOff, [
      "โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569",
      "1มังคุด35บาท", `18.3.${LO}`,
      "จบรายการเบิก",
    ]);

    seq = 0;
    const dbOn = memDb({ work_rounds: [] });
    const repliesOn: string[] = [];
    const sOn = svc(dbOn, repliesOn, true);
    await runBorrowCloseFlow(sOn, [
      "โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569",
      "1มังคุด35บาท", `18.3.${LO}`,
      "จบรายการเบิก",
    ]);

    expect(dbOn._rows("produce_round_events").length).toBeGreaterThan(0);
    expect(dbOn._rows("work_rounds")).toHaveLength(dbOff._rows("work_rounds").length);
    expect(dbOn._rows("produce_sessions")).toHaveLength(dbOff._rows("produce_sessions").length);
    expect(dbOn._rows("produce_items")).toHaveLength(dbOff._rows("produce_items").length);
    expect(dbOn._rows("work_rounds")[0].status).toBe(dbOff._rows("work_rounds")[0].status);
    expect(repliesOn.length).toBe(repliesOff.length);
  });

  it("event-writer failure is fail-open — legacy finalization still succeeds", async () => {
    const db = memDb({ work_rounds: [] }, {
      insert_produce_round_events_ignore: { message: "simulated RPC failure", code: "XX000" },
    });
    const replies: string[] = [];
    const s = svc(db, replies, true);

    await runBorrowCloseFlow(s, [
      "โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569",
      "1มังคุด35บาท", `18.3.${LO}`,
      "จบรายการเบิก",
    ]);

    expect(db._rows("produce_round_events")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_items").length).toBeGreaterThan(0);
  });

  it("duplicate LINE delivery creates no duplicate events and no duplicate legacy processing", async () => {
    const db = memDb({ work_rounds: [] });
    const replies: string[] = [];
    const s = svc(db, replies, true);

    const evt = textEvent("โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569", { eventId: "dup-evt-1", timestamp: 1000 });
    await s.processEvents([evt], "dest");
    const sessionsAfterFirst = db._rows("produce_sessions").length;
    const eventsAfterFirst = db._rows("produce_round_events").length;

    const dupResult = await s.processEvents([evt], "dest");
    expect(dupResult[0].status).toBe("duplicate");
    expect(db._rows("produce_round_events")).toHaveLength(eventsAfterFirst);
    expect(db._rows("produce_sessions")).toHaveLength(sessionsAfterFirst);
    expect(db._rows("pending_sessions")).toHaveLength(1);
  });

  it("duplicate delivery repairs a failed previous event capture without replaying legacy", async () => {
    const db = memDb({ work_rounds: [] }, {
      insert_produce_round_events_ignore: { message: "simulated RPC failure", code: "XX000" },
    });
    const replies: string[] = [];
    const failing = svc(db, replies, true);

    const evt = textEvent("โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569", { eventId: "repair-evt", timestamp: 2000 });
    await failing.processEvents([evt], "dest");
    expect(db._rows("produce_round_events")).toHaveLength(0);
    expect(db._rows("pending_sessions")).toHaveLength(1);

    seq = 100;
    const repairingDb = memSupabase(db._tables as Record<string, Row[]>);
    const repairing = svc(repairingDb, replies, true);
    const dupResult = await repairing.processEvents([evt], "dest");
    expect(dupResult[0].status).toBe("duplicate");
    expect(repairingDb._rows("produce_round_events").length).toBeGreaterThan(0);
    expect(repairingDb._rows("pending_sessions")).toHaveLength(1);
    expect(repairingDb._rows("pending_sessions")[0].accumulated_text).toBe(
      "โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569",
    );
  });

  it("out-of-order webhook requests project deterministically", async () => {
    const db = memDb({ work_rounds: [] });
    const replies: string[] = [];
    const s = svc(db, replies, true);

    const header = textEvent("โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569", { eventId: "oo-header", timestamp: 1000 });
    const close  = textEvent("จบรายการเบิก", { eventId: "oo-close", timestamp: 2000, replyToken: "tok" });
    const late   = textEvent("2ทุเรียน35บาท", { eventId: "oo-late", timestamp: 3000 });

    await s.processEvents([late], "dest");
    await s.processEvents([close], "dest");
    await s.processEvents([header], "dest");

    const eventSvc = new ProduceRoundEventService(db as never);
    const events = await eventSvc.listBySource("group-1");
    const { orderedLines } = projectEvents(events, "จบรายการเบิก");
    const kinds = orderedLines.map((l) => l.event.eventKind);
    expect(kinds.indexOf("header")).toBeLessThan(kinds.indexOf("close_marker"));
    expect(kinds.indexOf("close_marker")).toBeLessThan(kinds.indexOf("item"));
  });

  it("late item after accepted close is captured and reported late by projection", async () => {
    const db = memDb({ work_rounds: [] });
    const replies: string[] = [];
    const s = svc(db, replies, true);

    await s.processEvents([
      textEvent("โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569", { eventId: "l-header", timestamp: 1000 }),
      textEvent("1มังคุด35บาท", { eventId: "l-item1", timestamp: 1500 }),
      textEvent("2ทุเรียน35บาท", { eventId: "l-late", timestamp: 3000 }),
      textEvent("จบรายการเบิก", { eventId: "l-close", timestamp: 2000, replyToken: "tok" }),
    ], "dest");

    const eventSvc = new ProduceRoundEventService(db as never);
    const events = await eventSvc.listBySource("group-1");
    const projection = projectEvents(events, "จบรายการเบิก");
    expect(projection.lateEvents).toHaveLength(1);
    expect(projection.lateEvents[0].normalizedLine).toBe("2ทุเรียน35บาท");
  });

  it("parity match is returned safely on successful finalization", async () => {
    const db = memDb({ work_rounds: [] });
    const replies: string[] = [];
    const s = svc(db, replies, true);

    const results = await s.processEvents([
      textEvent("โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569", { timestamp: 1000 }),
      textEvent("1มังคุด35บาท", { timestamp: 2000 }),
      textEvent("10โล", { timestamp: 2500 }),
      textEvent("จบรายการเบิก", { timestamp: 3000, replyToken: "tok" }),
    ], "dest");

    const finalizeResult = results.at(-1)!;
    expect(finalizeResult.parsed).toBe(true);
    expect(finalizeResult.produceRoundParity?.match).toBe(true);
    expect(finalizeResult.produceRoundParity?.lateEventCount).toBe(0);
  });

  it("parity mismatch does not change legacy finalization result", async () => {
    const db = memDb({ work_rounds: [] });
    const replies: string[] = [];
    const s = svc(db, replies, true);

    await s.processEvents([
      textEvent("โอม-ตลาดพาซิโอ้ผลไม้ เบิก 25/6/2569", { eventId: "pm-h", timestamp: 1000 }),
      textEvent("1มังคุด35บาท", { eventId: "pm-i", timestamp: 2000 }),
      textEvent("10โล", { eventId: "pm-qty", timestamp: 2100 }),
    ], "dest");

    db._rows("raw_messages").push({
      id: "raw-phantom",
      line_event_id: "phantom-ev",
      destination: "dest",
      event_type: "message",
      source_type: "group",
      source_id: "group-1",
      user_id: "user-1",
      message_id: "phantom-msg",
      message_type: "text",
      raw_text: "99ผี99บาท",
      payload: {},
      is_processed: false,
      created_at: new Date().toISOString(),
    });
    db._rows("produce_round_events").push({
      id: "phantom",
      raw_message_id: "raw-phantom",
      line_event_id: "phantom-ev",
      seq_in_message: 0,
      line_timestamp_ms: 2500,
      event_kind: "item",
      event_status: "parsed",
      raw_line: "99ผี99บาท",
      normalized_line: "99ผี99บาท",
      category: null,
      parsed_payload: {},
      work_round_id: null,
      created_at: new Date().toISOString(),
    });

    const results = await s.processEvents([
      textEvent("จบรายการเบิก", { eventId: "pm-c", timestamp: 3000, replyToken: "tok" }),
    ], "dest");

    const finalizeResult = results.at(-1)!;
    expect(finalizeResult.parsed).toBe(true);
    expect(finalizeResult.produceRoundParity?.match).toBe(false);
    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_items").length).toBeGreaterThan(0);
  });

  it("append generic-close warnings remain unchanged when dual-write is enabled", async () => {
    const db = memDb({
      work_rounds: [{
        id: "wr-1",
        source_id: "group-1",
        business_date: MESSAGE_DATE,
        seller_name: "โอม",
        market_name: "ตลาดพาซิโอ้ผลไม้",
        round_seq: 1,
        status: "open",
        source_meta: null,
        created_at: "",
        updated_at: "",
      }],
      pending_sessions: [{
        id: "ps-1",
        session_key: "group-1",
        accumulated_text: "รายการเบิกเพิ่ม",
        latest_reply_token: null,
        line_user_id: "user-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });
    const replies: string[] = [];
    const s = svc(db, replies, true);

    await s.processEvents([textEvent("จบรายการเบิก", { replyToken: "tok" })], "dest");

    expect(replies.at(-1)).toBe(
      "รอบนี้เป็นรายการเบิกเพิ่ม  กรุณาพิมพ์ “จบรายการเบิกเพิ่ม” เมื่อส่งครบ",
    );
    expect(db._rows("produce_sessions")).toHaveLength(0);
  });
});
