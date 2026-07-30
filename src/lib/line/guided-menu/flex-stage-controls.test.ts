/**
 * Hotfix — Flex Message stage controls as the primary guided journey UX.
 */

import { describe, expect, it } from "bun:test";
import {
  GuidedMenuUxHandler,
  isExactGuidedCloseTrigger,
} from "./ux-handler";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GUIDED_MENU_COPY } from "./ux-types";
import { guidedControlLabels } from "./messages";

const IDENTITY = {
  lineUserId: "U-op-1",
  sourceType: "group" as const,
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};
const SESSION_KEY = "group:G-1:user:U-op-1";
const TS = Date.parse("2026-07-29T10:00:00+07:00");
const CAPTURED_TEXT = "1.ทุเรียน100บาท\n2โล\n2.มังคุด50บาท\n3โล";

function controlLabels(messages: unknown[]): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const labels = guidedControlLabels(messages[i]);
    if (labels.length > 0) return labels;
  }
  return [];
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

describe("Flex stage controls — capture and recovery", () => {
  it("recognises exact จบรายการ", () => {
    expect(isExactGuidedCloseTrigger("จบรายการ")).toBe(true);
    expect(isExactGuidedCloseTrigger("จบรายการเบิก")).toBe(false);
  });

  it("เมนู during capture renders the capture flex card", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);

    const menu = await handler.openMenu({ identity: IDENTITY });
    expect(menu.screen).toBe("session_status");
    expect(controlLabels(menu.messages)).toEqual([
      "ดูรายการ",
      "จบรายการ",
      "ออกจากเมนู",
    ]);
  });

  it("เมนู with no active journey opens the root menu", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const menu = await handler.openMenu({ identity: IDENTITY });
    expect(menu.screen).toBe("transaction_type");
  });

  it("exact จบรายการ returns a confirmation flex card", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);

    const closed = await handler.handleTextCloseRequest({
      identity: IDENTITY,
      lineEventId: "evt-text-close",
      lineTimestampMs: TS,
    });
    expect(closed.screen).toBe("session_close_requested");
    expect(controlLabels(closed.messages)).toEqual([
      "ดูรายการ",
      "ยืนยันจบรายการ",
      "กลับไปแก้ไข",
    ]);
  });

  it("เมนู during awaiting_confirm renders the confirm flex card", async () => {
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
    expect(controlLabels(menu.messages)).toEqual([
      "ดูรายการ",
      "ยืนยันจบรายการ",
      "กลับไปแก้ไข",
    ]);
  });

  it("capture acknowledgement includes a fresh flex control card", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db);

    const ack = await handler.renderCaptureAcknowledgement({ identity: IDENTITY });
    expect(ack?.screen).toBe("session_status");
    expect(ack?.messages[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("บันทึกรายการแล้ว"),
    });
    expect(controlLabels(ack?.messages ?? [])).toEqual([
      "ดูรายการ",
      "จบรายการ",
      "ออกจากเมนู",
    ]);
  });

  it("expired tokens fail closed with the required copy", async () => {
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
  });

  it("other operators cannot control the round", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { line_user_id: "U-other" });
    const { GuidedMenuStateService } = await import("./menu-state-service");
    const state = new GuidedMenuStateService(db.asClient());
    const created = await state.createState({
      actionType: "view_status",
      lineUserId: IDENTITY.lineUserId,
      sourceType: IDENTITY.sourceType,
      sourceId: IDENTITY.sourceId,
      sessionKey: IDENTITY.sessionKey,
      payload: {},
    });
    if (created.status !== "created") throw new Error("token mint refused");

    const status = await handler.handlePostback({
      wireToken: created.wireToken,
      lineEventId: "evt-other",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(status.screen).toBe("invalid");
  });
});
