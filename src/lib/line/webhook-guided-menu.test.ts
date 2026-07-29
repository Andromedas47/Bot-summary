import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent, LinePostbackEvent } from "./types";
import {
  GUIDED_MENU_COPY,
  GuidedMenuUxHandler,
  MENU_TOKEN_PREFIX,
} from "./guided-menu";
import { GuidedMenuFakeDatabase } from "./guided-menu/test-fake-db";
import type { LineApiMessage } from "./reply";

const TS = Date.parse("2026-07-29T10:00:00+07:00");

function textEvent(text: string, overrides: Partial<LineMessageEvent> = {}): LineMessageEvent {
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

describe("0051 Slice 2 — webhook Guided Menu", () => {
  it("exact เมนู opens transaction menu via reply API only", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: "U-op-1",
      staff_label: "พี่ดำ",
      active: true,
    });
    const replies: LineApiMessage[][] = [];
    const textReplies: string[] = [];
    let pushCalls = 0;

    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: new GuidedMenuUxHandler(db.asClient(), {
        markets: [{ code: "kee", label: "ตลาดกี้" }],
      }),
      replyApiMessages: async (_token, messages) => {
        replies.push(messages);
      },
      replyMessage: async (_token, text) => {
        textReplies.push(text);
      },
    });

    // Guard: if any code path used push, count it.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/message/push")) pushCalls += 1;
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      await service.processEvents([textEvent("เมนู")], "dest");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(replies).toHaveLength(1);
    expect(replies[0]![0]!.type).toBe("template");
    expect(JSON.stringify(replies[0])).toContain(GUIDED_MENU_COPY.txPrompt);
    expect(JSON.stringify(replies[0])).toContain(MENU_TOKEN_PREFIX);
    expect(textReplies).toHaveLength(0);
    expect(pushCalls).toBe(0);
    expect(db.openProduceCalls).toBe(0);
    expect(db.appendCalls).toBe(0);
    expect(db.admitCalls).toBe(0);
    expect(db.ingestCalls).toBe(0);
  });

  it("similar text does not trigger Guided Menu", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: "U-op-1",
      staff_label: "พี่ดำ",
      active: true,
    });
    const replies: LineApiMessage[][] = [];
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: new GuidedMenuUxHandler(db.asClient()),
      replyApiMessages: async (_token, messages) => {
        replies.push(messages);
      },
      replyMessage: async () => {},
    });

    await service.processEvents([textEvent("เมนูหน่อย")], "dest");
    await service.processEvents([textEvent("เปิดเมนู")], "dest");
    expect(replies).toHaveLength(0);
  });

  it("unmapped operator refused on webhook", async () => {
    const db = new GuidedMenuFakeDatabase();
    const replies: LineApiMessage[][] = [];
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: new GuidedMenuUxHandler(db.asClient()),
      replyApiMessages: async (_token, messages) => {
        replies.push(messages);
      },
    });

    await service.processEvents([textEvent("เมนู")], "dest");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual([
      { type: "text", text: GUIDED_MENU_COPY.unmapped },
    ]);
  });

  it("postback walk uses reply only and ends on Slice 3A placeholder", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: "U-op-1",
      staff_label: "พี่ดำ",
      active: true,
    });
    const replies: LineApiMessage[][] = [];
    const handler = new GuidedMenuUxHandler(db.asClient(), {
      markets: [{ code: "kee", label: "ตลาดกี้" }],
    });
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: handler,
      replyApiMessages: async (_token, messages) => {
        replies.push(messages);
      },
    });

    await service.processEvents([textEvent("เมนู")], "dest");
    const txActions = collectPostbackData(replies[0]);
    expect(txActions.length).toBe(3);

    await service.processEvents([postbackEvent(txActions[0]!)], "dest");
    const marketTokens = collectPostbackData(replies[1]);
    const kee = marketTokens.find(
      (t) => db.stateByWire(t)?.payload.market_code === "kee",
    )!;

    await service.processEvents([postbackEvent(kee)], "dest");
    const today = collectPostbackData(replies[2]).find(
      (t) => db.stateByWire(t)?.payload.date_mode === "today",
    )!;

    await service.processEvents([postbackEvent(today)], "dest");
    expect(JSON.stringify(replies[3])).toContain("กำลังจะเปิดรายการ");
    expect(JSON.stringify(replies[3])).toContain("ตลาดกี้");

    const confirmTok = collectPostbackData(replies[3]).find(
      (t) => db.stateByWire(t)?.action_type === "confirm_open",
    )!;
    await service.processEvents([postbackEvent(confirmTok)], "dest");
    expect(replies[4]).toEqual([
      { type: "text", text: GUIDED_MENU_COPY.confirmPlaceholder },
    ]);

    expect(db.openProduceCalls).toBe(0);
    expect(db.appendCalls).toBe(0);
    expect(db.admitCalls).toBe(0);
    expect(db.ingestCalls).toBe(0);
    expect(db.closeRpcCalls).toBe(0);
  });

  it("wrong-user postback yields generic invalid reply", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: "U-op-1",
      staff_label: "พี่ดำ",
      active: true,
    });
    db.seedOperator({
      line_user_id: "U-other",
      staff_label: "อื่น",
      active: true,
    });
    const replies: LineApiMessage[][] = [];
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: new GuidedMenuUxHandler(db.asClient(), {
        markets: [{ code: "kee", label: "ตลาดกี้" }],
      }),
      replyApiMessages: async (_token, messages) => {
        replies.push(messages);
      },
    });

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

  it("same-event postback replay is idempotent via webhook", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: "U-op-1",
      staff_label: "พี่ดำ",
      active: true,
    });
    const replies: LineApiMessage[][] = [];
    const service = new WebhookService(db.asClient(), {
      guidedMenuHandler: new GuidedMenuUxHandler(db.asClient(), {
        markets: [{ code: "kee", label: "ตลาดกี้" }],
      }),
      replyApiMessages: async (_token, messages) => {
        replies.push(messages);
      },
    });

    await service.processEvents([textEvent("เมนู")], "dest");
    const token = collectPostbackData(replies[0])[0]!;
    const event = postbackEvent(token, { webhookEventId: "pb-same" });

    await service.processEvents([event], "dest");
    // Duplicate raw_messages insert → skipped entirely on second delivery
    // Simulate same-event handler replay by calling processGuidedMenu path via
    // a fresh insert failure: instead re-invoke handlePostback semantics through
    // a second event with same id after clearing raw uniqueness... 
    // Use handler directly for replay after first webhook consume:
    const handler = new GuidedMenuUxHandler(db.asClient(), {
      markets: [{ code: "kee", label: "ตลาดกี้" }],
    });
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
    expect(replay.screen).toBe("market");
    expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(replies[1]));
  });
});
