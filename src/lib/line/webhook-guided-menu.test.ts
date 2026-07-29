import { afterEach, describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent, LinePostbackEvent, LineSource } from "./types";
import {
  GUIDED_MENU_COPY,
  GuidedMenuUxHandler,
  MENU_TOKEN_PREFIX,
} from "./guided-menu";
import { GuidedMenuFakeDatabase } from "./guided-menu/test-fake-db";
import type { LineApiMessage } from "./reply";

const TS = Date.parse("2026-07-29T10:00:00+07:00");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function textEvent(
  text: string,
  overrides: Partial<LineMessageEvent> = {},
): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `msg-${Math.random().toString(36).slice(2)}`,
    deliveryContext: { isRedelivery: false },
    timestamp: TS,
    source: { type: "group", groupId: "G-1", userId: "U-op-1" },
    mode: "active",
    replyToken: "reply-text",
    message: {
      id: `m-${Date.now()}`,
      type: "text",
      text,
      quoteToken: "q",
    },
    ...overrides,
  } as LineMessageEvent;
}

function postbackEvent(
  data: string,
  overrides: Partial<LinePostbackEvent> = {},
): LinePostbackEvent {
  return {
    type: "postback",
    webhookEventId: `pb-${Math.random().toString(36).slice(2)}`,
    deliveryContext: { isRedelivery: false },
    timestamp: TS,
    source: { type: "group", groupId: "G-1", userId: "U-op-1" },
    mode: "active",
    replyToken: "reply-pb",
    postback: { data },
    ...overrides,
  } as LinePostbackEvent;
}

function collectPostbackData(value: unknown, out: string[] = []): string[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectPostbackData(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === "postback" && typeof obj.data === "string") out.push(obj.data);
  for (const child of Object.values(obj)) collectPostbackData(child, out);
  return out;
}

function assertNoBusinessSideEffects(db: GuidedMenuFakeDatabase): void {
  expect(db.openProduceCalls).toBe(0);
  expect(db.appendCalls).toBe(0);
  expect(db.admitCalls).toBe(0);
  expect(db.ingestCalls).toBe(0);
  expect(db.closeRpcCalls).toBe(0);
  expect(db.tables.pending_session_admission).toHaveLength(0);
  expect(db.tables.pending_session_ingest).toHaveLength(0);
  expect(db.tables.pending_sessions).toHaveLength(0);
}

function assertSingleGenuineRaw(
  db: GuidedMenuFakeDatabase,
  eventId: string,
  eventType: string,
): void {
  const raws = db.tables.raw_messages;
  expect(raws).toHaveLength(1);
  expect(raws[0]!.line_event_id).toBe(eventId);
  expect(raws[0]!.event_type).toBe(eventType);
  // Payload is the genuine inbound event — not a synthetic header/message.
  const payload = raws[0]!.payload as { webhookEventId?: string; type?: string };
  expect(payload.webhookEventId).toBe(eventId);
  expect(payload.type).toBe(eventType);
  const rawText = raws[0]!.raw_text;
  if (typeof rawText === "string") {
    expect(rawText).not.toMatch(/พี่ดำ-/);
  } else {
    // Postbacks legitimately have null raw_text — still not a synthetic header.
    expect(rawText).toBeNull();
  }
}

function seedMappedSeller(
  db: GuidedMenuFakeDatabase,
  lineUserId = "U-op-1",
): void {
  db.seedOperator({
    line_user_id: lineUserId,
    staff_label: "พี่ดำ",
    active: true,
  });
  db.seedMarket({
    market_code: "wat_thung_lanna",
    label: "วัดทุ่งลานนา",
    active: true,
  });
  db.seedSeller({
    seller_code: "seller_a",
    label: "พี่ดำ",
    active: true,
    sort_order: 1,
  });
  db.seedSellerMarket({
    seller_code: "seller_a",
    market_code: "wat_thung_lanna",
    active: true,
    sort_order: 1,
  });
}

function makeService(db: GuidedMenuFakeDatabase, replies: LineApiMessage[][]) {
  let pushCalls = 0;
  let multicastCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/message/push")) pushCalls += 1;
    if (url.includes("/message/multicast")) multicastCalls += 1;
    return originalFetch(input, init);
  }) as typeof fetch;

  const service = new WebhookService(db.asClient(), {
    guidedMenuHandler: new GuidedMenuUxHandler(db.asClient()),
    replyApiMessages: async (_token, messages) => {
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages.length).toBeLessThanOrEqual(5);
      for (const msg of messages) {
        expect(typeof msg.type).toBe("string");
      }
      replies.push(messages);
    },
    replyMessage: async () => {
      throw new Error("Guided Menu must use replyApiMessages, not replyMessage");
    },
  });

  return {
    service,
    counts: () => ({ pushCalls, multicastCalls }),
  };
}

describe("0051 Slice 2 — webhook Guided Menu", () => {
  it("exact เมนู opens transaction menu via one reply call; persists genuine raw only", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedMappedSeller(db);
    const replies: LineApiMessage[][] = [];
    const { service, counts } = makeService(db, replies);
    const event = textEvent("เมนู", { webhookEventId: "msg-menu-1" });

    await service.processEvents([event], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]![0]!.type).toBe("template");
    expect(JSON.stringify(replies[0])).toContain(GUIDED_MENU_COPY.txPrompt);
    expect(JSON.stringify(replies[0])).toContain(MENU_TOKEN_PREFIX);
    assertSingleGenuineRaw(db, "msg-menu-1", "message");
    assertNoBusinessSideEffects(db);
    expect(counts().pushCalls).toBe(0);
    expect(counts().multicastCalls).toBe(0);
  });

  it("similar text does not trigger Guided Menu", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedMappedSeller(db);
    const replies: LineApiMessage[][] = [];
    const { service } = makeService(db, replies);

    await service.processEvents([textEvent("เมนูหน่อย")], "dest");
    await service.processEvents([textEvent("เปิดเมนู")], "dest");
    expect(replies).toHaveLength(0);
  });

  it("unmapped operator refused on webhook", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedMarket({
      market_code: "wat_thung_lanna",
      label: "วัดทุ่งลานนา",
      active: true,
    });
    const replies: LineApiMessage[][] = [];
    const { service } = makeService(db, replies);
    const event = textEvent("เมนู", { webhookEventId: "msg-unmapped" });

    await service.processEvents([event], "dest");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual([
      { type: "text", text: GUIDED_MENU_COPY.unmapped },
    ]);
    assertSingleGenuineRaw(db, "msg-unmapped", "message");
    assertNoBusinessSideEffects(db);
  });

  it("postback walk uses reply only and ends by opening a real session", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedMappedSeller(db);
    const replies: LineApiMessage[][] = [];
    const { service, counts } = makeService(db, replies);

    const menuEvt = textEvent("เมนู", { webhookEventId: "msg-walk" });
    await service.processEvents([menuEvt], "dest");
    expect(db.tables.raw_messages).toHaveLength(1);

    const txActions = collectPostbackData(replies[0]);
    expect(txActions.length).toBe(3);

    const pbTx = postbackEvent(txActions[0]!, { webhookEventId: "pb-walk-tx" });
    await service.processEvents([pbTx], "dest");
    expect(db.tables.raw_messages).toHaveLength(2);
    expect(db.tables.raw_messages[1]!.line_event_id).toBe("pb-walk-tx");
    expect(db.tables.raw_messages[1]!.event_type).toBe("postback");

    const sellerTokens = collectPostbackData(replies[1]);
    const seller = sellerTokens.find(
      (t) => db.stateByWire(t)?.payload.seller_code === "seller_a",
    )!;
    await service.processEvents([
      postbackEvent(seller, { webhookEventId: "pb-walk-seller" }),
    ], "dest");

    const marketTokens = collectPostbackData(replies[2]);
    const market = marketTokens.find(
      (t) => db.stateByWire(t)?.payload.market_code === "wat_thung_lanna",
    )!;

    await service.processEvents([
      postbackEvent(market, { webhookEventId: "pb-walk-mkt" }),
    ], "dest");
    const today = collectPostbackData(replies[3]).find(
      (t) => db.stateByWire(t)?.payload.date_mode === "today",
    )!;

    await service.processEvents([
      postbackEvent(today, { webhookEventId: "pb-walk-date" }),
    ], "dest");
    expect(JSON.stringify(replies[4])).toContain("กำลังจะเปิดรายการ");
    expect(JSON.stringify(replies[4])).toContain("พี่ดำ");
    expect(JSON.stringify(replies[4])).toContain("วัดทุ่งลานนา");

    // Everything up to and including the preview is still write-free.
    assertNoBusinessSideEffects(db);

    const confirmTok = collectPostbackData(replies[4]).find(
      (t) => db.stateByWire(t)?.action_type === "confirm_open",
    )!;
    await service.processEvents([
      postbackEvent(confirmTok, { webhookEventId: "pb-walk-confirm" }),
    ], "dest");
    const openedReply = replies[5]![0]!;
    expect(openedReply.type).toBe("text");
    const openedText = (openedReply as { text: string }).text;
    expect(openedText).toContain("เปิดรายการเบิกแล้ว ✅");
    expect(openedText).toContain("คนขาย: พี่ดำ");
    expect(openedText).toContain("ตลาด: วัดทุ่งลานนา");
    expect(openedText).toContain(GUIDED_MENU_COPY.sendItemsHint);

    // Confirm opened exactly one real structured session, through the
    // authoritative RPC, with no append/admit/ingest side effects.
    expect(db.openProduceCalls).toBe(1);
    expect(db.tables.pending_sessions).toHaveLength(1);
    expect(db.tables.pending_sessions[0]!.entry_origin).toBe("structured_menu");
    expect(db.tables.pending_sessions[0]!.staff_label).toBe("พี่ดำ");
    expect(db.appendCalls).toBe(0);
    expect(db.admitCalls).toBe(0);
    expect(db.ingestCalls).toBe(0);
    expect(db.closeRpcCalls).toBe(0);
    expect(db.tables.pending_session_admission).toHaveLength(0);
    expect(db.tables.pending_session_ingest).toHaveLength(0);

    // Exactly one raw row per genuine inbound event; no synthetic extras.
    expect(db.tables.raw_messages).toHaveLength(6);
    expect(counts().pushCalls).toBe(0);
    expect(counts().multicastCalls).toBe(0);
    // One replyApiMessages call per handled Guided Menu event.
    expect(replies).toHaveLength(6);
  });

  it("wrong-user postback yields generic invalid reply", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedMappedSeller(db);
    db.seedOperator({
      line_user_id: "U-other",
      staff_label: "อื่น",
      active: true,
    });
    const replies: LineApiMessage[][] = [];
    const { service } = makeService(db, replies);

    await service.processEvents([textEvent("เมนู")], "dest");
    const token = collectPostbackData(replies[0])[0]!;

    await service.processEvents([
      postbackEvent(token, {
        source: { type: "group", groupId: "G-1", userId: "U-other" },
        webhookEventId: "pb-wrong",
      }),
    ], "dest");

    expect(replies.at(-1)).toEqual([
      { type: "text", text: GUIDED_MENU_COPY.invalidOrExpired },
    ]);
  });

  it("same-event postback replay is idempotent via handler after raw persist", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedMappedSeller(db);
    const replies: LineApiMessage[][] = [];
    const { service } = makeService(db, replies);

    await service.processEvents([textEvent("เมนู")], "dest");
    const token = collectPostbackData(replies[0])[0]!;
    const event = postbackEvent(token, { webhookEventId: "pb-same" });

    await service.processEvents([event], "dest");
    // Duplicate webhookEventId is rejected by raw_messages uniqueness (audit trail).
    // Same-event consume replay is covered at the Guided Menu handler boundary:
    const handler = new GuidedMenuUxHandler(db.asClient());
    const replay = await handler.handlePostback({
      wireToken: token,
      lineEventId: "pb-same",
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: "G-1",
        sessionKey: "group:G-1:user:U-op-1",
      },
      lineTimestampMs: TS,
    });
    expect(replay.screen).toBe("seller");
    expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(replies[1]));
  });

  it("supports DM/user source for เมนู", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedMappedSeller(db);
    const replies: LineApiMessage[][] = [];
    const { service } = makeService(db, replies);
    const source: LineSource = { type: "user", userId: "U-op-1" };
    const event = textEvent("เมนู", {
      webhookEventId: "msg-dm",
      source,
    });

    await service.processEvents([event], "dest");
    expect(replies).toHaveLength(1);
    expect(replies[0]![0]!.type).toBe("template");
    assertSingleGenuineRaw(db, "msg-dm", "message");
    expect(db.tables.raw_messages[0]!.source_type).toBe("user");
    expect(db.tables.raw_messages[0]!.source_id).toBe("U-op-1");
    assertNoBusinessSideEffects(db);
  });

  it("supports room source for เมนู and postback", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedMappedSeller(db);
    const replies: LineApiMessage[][] = [];
    const { service } = makeService(db, replies);
    const source: LineSource = {
      type: "room",
      roomId: "R-1",
      userId: "U-op-1",
    };

    await service.processEvents([
      textEvent("เมนู", { webhookEventId: "msg-room", source }),
    ], "dest");
    expect(replies).toHaveLength(1);
    assertSingleGenuineRaw(db, "msg-room", "message");
    expect(db.tables.raw_messages[0]!.source_type).toBe("room");

    const token = collectPostbackData(replies[0])[0]!;
    await service.processEvents([
      postbackEvent(token, { webhookEventId: "pb-room", source }),
    ], "dest");
    expect(replies).toHaveLength(2);
    expect(replies[1]![0]!.type).toBe("flex");
    expect(db.tables.raw_messages).toHaveLength(2);
    assertNoBusinessSideEffects(db);
  });

  it("malformed gpm1-looking postback gets invalid reply after raw persist", async () => {
    const db = new GuidedMenuFakeDatabase();
    const replies: LineApiMessage[][] = [];
    const { service } = makeService(db, replies);
    const event = postbackEvent("gpm1:not-a-valid-token!!", {
      webhookEventId: "pb-malformed",
    });

    await service.processEvents([event], "dest");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual([
      { type: "text", text: GUIDED_MENU_COPY.invalidOrExpired },
    ]);
    assertSingleGenuineRaw(db, "pb-malformed", "postback");
    assertNoBusinessSideEffects(db);
  });

  it("unrelated non-Guided postback stays on normal raw-only path", async () => {
    const db = new GuidedMenuFakeDatabase();
    const replies: LineApiMessage[][] = [];
    const { service } = makeService(db, replies);
    const event = postbackEvent("action=unrelated&v=1", {
      webhookEventId: "pb-other",
    });

    await service.processEvents([event], "dest");
    expect(replies).toHaveLength(0);
    assertSingleGenuineRaw(db, "pb-other", "postback");
    assertNoBusinessSideEffects(db);
  });
});
