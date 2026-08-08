/**
 * Hybrid Flex + Quick Reply UX for Guided Operations.
 *
 * LINE cannot edit or delete a bot's own past messages, so a persistent Flex
 * card sent on every capture/status tick piles up as permanent chat noise.
 * Quick Reply buttons vanish after the next message, which is what routine,
 * repeatable actions want. This suite proves the split: pre-open selection,
 * the one close-confirmation card and the one finalize-success/white-sheet
 * handoff card stay Flex; everything else (capture receipts, status polling,
 * routine stage navigation) is text + Quick Reply only.
 */

import { describe, expect, it } from "bun:test";
import { GuidedMenuUxHandler } from "./ux-handler";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GUIDED_MENU_COPY } from "./ux-types";
import { guidedControlLabels } from "./messages";
import type { GuidedJourneyContext, GuidedJourneyState } from "./journey";
import type { MenuActionType } from "./menu-state-types";

const IDENTITY = {
  lineUserId: "U-op-1",
  sourceType: "group" as const,
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};
const SESSION_KEY = "group:G-1:user:U-op-1";
const TS = Date.parse("2026-07-29T10:00:00+07:00");

const ONE_ITEM_TEXT = "1.ทุเรียน100บาท\n2โล";
const TWO_ITEM_TEXT = "1.ทุเรียน100บาท\n2โล\n2.มังคุด50บาท\n3โล";
const INVALID_TEXT = "ยกเลิก";

function hasFlex(messages: unknown[]): boolean {
  return messages.some((m) => (m as { type?: string }).type === "flex");
}

function controlLabels(messages: unknown[]): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const labels = guidedControlLabels(messages[i]);
    if (labels.length > 0) return labels;
  }
  return [];
}

function quickReplyOf(message: unknown): unknown {
  return (message as { quickReply?: unknown }).quickReply;
}

function seed(db: GuidedMenuFakeDatabase): GuidedMenuUxHandler {
  db.seedOperator({
    line_user_id: IDENTITY.lineUserId,
    staff_label: "ผู้บันทึก",
    active: true,
  });
  db.seedMarket({
    market_code: "wat_thung_lanna",
    label: "วัดทุ่งลานนา",
    active: true,
  });
  db.seedSeller({ seller_code: "kee", label: "กี้", active: true, sort_order: 1 });
  db.seedSellerMarket({
    seller_code: "kee",
    market_code: "wat_thung_lanna",
    active: true,
    sort_order: 1,
  });
  return new GuidedMenuUxHandler(db.asClient());
}

function seedOpenRound(
  db: GuidedMenuFakeDatabase,
  overrides: Record<string, unknown> = {},
): void {
  db.seedPendingSession({
    session_key: SESSION_KEY,
    source_id: "G-1",
    line_user_id: "U-op-1",
    session_generation: "gen-open",
    accumulated_text: TWO_ITEM_TEXT,
    terminalized: false,
    close_event_timestamp_ms: null,
    opened_line_event_id: "evt-open",
    entry_origin: "structured_menu",
    command_contract_version: 1,
    business_date: "2026-07-29",
    transaction_time: "10:00",
    transaction_time_source: "line_event",
    staff_label: "กี้",
    market_label: "วัดทุ่งลานนา",
    session_kind: "main",
    initial_transaction_type: "เบิก",
    declared_transaction_type: null,
    additional_opener: null,
    ...overrides,
  });
}

function seedClosedRound(
  db: GuidedMenuFakeDatabase,
  overrides: Record<string, unknown> = {},
): void {
  seedOpenRound(db, {
    close_event_timestamp_ms: TS,
    close_line_event_id: "evt-close",
    finalization_status: "pending",
    ...overrides,
  });
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

/** Walk the full pre-open wizard to a freshly opened round. */
async function openRoundViaWizard(
  db: GuidedMenuFakeDatabase,
  handler: GuidedMenuUxHandler,
) {
  const root = await handler.openMenu({ identity: IDENTITY });
  const txToken = collectPostbackData(root.messages).find(
    (t) => db.stateByWire(t)?.payload.transaction_type === "withdraw",
  )!;
  const seller = await handler.handlePostback({
    wireToken: txToken,
    lineEventId: "e1",
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
  const sellerToken = collectPostbackData(seller.messages).find(
    (t) => db.stateByWire(t)?.payload.seller_code === "kee",
  )!;
  const market = await handler.handlePostback({
    wireToken: sellerToken,
    lineEventId: "e2",
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
  const marketToken = collectPostbackData(market.messages).find(
    (t) => db.stateByWire(t)?.payload.market_code === "wat_thung_lanna",
  )!;
  const date = await handler.handlePostback({
    wireToken: marketToken,
    lineEventId: "e3",
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
  const todayToken = collectPostbackData(date.messages).find(
    (t) => db.stateByWire(t)?.payload.date_mode === "today",
  )!;
  const confirm = await handler.handlePostback({
    wireToken: todayToken,
    lineEventId: "e4",
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
  const confirmToken = collectPostbackData(confirm.messages).find(
    (t) => db.stateByWire(t)?.action_type === "confirm_open",
  )!;
  return handler.handlePostback({
    wireToken: confirmToken,
    lineEventId: "e5",
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
}

async function mintActionToken(
  db: GuidedMenuFakeDatabase,
  actionType: Extract<
    MenuActionType,
    "view_status" | "request_close" | "confirm_finalize"
  >,
): Promise<string> {
  const { GuidedMenuStateService } = await import("./menu-state-service");
  const state = new GuidedMenuStateService(db.asClient());
  const created = await state.createState({
    actionType,
    lineUserId: IDENTITY.lineUserId,
    sourceType: IDENTITY.sourceType,
    sourceId: IDENTITY.sourceId,
    sessionKey: IDENTITY.sessionKey,
    payload: {},
  });
  if (created.status !== "created") throw new Error("token mint refused");
  return created.wireToken;
}

const CONTEXT: GuidedJourneyContext = {
  sessionKey: SESSION_KEY,
  sourceId: "G-1",
  lineUserId: "U-op-1",
  sellerLabel: "กี้",
  marketLabel: "วัดทุ่งลานนา",
  marketLabelNormalized: "วัดทุ่งลานนา",
  businessDate: "2026-07-29",
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

function fakeJourney(state: GuidedJourneyState) {
  return { resolve: async () => state } as never;
}

/** A journey stage past capture — session row content is never read there. */
function stageState(
  stage: Exclude<GuidedJourneyState["stage"], "idle" | "capture" | "awaiting_confirm">,
): GuidedJourneyState {
  return {
    stage,
    context: CONTEXT,
    session: { session_key: CONTEXT.sessionKey } as never,
    whiteSheet: { status: "not_submitted" } as never,
  };
}

function seededStageHandler(
  db: GuidedMenuFakeDatabase,
  state: GuidedJourneyState,
): GuidedMenuUxHandler {
  db.seedOperator({
    line_user_id: IDENTITY.lineUserId,
    staff_label: "ผู้บันทึก",
    active: true,
  });
  return new GuidedMenuUxHandler(db.asClient(), {
    journeyService: fakeJourney(state),
  });
}

describe("Hybrid Guided UX — capture and pre-open (B, C)", () => {
  it("1. open success returns text + Quick Replies, no capture Flex card", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);

    const opened = await openRoundViaWizard(db, handler);

    expect(opened.screen).toBe("session_opened");
    expect(hasFlex(opened.messages)).toBe(false);
    expect(opened.messages).toHaveLength(1);
    expect(quickReplyOf(opened.messages[0])).toBeTruthy();
    expect(controlLabels(opened.messages)).toEqual([
      "ดูรายการ",
      GUIDED_MENU_COPY.closeItemsLabel,
      "ออกจากเมนู",
    ]);
  });

  it("2. first valid item returns count 1 + Quick Replies, no Flex", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { accumulated_text: ONE_ITEM_TEXT });

    const ack = await handler.renderCaptureAcknowledgement({ identity: IDENTITY });

    expect(ack).not.toBeNull();
    expect(hasFlex(ack!.messages)).toBe(false);
    expect(ack!.result).toMatchObject({ item_count: 1 });
    expect((ack!.messages[0] as { text: string }).text).toContain("1 รายการ");
    expect(controlLabels(ack!.messages)).toEqual([
      "ดูรายการ",
      GUIDED_MENU_COPY.closeItemsLabel,
      "ออกจากเมนู",
    ]);
  });

  it("3. second valid item returns count 2 + fresh Quick Replies, no Flex", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { accumulated_text: TWO_ITEM_TEXT });

    const ack = await handler.renderCaptureAcknowledgement({ identity: IDENTITY });

    expect(ack).not.toBeNull();
    expect(hasFlex(ack!.messages)).toBe(false);
    expect(ack!.result).toMatchObject({ item_count: 2 });
    expect((ack!.messages[0] as { text: string }).text).toContain("2 รายการ");
    const firstQr = quickReplyOf(ack!.messages[0]);
    expect(firstQr).toBeTruthy();
    expect(controlLabels(ack!.messages)).toEqual([
      "ดูรายการ",
      GUIDED_MENU_COPY.closeItemsLabel,
      "ออกจากเมนู",
    ]);
  });

  it("4. invalid item returns correction details + Quick Replies, no Flex", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { accumulated_text: INVALID_TEXT });

    const ack = await handler.renderCaptureAcknowledgement({ identity: IDENTITY });

    expect(ack).not.toBeNull();
    expect(hasFlex(ack!.messages)).toBe(false);
    expect(ack!.result).toMatchObject({ item_count: 0, parse_error_count: 1 });
    const text = (ack!.messages[0] as { text: string }).text;
    expect(text).not.toContain("บันทึกรายการแล้ว");
    expect(text).toContain(GUIDED_MENU_COPY.correctionHint);
    expect(controlLabels(ack!.messages)).toEqual([
      "ดูรายการ",
      GUIDED_MENU_COPY.closeItemsLabel,
      "ออกจากเมนู",
    ]);
  });

  it("5. exact เมนู during capture returns text + Quick Replies, no Flex", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);

    const menu = await handler.openMenu({ identity: IDENTITY });

    expect(menu.screen).toBe("session_status");
    expect(hasFlex(menu.messages)).toBe(false);
    expect(controlLabels(menu.messages)).toEqual([
      "ดูรายการ",
      GUIDED_MENU_COPY.closeItemsLabel,
      "ออกจากเมนู",
    ]);
  });

  it("6. exact เมนู with no active journey still returns root Flex menu", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);

    const menu = await handler.openMenu({ identity: IDENTITY });

    expect(menu.screen).toBe("transaction_type");
    expect(menu.messages[0]!.type).toBe("template");
  });
});

describe("Hybrid Guided UX — close confirmation stays Flex (D)", () => {
  it("7. exact จบรายการ returns one confirmation Flex card", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);

    const closed = await handler.handleTextCloseRequest({
      identity: IDENTITY,
      lineEventId: "evt-text-close",
      lineTimestampMs: TS,
    });

    expect(closed.screen).toBe("session_close_requested");
    expect(closed.messages.filter((m) => (m as { type?: string }).type === "flex")).toHaveLength(1);
    expect(controlLabels(closed.messages)).toEqual([
      "ดูรายการ",
      "ยืนยันจบรายการ",
      "ออกจากเมนู",
    ]);
  });

  it("8. awaiting-confirm exact เมนู returns the confirmation Flex card again", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);
    await handler.handleTextCloseRequest({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: TS,
    });

    const menu = await handler.openMenu({ identity: IDENTITY });

    expect(menu.screen).toBe("session_status");
    expect(hasFlex(menu.messages)).toBe(true);
    expect(controlLabels(menu.messages)).toEqual([
      "ดูรายการ",
      "ยืนยันจบรายการ",
      "ออกจากเมนู",
    ]);
  });
});

describe("Hybrid Guided UX — finalizing status stays text-only (E)", () => {
  it("9. finalizing status returns text + Quick Replies, no status Flex", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    db.deferredFinalizerOutcome = null;

    const outcome = await handler.handlePostback({
      wireToken: await mintActionToken(db, "confirm_finalize"),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_finalizing");
    expect(hasFlex(outcome.messages)).toBe(false);
    expect((outcome.messages[0] as { text: string }).text).toBe(
      GUIDED_MENU_COPY.produceFinalizing,
    );
    expect(controlLabels(outcome.messages)).toContain("ดูสถานะ");
    expect(controlLabels(outcome.messages)).toContain("ออกจากเมนู");
  });

  it("10. repeated ดูสถานะ while pending does not create repeated Flex cards", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    db.deferredFinalizerOutcome = null;

    await handler.handlePostback({
      wireToken: await mintActionToken(db, "confirm_finalize"),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    const first = await handler.handlePostback({
      wireToken: await mintActionToken(db, "view_status"),
      lineEventId: "evt-status-1",
      identity: IDENTITY,
      lineTimestampMs: TS + 1000,
    });
    const second = await handler.handlePostback({
      wireToken: await mintActionToken(db, "view_status"),
      lineEventId: "evt-status-2",
      identity: IDENTITY,
      lineTimestampMs: TS + 2000,
    });

    expect(first.screen).toBe("session_finalizing");
    expect(second.screen).toBe("session_finalizing");
    expect(hasFlex(first.messages)).toBe(false);
    expect(hasFlex(second.messages)).toBe(false);
  });
});

describe("Hybrid Guided UX — finalize success hands off with one Flex card (F)", () => {
  it("11. finalization success returns summary + white-sheet Flex card", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    db.deferredFinalizerOutcome = "finalized";

    const outcome = await handler.handlePostback({
      wireToken: await mintActionToken(db, "confirm_finalize"),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_finalize_confirmed");
    const body = outcome.messages
      .filter((m) => (m as { type?: string }).type === "text")
      .map((m) => (m as { text: string }).text)
      .join("\n");
    expect(body).toContain("บันทึกรายการสินค้าเรียบร้อย ✅");
    expect(
      outcome.messages.filter((m) => (m as { type?: string }).type === "flex"),
    ).toHaveLength(1);
    expect(controlLabels(outcome.messages)).toEqual([
      "กรอกใบขาว",
      "ดูสถานะ",
      "ออกจากเมนู",
    ]);
  });
});

describe("Hybrid Guided UX — later routine stages prefer Quick Replies (G, H, I, L)", () => {
  it("12a. white-sheet stage revisits are text + Quick Reply, no Flex", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededStageHandler(db, stageState("white_sheet"));

    const status = await handler.handlePostback({
      wireToken: await mintActionToken(db, "view_status"),
      lineEventId: "evt-ws",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(status.screen).toBe("white_sheet_template");
    expect(hasFlex(status.messages)).toBe(false);
    expect(controlLabels(status.messages)).toEqual([
      "กรอกใบขาว",
      "ดูสถานะ",
      "ออกจากเมนู",
    ]);
  });

  it("12b. slip stage revisits are text + Quick Reply, no Flex", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededStageHandler(db, stageState("slips"));

    const status = await handler.handlePostback({
      wireToken: await mintActionToken(db, "view_status"),
      lineEventId: "evt-slip",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(status.screen).toBe("slip_instructions");
    expect(hasFlex(status.messages)).toBe(false);
    expect(controlLabels(status.messages)).toEqual([
      GUIDED_MENU_COPY.closeSlipsLabel,
      "ดูสถานะ",
      "ออกจากเมนู",
    ]);
  });
});

describe("Hybrid Guided UX — expired tokens and legacy flows (K, functional preservation)", () => {
  it("13. expired tokens still fail closed with the required copy", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);

    const outcome = await handler.handlePostback({
      wireToken: "gpm1:AAAAAAAAAAAAAAAA",
      lineEventId: "evt-bad",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.invalidOrExpired,
    });
    expect(hasFlex(outcome.messages)).toBe(false);
  });

  it("14. a legacy (non-guided) pending session is refused untouched", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    db.seedPendingSession({
      session_key: SESSION_KEY,
      source_id: "G-1",
      line_user_id: "U-op-1",
      session_generation: "gen-legacy",
      accumulated_text: "กี้ วัดทุ่งลานนา เบิก",
      terminalized: false,
      entry_origin: null,
    });

    const status = await handler.handlePostback({
      wireToken: await mintActionToken(db, "view_status"),
      lineEventId: "evt-legacy",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(status.screen).toBe("no_open_session");
    expect(status.result).toMatchObject({ reason: "not_structured" });
  });

  it("15. no duplicate writes: repeated capture ack is read-only", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { accumulated_text: ONE_ITEM_TEXT });

    await handler.renderCaptureAcknowledgement({ identity: IDENTITY });
    await handler.renderCaptureAcknowledgement({ identity: IDENTITY });

    expect(db.tables.pending_sessions).toHaveLength(1);
    expect(db.tables.pending_sessions[0]!.accumulated_text).toBe(ONE_ITEM_TEXT);
  });

  it("16. existing Guided Operations UAT path remains green (open -> close -> confirm)", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { accumulated_text: TWO_ITEM_TEXT });
    db.deferredFinalizerOutcome = "finalized";

    const closed = await handler.handleTextCloseRequest({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: TS,
    });
    expect(closed.screen).toBe("session_close_requested");

    const confirmed = await handler.handlePostback({
      wireToken: await mintActionToken(db, "confirm_finalize"),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS + 1000,
    });
    expect(confirmed.screen).toBe("session_finalize_confirmed");
    expect(confirmed.result).toMatchObject({
      produce_finalization: "finalized",
      next_step: "white_sheet",
    });
    expect(db.tables.pending_sessions[0]!.finalize_confirmed_at).toBeTruthy();
  });
});
