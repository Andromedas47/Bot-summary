import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  GuidedMenuUxHandler,
  isExactGuidedMenuTrigger,
} from "./ux-handler";
import { formatThaiDateShort, resolveGuidedMenuDate } from "./dates";
import { assertGuidedMenuMessageLimits } from "./messages";
import { toMarketOption } from "./markets";
import { GuidedMenuStateService } from "./menu-state-service";
import { MENU_TOKEN_PREFIX, parseMenuToken } from "./menu-token";
import { GUIDED_MENU_COPY, TX_CODE_TO_LABEL } from "./ux-types";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import {
  buildSlice2EvidenceMessages,
  normalizeEvidenceTokens,
} from "./evidence";

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

function seededHandler(db: GuidedMenuFakeDatabase): GuidedMenuUxHandler {
  db.seedOperator({
    line_user_id: IDENTITY.lineUserId,
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
  return new GuidedMenuUxHandler(db.asClient());
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
    db.seedMarket({
      market_code: "wat_thung_lanna",
      label: "วัดทุ่งลานนา",
      active: true,
    });
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

  it("loads active markets from Slice 1 listActiveMarkets — not an independent list", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    db.seedMarket({
      market_code: "wat_thung_lanna",
      label: "วัดทุ่งลานนา",
      active: true,
    });
    db.seedMarket({
      market_code: "seven_front",
      label: "หน้าเซเวน",
      active: true,
    });
    db.seedMarket({
      market_code: "wat_taklam",
      label: "วัดตะกล่ำ",
      active: false,
    });
    const svc = new GuidedMenuStateService(db.asClient());
    const active = await svc.listActiveMarkets();
    expect(active.map((m) => m.marketCode).sort()).toEqual([
      "seven_front",
      "wat_thung_lanna",
    ]);
    expect(active.every((m) => m.active)).toBe(true);
    expect(toMarketOption(active[0]!).code).toBe(active[0]!.marketCode);
  });

  it("fails closed when no active sellers", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    const handler = new GuidedMenuUxHandler(db.asClient());
    const opened = await handler.openMenu({ identity: IDENTITY });
    const msg = opened.messages[0];
    if (msg.type !== "template") throw new Error("template");
    const seller = await handler.handlePostback({
      wireToken: msg.template.actions[0]!.data,
      lineEventId: "evt-no-seller",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(seller.screen).toBe("no_sellers");
    expect(seller.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.noActiveSellers,
    });
  });

  it("fails closed when an active seller has no active market assignment", async () => {
    const db = new GuidedMenuFakeDatabase();
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "พี่ดำ",
      active: true,
    });
    db.seedSeller({
      seller_code: "seller_a",
      label: "พี่ดำ",
      active: true,
      sort_order: 1,
    });
    db.seedMarket({
      market_code: "wat_thung_lanna",
      label: "วัดทุ่งลานนา",
      active: true,
    });
    db.seedSellerMarket({
      seller_code: "seller_a",
      market_code: "wat_thung_lanna",
      active: true,
      sort_order: 1,
    });
    const handler = new GuidedMenuUxHandler(db.asClient());
    const opened = await handler.openMenu({ identity: IDENTITY });
    const msg = opened.messages[0];
    if (msg.type !== "template") throw new Error("template");
    const seller = await handler.handlePostback({
      wireToken: msg.template.actions[0]!.data,
      lineEventId: "evt-no-assignment-tx",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const sellerToken = collectPostbackData(seller.messages).find(
      (token) => db.stateByWire(token)?.payload.seller_code === "seller_a",
    );
    db.seedSellerMarket({
      seller_code: "seller_a",
      market_code: "wat_thung_lanna",
      active: false,
      sort_order: 1,
    });
    const market = await handler.handlePostback({
      wireToken: sellerToken!,
      lineEventId: "evt-no-assignment-seller",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(market.screen).toBe("no_seller_markets");
    expect(market.messages).toEqual([
      { type: "text", text: GUIDED_MENU_COPY.noActiveSellerMarkets },
    ]);
  });

  it("lists only active sellers with a currently active market assignment", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db);
    db.seedSeller({
      seller_code: "ja",
      label: "จ๋า",
      active: true,
      sort_order: 2,
    });
    db.seedSeller({
      seller_code: "nang",
      label: "นาง",
      active: true,
      sort_order: 3,
    });

    const root = await handler.openMenu({ identity: IDENTITY });
    const tx = root.messages[0];
    if (tx.type !== "template") throw new Error("template");
    const seller = await handler.handlePostback({
      wireToken: tx.template.actions[0]!.data,
      lineEventId: "evt-filter-sellers",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const rendered = JSON.stringify(seller.messages);
    expect(rendered).toContain("พี่ดำ");
    expect(rendered).not.toContain("จ๋า");
    expect(rendered).not.toContain("นาง");
  });

  it("mapped operator gets transaction-type buttons with opaque gpm1 tokens", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db);

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
      expect(action.data).not.toContain("เบิก");
      expect(action.data).not.toContain("wat_thung_lanna");
      expect(action.data).not.toContain("withdraw");
    }
    assertGuidedMenuMessageLimits(opened.messages);
  });

  it("walks tx → seller → market → date → confirm → field-safe no-write placeholder", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db);

    const root = await handler.openMenu({ identity: IDENTITY });
    const txMsg = root.messages[0];
    if (txMsg.type !== "template") throw new Error("expected template");
    const withdrawToken = txMsg.template.actions[0]!.data;

    const seller = await handler.handlePostback({
      wireToken: withdrawToken,
      lineEventId: "evt-tx",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(seller.screen).toBe("seller");
    const sellerToken = collectPostbackData(seller.messages).find((t) => {
      const row = db.stateByWire(t);
      return row?.payload.seller_code === "seller_a";
    });
    expect(sellerToken).toBeTruthy();

    const market = await handler.handlePostback({
      wireToken: sellerToken!,
      lineEventId: "evt-seller",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(market.screen).toBe("market");
    const marketTokens = collectPostbackData(market.messages);
    const marketToken = marketTokens.find((t) => {
      const row = db.stateByWire(t);
      return row?.payload.market_code === "wat_thung_lanna";
    });
    expect(marketToken).toBeTruthy();

    const date = await handler.handlePostback({
      wireToken: marketToken!,
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
    expect(json).toContain("คนขาย: พี่ดำ");
    expect(json).toContain("ตลาด: วัดทุ่งลานนา");
    expect(json).toContain(`วันที่: ${formatThaiDateShort("2026-07-29")}`);
    expect(json).toContain("ยืนยัน");
    expect(confirm.result).toMatchObject({
      transaction_type: "withdraw",
      seller_code: "seller_a",
      market_code: "wat_thung_lanna",
      date_mode: "today",
    });
    expect(confirm.result).not.toHaveProperty("market_label");
    expect(confirm.result).not.toHaveProperty("seller_label");
    expect(confirm.result).not.toHaveProperty("transaction_label");

    const confirmToken = collectPostbackData(confirm.messages).find((t) => {
      const row = db.stateByWire(t);
      return row?.action_type === "confirm_open";
    });
    expect(confirmToken).toBeTruthy();

    const opened = await handler.handlePostback({
      wireToken: confirmToken!,
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(opened.screen).toBe("session_opened");
    expect(opened.confirmPlaceholder).toBe(false);
    const openedText = opened.messages[0];
    if (openedText.type !== "text") throw new Error("text");
    expect(openedText.text).toContain("เปิดรายการเบิกแล้ว ✅");
    expect(openedText.text).toContain("คนขาย: พี่ดำ");
    expect(openedText.text).toContain("ตลาด: วัดทุ่งลานนา");
    expect(openedText.text).toContain(
      `วันที่: ${formatThaiDateShort("2026-07-29")}`,
    );
    expect(openedText.text).toContain(GUIDED_MENU_COPY.sendItemsHint);
    expect(opened.result).toMatchObject({
      opened: true,
      transaction_type: "withdraw",
      seller_code: "seller_a",
      market_code: "wat_thung_lanna",
      business_date_iso: "2026-07-29",
      open_outcome: "opened",
    });
    // The session is real: the row the parser appends to now exists, carries
    // the operator's declared metadata, and no legacy text path was used.
    expect(db.openProduceCalls).toBe(1);
    const row = db.tables.pending_sessions[0]!;
    expect(row.entry_origin).toBe("structured_menu");
    expect(row.staff_label).toBe("พี่ดำ");
    expect(row.market_label).toBe("วัดทุ่งลานนา");
    expect(row.initial_transaction_type).toBe("เบิก");
    expect(row.session_kind).toBe("main");
    expect(row.business_date).toBe("2026-07-29");
    expect(row.opened_line_event_id).toBe("evt-confirm");
    expect(db.appendCalls).toBe(0);
    expect(db.admitCalls).toBe(0);
    expect(db.ingestCalls).toBe(0);
  });

  it("refuses when market becomes inactive before confirmation", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db);
    const root = await handler.openMenu({ identity: IDENTITY });
    const txMsg = root.messages[0];
    if (txMsg.type !== "template") throw new Error("template");
    const market = await handler.handlePostback({
      wireToken: txMsg.template.actions[0]!.data,
      lineEventId: "evt-tx-ina",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const sellerToken = collectPostbackData(market.messages).find((t) => {
      const row = db.stateByWire(t);
      return row?.payload.seller_code === "seller_a";
    });
    const marketScreen = await handler.handlePostback({
      wireToken: sellerToken!,
      lineEventId: "evt-seller-ina",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const marketToken = collectPostbackData(marketScreen.messages).find((t) => {
      const row = db.stateByWire(t);
      return row?.payload.market_code === "wat_thung_lanna";
    });
    db.seedMarket({
      market_code: "wat_thung_lanna",
      label: "วัดทุ่งลานนา",
      active: false,
    });
    const refused = await handler.handlePostback({
      wireToken: marketToken!,
      lineEventId: "evt-mkt-ina",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(refused.screen).toBe("invalid");
    expect(refused.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.invalidOrExpired,
    });
  });

  it("cancel and back navigate without business writes", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db);

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
      return (
        row?.action_type === "menu_root" && row.payload.intent === "cancel"
      );
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
      return (
        row?.action_type === "menu_root" &&
        !row.payload.intent &&
        Object.keys(row.payload).length === 0
      );
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
  });

  it("rejects wrong user/source, tampered token, and different-event already_consumed", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db);
    db.seedOperator({
      line_user_id: "U-other",
      staff_label: "อื่น",
      active: true,
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

    const ok = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-ok",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(ok.screen).toBe("seller");

    const conflict = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-other",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(conflict.screen).toBe("invalid");
    expect(JSON.stringify(conflict)).not.toContain("withdraw");
    expect(JSON.stringify(conflict.result)).not.toContain("action_type");
  });

  it("same-event replay is idempotent via recorded result", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db);
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
    const row = db.stateByWire(token);
    expect(row?.result).toBeTruthy();
  });

  it("same-event replay revalidates current seller activity", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db);
    const opened = await handler.openMenu({ identity: IDENTITY });
    const tx = opened.messages[0];
    if (tx.type !== "template") throw new Error("template");
    const sellerScreen = await handler.handlePostback({
      wireToken: tx.template.actions[0]!.data,
      lineEventId: "evt-revalidate-tx",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const sellerToken = collectPostbackData(sellerScreen.messages).find(
      (token) => db.stateByWire(token)?.payload.seller_code === "seller_a",
    );
    const first = await handler.handlePostback({
      wireToken: sellerToken!,
      lineEventId: "evt-revalidate-seller",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(first.screen).toBe("market");

    db.seedSeller({
      seller_code: "seller_a",
      label: "พี่ดำ",
      active: false,
      sort_order: 1,
    });
    const replay = await handler.handlePostback({
      wireToken: sellerToken!,
      lineEventId: "evt-revalidate-seller",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(replay.screen).toBe("invalid");
  });

  it("uses trusted labels and date helpers without payload market labels", () => {
    expect(TX_CODE_TO_LABEL.withdraw).toBe("เบิก");
    expect(resolveGuidedMenuDate("today", TS)?.thaiShort).toBe("29/07/2569");
    expect(resolveGuidedMenuDate("yesterday", TS)?.thaiShort).toBe("28/07/2569");
  });

  it("matches committed Thai UX evidence without rewriting the worktree", () => {
    const built = buildSlice2EvidenceMessages();
    const committedPath = join(
      process.cwd(),
      "guided-menu-slice2-evidence",
      "line-messages.json",
    );
    const committed = JSON.parse(readFileSync(committedPath, "utf8"));
    expect(built).toEqual(committed);
    expect(normalizeEvidenceTokens(built)).toEqual(
      normalizeEvidenceTokens(committed),
    );
    expect(built.seller).toHaveLength(2);
    expect(JSON.stringify(built.seller)).toContain("เลือกคนขาย (1/2)");
    expect(JSON.stringify(built.seller)).toContain("กี้");
    expect(JSON.stringify(built.market)).toContain("คนขาย: กี้");
    expect(JSON.stringify(built.date)).toContain("ตลาด: วัดทุ่งลานนา");
    expect(JSON.stringify(built.confirm)).toContain("วันที่: 25/07/2569");
    expect(JSON.stringify(built.no_seller_markets)).toContain(
      GUIDED_MENU_COPY.noActiveSellerMarkets,
    );
    expect(JSON.stringify(built.confirm_placeholder)).toContain(
      "ยังไม่ได้เปิดรายการ",
    );
    // Never claims a cancellation when nothing was cancelled — see §Copy.
    expect(JSON.stringify(built.cancelled)).not.toContain("ยกเลิกแล้ว");
    expect((built.cancelled[0] as { text: string }).text).toBe(
      GUIDED_MENU_COPY.cancelled,
    );
    expect(JSON.stringify(built.confirm_placeholder)).not.toMatch(/Slice\s*3A/i);
  });
});
