/**
 * Slice 3B — guided capture, review and finalization of an open round.
 *
 * The operator never types a command between stages: every next action is a
 * single-use token bound to their identity and session key.
 */

import { describe, expect, it } from "bun:test";
import { GuidedMenuUxHandler } from "./ux-handler";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GUIDED_MENU_COPY, LINE_REPLY_MESSAGE_MAX } from "./ux-types";
import { splitTextForLineReply, guidedControlLabels } from "./messages";
import { GuidedSessionCaptureService } from "./session-capture";
import type { MenuActionType } from "./menu-state-types";

const IDENTITY = {
  lineUserId: "U-op-1",
  sourceType: "group" as const,
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};
const SESSION_KEY = "group:G-1:user:U-op-1";
const TS = Date.parse("2026-07-29T10:00:00+07:00");

/**
 * Two captured items that genuinely finalize: each product line is followed by
 * its quantity+unit line, so getWeighSessionFinalizationErrors is empty. A
 * price-only line parses into an item but can never finalize — see
 * review-produce-finalization.test.ts for that path.
 */
const CAPTURED_TEXT = "1.ทุเรียน100บาท\n2โล\n2.มังคุด50บาท\n3โล";

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

/** An already-open guided round with two captured item lines. */
function seedOpenRound(
  db: GuidedMenuFakeDatabase,
  overrides: Record<string, unknown> = {},
): void {
  db.seedPendingSession({
    session_key: SESSION_KEY,
    source_id: "G-1",
    line_user_id: "U-op-1",
    session_generation: "gen-open",
    accumulated_text: CAPTURED_TEXT,
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

/** Mint one live token for a session-bound action, as the screens do. */
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

function controlLabels(messages: unknown[]): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const labels = guidedControlLabels(messages[i]);
    if (labels.length > 0) return labels;
  }
  return [];
}

describe("Slice 3B — the open round carries its own next actions", () => {
  it("offers review and close on the open receipt, with no confirm yet", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
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

    const opened = await handler.handlePostback({
      wireToken: confirmToken,
      lineEventId: "e5",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(opened.screen).toBe("session_opened");
    expect(controlLabels(opened.messages)).toEqual([
      "ดูรายการ",
      GUIDED_MENU_COPY.closeItemsLabel,
      "ออกจากเมนู",
    ]);
    const text = (opened.messages[0] as { text: string }).text;
    expect(text).toContain(GUIDED_MENU_COPY.sendItemsHint);
    expect(text).toContain(GUIDED_MENU_COPY.closeWhenDoneHint);
    // Every action token is bound to this operator's session key.
    for (const token of collectPostbackData(opened.messages)) {
      expect(db.stateByWire(token)!.session_key).toBe(SESSION_KEY);
      expect(db.stateByWire(token)!.line_user_id).toBe("U-op-1");
    }
  });
});

describe("Slice 3B — ดูรายการที่บันทึกแล้ว", () => {
  it("shows the captured items parsed with the session's own frozen seed", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);
    const token = await mintActionToken(db, "view_status");

    const status = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-status",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(status.screen).toBe("session_status");
    const body = status.messages.map((m) => (m as { text: string }).text).join("\n");
    expect(body).toContain("ทุเรียน");
    expect(body).toContain("มังคุด");
    expect(body).toContain(GUIDED_MENU_COPY.correctionHint);
    expect(status.result).toMatchObject({ item_count: 2, close_requested: false });
    // Read-only: the round is untouched and still appendable.
    expect(db.tables.pending_sessions[0]!.accumulated_text).toBe(CAPTURED_TEXT);
    expect(db.tables.pending_sessions[0]!.close_event_timestamp_ms).toBeNull();
  });

  it("says so plainly when nothing has been captured yet", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { accumulated_text: "" });
    const token = await mintActionToken(db, "view_status");

    const status = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-empty",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(status.screen).toBe("session_status");
    expect((status.messages[0] as { text: string }).text).toContain(
      GUIDED_MENU_COPY.noCapturedItems,
    );
    expect(status.result).toMatchObject({ item_count: 0 });
  });

  it("refuses when no guided round is open", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await mintActionToken(db, "view_status");

    const status = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-none",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(status.screen).toBe("no_open_session");
    expect(status.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.noOpenSession,
    });
  });

  it("refuses a legacy text-opened session — structured commands never drive it", async () => {
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
    const token = await mintActionToken(db, "view_status");

    const status = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-legacy",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(status.screen).toBe("no_open_session");
    expect(status.result).toMatchObject({ reason: "not_structured" });
  });

  it("discloses nothing when the round belongs to another operator", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { line_user_id: "U-someone-else" });
    const token = await mintActionToken(db, "view_status");

    const status = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-other",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(status.screen).toBe("invalid");
    expect(status.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.invalidOrExpired,
    });
  });
});

describe("Slice 3B — จบรายการ sets the close barrier", () => {
  it("sets the immutable boundary and swaps close for confirm", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);
    const token = await mintActionToken(db, "request_close");

    const closed = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-close",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(closed.screen).toBe("session_close_requested");
    expect(closed.result).toMatchObject({ close_reason: "first_close" });
    expect(controlLabels(closed.messages)).toEqual([
      "ดูรายการ",
      "ยืนยันจบรายการ",
      "ออกจากเมนู",
    ]);
    expect(controlLabels(closed.messages)).not.toContain("กลับไปแก้ไข");
    expect(
      closed.messages.some((m) => (m as { type?: string }).type === "flex"),
    ).toBe(true);
    const summaryText = (
      closed.messages.find((m) => (m as { type?: string }).type === "text") as {
        text: string;
      }
    ).text;
    expect(summaryText).toContain(GUIDED_MENU_COPY.closeRequested);
    const row = db.tables.pending_sessions[0]!;
    expect(row.close_event_timestamp_ms).toBe(TS);
    expect(row.close_line_event_id).toBe("evt-close");
    expect(row.finalize_hold_until).toBeTruthy();
  });

  it("a second close request is a status read — the first boundary stands", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);

    const first = await handler.handlePostback({
      wireToken: await mintActionToken(db, "request_close"),
      lineEventId: "evt-close-1",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const second = await handler.handlePostback({
      wireToken: await mintActionToken(db, "request_close"),
      lineEventId: "evt-close-2",
      identity: IDENTITY,
      lineTimestampMs: TS + 60_000,
    });

    expect(first.result).toMatchObject({ close_reason: "first_close" });
    expect(second.result).toMatchObject({
      close_reason: "close_already_requested",
    });
    // The boundary is the FIRST close's timestamp and event id, unchanged.
    expect(db.tables.pending_sessions[0]!.close_event_timestamp_ms).toBe(TS);
    expect(db.tables.pending_sessions[0]!.close_line_event_id).toBe("evt-close-1");
  });

  it("a redelivered close postback replays the recorded reply", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);
    const token = await mintActionToken(db, "request_close");

    const first = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-close-retry",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const retry = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-close-retry",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(retry.messages).toEqual(first.messages);
    expect(db.tables.pending_sessions[0]!.close_line_event_id).toBe(
      "evt-close-retry",
    );
  });

  it("refuses when the round rotated under the button", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);
    const token = await mintActionToken(db, "request_close");

    const originalRpc = db.rpc.bind(db);
    db.rpc = (async (name: string, args: Record<string, unknown>) => {
      if (name === "close_produce_structured_session") {
        db.tables.pending_sessions[0]!.session_generation = "gen-moved-on";
      }
      return originalRpc(name, args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-raced-close",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_action_conflict");
    expect(outcome.result).toMatchObject({ reason: "generation_conflict" });
    expect(db.tables.pending_sessions[0]!.close_event_timestamp_ms).toBeNull();
  });
});

describe("Slice 3B — ยืนยันจบรายการ releases the hold", () => {
  it("confirms, shows the summary and hands off to the white sheet", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, {
      close_event_timestamp_ms: TS,
      close_line_event_id: "evt-close",
    });
    // The deferred finalizer completes successfully; only then is the round
    // allowed to read as saved.
    db.deferredFinalizerOutcome = "finalized";
    const token = await mintActionToken(db, "confirm_finalize");

    const done = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(done.screen).toBe("session_finalize_confirmed");
    const body = done.messages.map((m) => (m as { text: string }).text).join("\n");
    expect(body).toContain("บันทึกรายการสินค้าเรียบร้อย ✅");
    expect(body).toContain("ทุเรียน");
    expect(body).toContain(GUIDED_MENU_COPY.nextStepWhiteSheet);
    expect(done.result).toMatchObject({
      confirm_reason: "confirmed",
      produce_finalization: "finalized",
      next_step: "white_sheet",
    });
    expect(db.tables.pending_sessions[0]!.finalize_confirmed_at).toBeTruthy();
  });

  it("refuses to claim success while the close barrier is not satisfied", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, {
      close_event_timestamp_ms: TS,
      close_line_event_id: "evt-close",
    });
    db.finalizeNotReady = true;
    const token = await mintActionToken(db, "confirm_finalize");

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-not-ready",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_finalize_not_ready");
    expect((outcome.messages[0] as { text: string }).text).toBe(
      GUIDED_MENU_COPY.finalizeNotReady,
    );
    // Confirm stays reachable; nothing was released.
    expect(controlLabels(outcome.messages)).toContain("ยืนยันจบรายการ");
    expect(db.tables.pending_sessions[0]!.finalize_confirmed_at).toBeUndefined();
  });

  it("refuses to confirm a round whose close was never requested", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);
    const token = await mintActionToken(db, "confirm_finalize");

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-early-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_action_conflict");
    expect(outcome.result).toMatchObject({ reason: "not_closing" });
  });

  it("a repeated confirmation stays idempotent", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, {
      close_event_timestamp_ms: TS,
      close_line_event_id: "evt-close",
    });

    db.deferredFinalizerOutcome = "finalized";

    const first = await handler.handlePostback({
      wireToken: await mintActionToken(db, "confirm_finalize"),
      lineEventId: "evt-confirm-1",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const confirmedAt = db.tables.pending_sessions[0]!.finalize_confirmed_at;

    const second = await handler.handlePostback({
      wireToken: await mintActionToken(db, "confirm_finalize"),
      lineEventId: "evt-confirm-2",
      identity: IDENTITY,
      lineTimestampMs: TS + 1000,
    });

    expect(first.screen).toBe("session_finalize_confirmed");
    expect(second.screen).toBe("session_finalize_confirmed");
    // The confirmation instant is set once and never moved.
    expect(db.tables.pending_sessions[0]!.finalize_confirmed_at).toBe(confirmedAt);
    expect(db.tables.pending_sessions[0]!.finalize_confirm_line_event_id).toBe(
      "evt-confirm-1",
    );
  });
});

describe("Slice 3B — ยกเลิก does not void an open round", () => {
  it("dismisses the menu and says the round is still open", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);
    const { GuidedMenuStateService } = await import("./menu-state-service");
    const state = new GuidedMenuStateService(db.asClient());
    const created = await state.createState({
      actionType: "menu_root",
      lineUserId: IDENTITY.lineUserId,
      sourceType: IDENTITY.sourceType,
      sourceId: IDENTITY.sourceId,
      sessionKey: IDENTITY.sessionKey,
      payload: { intent: "cancel" },
    });
    if (created.status !== "created") throw new Error("mint refused");

    const outcome = await handler.handlePostback({
      wireToken: created.wireToken,
      lineEventId: "evt-cancel",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_menu_dismissed");
    const text = (outcome.messages[0] as { text: string }).text;
    expect(text).toBe(GUIDED_MENU_COPY.menuDismissedSessionOpen);
    expect(text).toContain("ยังเปิดอยู่");
    // Crucially the copy must not read as a cancelled round.
    expect(text).not.toBe(GUIDED_MENU_COPY.cancelled);
    expect(text).not.toContain("ยกเลิก");
    // And the round really is untouched.
    expect(db.tables.pending_sessions[0]!.terminalized).toBe(false);
    expect(db.tables.pending_sessions[0]!.accumulated_text).toBe(CAPTURED_TEXT);
  });

  it("falls back to plain ยกเลิกแล้ว when no round is open", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const { GuidedMenuStateService } = await import("./menu-state-service");
    const state = new GuidedMenuStateService(db.asClient());
    const created = await state.createState({
      actionType: "menu_root",
      lineUserId: IDENTITY.lineUserId,
      sourceType: IDENTITY.sourceType,
      sourceId: IDENTITY.sourceId,
      sessionKey: IDENTITY.sessionKey,
      payload: { intent: "cancel" },
    });
    if (created.status !== "created") throw new Error("mint refused");

    const outcome = await handler.handlePostback({
      wireToken: created.wireToken,
      lineEventId: "evt-cancel-idle",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("cancelled");
    expect(outcome.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.cancelled,
    });
  });
});

describe("Slice 3B — LINE reply budgets", () => {
  it("splits a long summary on line boundaries, in order, within five messages", () => {
    const line = "1.ทุเรียนหมอนทองพรีเมียมคัดพิเศษ 12 กิโลกรัม × 199 = 2388";
    const long = Array.from({ length: 400 }, () => line).join("\n");

    const parts = splitTextForLineReply(long, LINE_REPLY_MESSAGE_MAX);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(LINE_REPLY_MESSAGE_MAX);
    for (const part of parts) {
      expect([...part].length).toBeLessThanOrEqual(5000);
    }
    // Ordering is preserved and no line is cut in half.
    expect(parts[0]!.startsWith(line)).toBe(true);
    for (const part of parts.slice(0, -1)) {
      for (const l of part.split("\n")) expect(l).toBe(line);
    }
  });

  it("keeps a short summary in a single message", () => {
    expect(splitTextForLineReply("สั้น", LINE_REPLY_MESSAGE_MAX)).toEqual(["สั้น"]);
  });

  it("marks truncation explicitly rather than dropping content silently", () => {
    const line = "x".repeat(4000);
    const parts = splitTextForLineReply(
      Array.from({ length: 20 }, () => line).join("\n"),
      3,
    );
    expect(parts).toHaveLength(3);
    expect(parts[2]).toContain("ยาวเกินกว่าจะแสดงครบ");
  });
});

describe("Slice 3B — capture service binds to the right session", () => {
  it("refuses when the identity's session key disagrees with its source", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedOpenRound(db);
    const capture = new GuidedSessionCaptureService(db.asClient());

    const outcome = await capture.snapshot({
      ...IDENTITY,
      sessionKey: "group:G-9:user:U-op-1",
    });

    expect(outcome).toEqual({ status: "refused", reason: "session_key_mismatch" });
  });

  it("refuses a terminalized round", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedOpenRound(db, { terminalized: true });
    const capture = new GuidedSessionCaptureService(db.asClient());

    const outcome = await capture.snapshot(IDENTITY);

    expect(outcome).toEqual({ status: "refused", reason: "terminalized" });
  });
});
