import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  GuidedMenuUxHandler,
  isExactGuidedMenuTrigger,
} from "./ux-handler";
import { formatThaiDateShort, resolveGuidedMenuDate } from "./dates";
import {
  assertGuidedMenuMessageLimits,
  buildInvalidMenuMessage,
} from "./messages";
import { parseGuidedMenuMarketsEnv } from "./markets";
import { MENU_TOKEN_PREFIX, parseMenuToken } from "./menu-token";
import { GUIDED_MENU_COPY, TX_CODE_TO_LABEL } from "./ux-types";
import { GuidedMenuFakeDatabase } from "./test-fake-db";

const IDENTITY = {
  lineUserId: "U-op-1",
  sourceType: "group" as const,
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};

const TS = Date.parse("2026-07-29T10:00:00+07:00");

function collectPostbackData(value: unknown, out: string[] = []): string[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectPostbackData(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === "postback" && typeof obj.data === "string") {
    out.push(obj.data);
  }
  for (const child of Object.values(obj)) collectPostbackData(child, out);
  return out;
}

describe("0051 Slice 2 — Guided Menu UX", () => {
  it("triggers only on exact เมนู text", () => {
    expect(isExactGuidedMenuTrigger("เมนู")).toBe(true);
    expect(isExactGuidedMenuTrigger(" เมนู ")).toBe(true);
    expect(isExactGuidedMenuTrigger("เมนูหน่อย")).toBe(false);
    expect(isExactGuidedMenuTrigger("เปิดเมนู")).toBe(false);
    expect(isExactGuidedMenuTrigger("menu")).toBe(false);
    expect(isExactGuidedMenuTrigger("")).toBe(false);
  });

  it("refuses unmapped and inactive operators without display-name fallback", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = new GuidedMenuUxHandler(db.asClient());

    const unmapped = await handler.openMenu({ identity: IDENTITY });
    expect(unmapped.screen).toBe("unmapped");
    expect(unmapped.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.unmapped,
    });

    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: false,
    });
    const inactive = await handler.openMenu({ identity: IDENTITY });
    expect(inactive.screen).toBe("unmapped");
  });

  it("mapped operator gets transaction-type buttons with opaque gpm1 tokens", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    const handler = new GuidedMenuUxHandler(db.asClient(), {
      markets: [{ code: "kee", label: "ตลาดกี้" }],
    });

    const opened = await handler.openMenu({ identity: IDENTITY });
    expect(opened.screen).toBe("transaction_type");
    const msg = opened.messages[0];
    expect(msg.type).toBe("template");
    if (msg.type !== "template") throw new Error("expected template");
    expect(msg.template.text).toBe(GUIDED_MENU_COPY.txPrompt);
    expect(msg.template.actions.map((a) => a.label)).toEqual([
      "เบิก",
      "ชั่งคืน",
      "คืนเสีย",
    ]);
    for (const action of msg.template.actions) {
      expect(action.data.startsWith(MENU_TOKEN_PREFIX)).toBe(true);
      expect(parseMenuToken(action.data).ok).toBe(true);
      expect(action.data.length).toBeLessThanOrEqual(64);
      // Business labels must never appear in postback data.
      expect(action.data).not.toContain("เบิก");
      expect(action.data).not.toContain("kee");
      expect(action.data).not.toContain("withdraw");
    }
    assertGuidedMenuMessageLimits(opened.messages);
  });

  it("walks tx → market → date → confirm → Slice 3A placeholder", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    const handler = new GuidedMenuUxHandler(db.asClient(), {
      markets: [{ code: "kee", label: "ตลาดกี้" }],
    });

    const root = await handler.openMenu({ identity: IDENTITY });
    const txMsg = root.messages[0];
    if (txMsg.type !== "template") throw new Error("expected template");
    const withdrawToken = txMsg.template.actions[0]!.data;

    const market = await handler.handlePostback({
      wireToken: withdrawToken,
      lineEventId: "evt-tx",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(market.screen).toBe("market");
    const marketTokens = collectPostbackData(market.messages);
    const keeToken = marketTokens.find((t) => {
      const row = db.stateByWire(t);
      return row?.payload.market_code === "kee";
    });
    expect(keeToken).toBeTruthy();

    const date = await handler.handlePostback({
      wireToken: keeToken!,
      lineEventId: "evt-mkt",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(date.screen).toBe("date");
    const dateTokens = collectPostbackData(date.messages);
    const todayToken = dateTokens.find((t) => {
      const row = db.stateByWire(t);
      return row?.payload.date_mode === "today";
    });
    expect(todayToken).toBeTruthy();

    const confirm = await handler.handlePostback({
      wireToken: todayToken!,
      lineEventId: "evt-date",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(confirm.screen).toBe("confirm");
    const flex = confirm.messages[0];
    expect(flex.type).toBe("flex");
    const json = JSON.stringify(flex);
    expect(json).toContain("กำลังจะเปิดรายการ");
    expect(json).toContain("ประเภท: เบิก");
    expect(json).toContain("ตลาด: ตลาดกี้");
    expect(json).toContain(`วันที่: ${formatThaiDateShort("2026-07-29")}`);
    expect(json).toContain("ยืนยัน");
    expect(json).toContain("กลับ");
    expect(json).toContain("ยกเลิก");

    const confirmToken = collectPostbackData(confirm.messages).find((t) => {
      const row = db.stateByWire(t);
      return row?.action_type === "confirm_open";
    });
    expect(confirmToken).toBeTruthy();

    const placeholder = await handler.handlePostback({
      wireToken: confirmToken!,
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(placeholder.screen).toBe("confirm_placeholder");
    expect(placeholder.confirmPlaceholder).toBe(true);
    expect(placeholder.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.confirmPlaceholder,
    });
    expect(db.openProduceCalls).toBe(0);
    expect(db.appendCalls).toBe(0);
    expect(db.admitCalls).toBe(0);
    expect(db.ingestCalls).toBe(0);
  });

  it("cancel and back navigate without business writes", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    const handler = new GuidedMenuUxHandler(db.asClient(), {
      markets: [{ code: "kee", label: "ตลาดกี้" }],
    });

    const root = await handler.openMenu({ identity: IDENTITY });
    const txMsg = root.messages[0];
    if (txMsg.type !== "template") throw new Error("expected template");

    const market = await handler.handlePostback({
      wireToken: txMsg.template.actions[0]!.data,
      lineEventId: "evt-tx-2",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const cancelToken = collectPostbackData(market.messages).find((t) => {
      const row = db.stateByWire(t);
      return row?.action_type === "menu_root" && row.payload.step === "cancel";
    });
    expect(cancelToken).toBeTruthy();

    const cancelled = await handler.handlePostback({
      wireToken: cancelToken!,
      lineEventId: "evt-cancel",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(cancelled.screen).toBe("cancelled");
    expect(cancelled.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.cancelled,
    });

    const opened = await handler.openMenu({ identity: IDENTITY });
    const tmsg = opened.messages[0];
    if (tmsg.type !== "template") throw new Error("template");
    const mkt = await handler.handlePostback({
      wireToken: tmsg.template.actions[0]!.data,
      lineEventId: "evt-back-tx",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const backToken = collectPostbackData(mkt.messages).find((t) => {
      const row = db.stateByWire(t);
      return row?.action_type === "menu_root" && !row.payload.step;
    });
    expect(backToken).toBeTruthy();
    const back = await handler.handlePostback({
      wireToken: backToken!,
      lineEventId: "evt-back",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(back.screen).toBe("transaction_type");
    expect(db.openProduceCalls).toBe(0);
    expect(db.appendCalls).toBe(0);
    expect(db.admitCalls).toBe(0);
    expect(db.ingestCalls).toBe(0);
  });

  it("rejects wrong user/source, tampered token, and replay-conflict", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    db.seedOperator({
      line_user_id: "U-other",
      staff_label: "อื่น",
      active: true,
    });
    const handler = new GuidedMenuUxHandler(db.asClient(), {
      markets: [{ code: "kee", label: "ตลาดกี้" }],
    });

    const opened = await handler.openMenu({ identity: IDENTITY });
    const msg = opened.messages[0];
    if (msg.type !== "template") throw new Error("template");
    const token = msg.template.actions[0]!.data;

    const wrongUser = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-wrong-user",
      identity: { ...IDENTITY, lineUserId: "U-other" },
      lineTimestampMs: TS,
    });
    expect(wrongUser.screen).toBe("invalid");

    const wrongSource = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-wrong-src",
      identity: { ...IDENTITY, sourceId: "G-OTHER" },
      lineTimestampMs: TS,
    });
    expect(wrongSource.screen).toBe("invalid");

    const tampered = await handler.handlePostback({
      wireToken: token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"),
      lineEventId: "evt-tamp",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(tampered.screen).toBe("invalid");

    // Consume once, then different event → already_consumed → invalid
    const ok = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-ok",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(ok.screen).toBe("market");

    const conflict = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-other",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(conflict.screen).toBe("invalid");
  });

  it("same-event replay is idempotent", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    const handler = new GuidedMenuUxHandler(db.asClient(), {
      markets: [{ code: "kee", label: "ตลาดกี้" }],
    });
    const opened = await handler.openMenu({ identity: IDENTITY });
    const msg = opened.messages[0];
    if (msg.type !== "template") throw new Error("template");
    const token = msg.template.actions[0]!.data;

    const first = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-replay",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const second = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-replay",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(second.screen).toBe(first.screen);
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
  });

  it("never trusts market labels from payload — server config only", () => {
    const markets = parseGuidedMenuMarketsEnv("kee:ตลาดกี้,seven_front:หน้าเซเวน");
    expect(markets).toEqual([
      { code: "kee", label: "ตลาดกี้" },
      { code: "seven_front", label: "หน้าเซเวน" },
    ]);
    expect(TX_CODE_TO_LABEL.withdraw).toBe("เบิก");
    expect(resolveGuidedMenuDate("today", TS)?.thaiShort).toBe("29/07/2569");
    expect(resolveGuidedMenuDate("yesterday", TS)?.thaiShort).toBe("28/07/2569");
  });

  it("writes Thai UX JSON evidence for review", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    const handler = new GuidedMenuUxHandler(db.asClient(), {
      markets: [{ code: "kee", label: "ตลาดกี้" }],
    });

    const evidence: Record<string, unknown> = {};
    const root = await handler.openMenu({ identity: IDENTITY });
    evidence.transaction_type = root.messages;

    const txMsg = root.messages[0];
    if (txMsg.type !== "template") throw new Error("template");
    const market = await handler.handlePostback({
      wireToken: txMsg.template.actions[0]!.data,
      lineEventId: "ev-e1",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    evidence.market = market.messages;

    const kee = collectPostbackData(market.messages).find((t) => {
      return db.stateByWire(t)?.payload.market_code === "kee";
    })!;
    const date = await handler.handlePostback({
      wireToken: kee,
      lineEventId: "ev-e2",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    evidence.date = date.messages;

    const today = collectPostbackData(date.messages).find((t) => {
      return db.stateByWire(t)?.payload.date_mode === "today";
    })!;
    const confirm = await handler.handlePostback({
      wireToken: today,
      lineEventId: "ev-e3",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    evidence.confirm = confirm.messages;

    const confirmTok = collectPostbackData(confirm.messages).find((t) => {
      return db.stateByWire(t)?.action_type === "confirm_open";
    })!;
    const placeholder = await handler.handlePostback({
      wireToken: confirmTok,
      lineEventId: "ev-e4",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    evidence.confirm_placeholder = placeholder.messages;
    evidence.unmapped = (await handler.openMenu({
      identity: { ...IDENTITY, lineUserId: "U-none" },
    })).messages;
    evidence.invalid = [buildInvalidMenuMessage()];

    const dir = join(process.cwd(), "guided-menu-slice2-evidence");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "line-messages.json");
    writeFileSync(path, JSON.stringify(evidence, null, 2), "utf8");
    writeFileSync(
      join(dir, "README.md"),
      [
        "# Guided Menu Slice 2 Evidence",
        "",
        "Generated by `guided-menu-ux.test.ts`.",
        "",
        "- `line-messages.json` — actual LINE Messaging API message objects",
        "  (template / flex / text) for each UX screen.",
        "- Postback `data` values are opaque `gpm1:` tokens.",
        "- No merge, migration apply, deploy, or real LINE send.",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(path.endsWith("line-messages.json")).toBe(true);
  });
});
