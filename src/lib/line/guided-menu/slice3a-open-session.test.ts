/**
 * Slice 3A — Guided Menu confirmation opens a REAL structured produce session.
 *
 * Covers the three transaction types, LINE retry idempotency, stale/replayed
 * buttons, cross-user and cross-source replay, catalog revocation between
 * button creation and press, and the existing-open-session guard.
 */

import { describe, expect, it } from "bun:test";
import { GuidedMenuUxHandler } from "./ux-handler";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GUIDED_MENU_COPY } from "./ux-types";
import {
  bangkokTimeHhMm,
  produceCommandSourceFromIdentity,
  TX_CODE_TO_BASE_TRANSACTION_TYPE,
} from "./session-opener";
import type { MenuTransactionTypeCode } from "./menu-state-types";

const IDENTITY = {
  lineUserId: "U-op-1",
  sourceType: "group" as const,
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};

const SESSION_KEY = "group:G-1:user:U-op-1";
const TS = Date.parse("2026-07-29T10:00:00+07:00");

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

/** Walk tx → seller → market → date and return the live confirm_open token. */
async function walkToConfirmToken(
  db: GuidedMenuFakeDatabase,
  handler: GuidedMenuUxHandler,
  tx: MenuTransactionTypeCode,
): Promise<string> {
  const root = await handler.openMenu({ identity: IDENTITY });
  const txToken = collectPostbackData(root.messages).find(
    (t) => db.stateByWire(t)?.payload.transaction_type === tx,
  )!;
  const seller = await handler.handlePostback({
    wireToken: txToken,
    lineEventId: `evt-tx-${tx}`,
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
  const sellerToken = collectPostbackData(seller.messages).find(
    (t) => db.stateByWire(t)?.payload.seller_code === "kee",
  )!;
  const market = await handler.handlePostback({
    wireToken: sellerToken,
    lineEventId: `evt-seller-${tx}`,
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
  const marketToken = collectPostbackData(market.messages).find(
    (t) => db.stateByWire(t)?.payload.market_code === "wat_thung_lanna",
  )!;
  const date = await handler.handlePostback({
    wireToken: marketToken,
    lineEventId: `evt-mkt-${tx}`,
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
  const todayToken = collectPostbackData(date.messages).find(
    (t) => db.stateByWire(t)?.payload.date_mode === "today",
  )!;
  const confirm = await handler.handlePostback({
    wireToken: todayToken,
    lineEventId: `evt-date-${tx}`,
    identity: IDENTITY,
    lineTimestampMs: TS,
  });
  return collectPostbackData(confirm.messages).find(
    (t) => db.stateByWire(t)?.action_type === "confirm_open",
  )!;
}

describe("Slice 3A — helpers", () => {
  it("maps menu codes to the parser's base transaction types", () => {
    expect(TX_CODE_TO_BASE_TRANSACTION_TYPE.withdraw).toBe("เบิก");
    expect(TX_CODE_TO_BASE_TRANSACTION_TYPE.return).toBe("คืน");
    expect(TX_CODE_TO_BASE_TRANSACTION_TYPE.damaged_return).toBe("คืนเสีย");
  });

  it("derives Bangkok HH:MM and refuses degenerate timestamps", () => {
    expect(bangkokTimeHhMm(TS)).toBe("10:00");
    expect(bangkokTimeHhMm(Date.parse("2026-07-29T00:30:00+07:00"))).toBe("00:30");
    expect(bangkokTimeHhMm(0)).toBeNull();
    expect(bangkokTimeHhMm(Number.NaN)).toBeNull();
  });

  it("binds group and room identities to their own id, never to the user", () => {
    expect(produceCommandSourceFromIdentity(IDENTITY)).toEqual({
      type: "group",
      sourceId: "G-1",
      groupId: "G-1",
      roomId: null,
      lineUserId: "U-op-1",
    });
    expect(
      produceCommandSourceFromIdentity({
        lineUserId: "U-1",
        sourceType: "room",
        sourceId: "R-1",
        sessionKey: "room:R-1:user:U-1",
      }),
    ).toMatchObject({ type: "room", roomId: "R-1", groupId: null });
  });
});

describe("Slice 3A — confirmation opens a real session", () => {
  const cases: Array<[MenuTransactionTypeCode, string, string]> = [
    ["withdraw", "เบิก", "เปิดรายการเบิกแล้ว ✅"],
    ["return", "คืน", "เปิดรายการชั่งคืนแล้ว ✅"],
    ["damaged_return", "คืนเสีย", "เปิดรายการคืนเสียแล้ว ✅"],
  ];

  for (const [code, baseType, heading] of cases) {
    it(`${code} happy path opens a main session seeded with ${baseType}`, async () => {
      const db = new GuidedMenuFakeDatabase();
      const handler = seed(db);
      const token = await walkToConfirmToken(db, handler, code);

      const opened = await handler.handlePostback({
        wireToken: token,
        lineEventId: `evt-confirm-${code}`,
        identity: IDENTITY,
        lineTimestampMs: TS,
      });

      expect(opened.screen).toBe("session_opened");
      const message = opened.messages[0];
      if (message.type !== "text") throw new Error("expected text");
      expect(message.text).toContain(heading);
      expect(message.text).toContain("คนขาย: กี้");
      expect(message.text).toContain("ตลาด: วัดทุ่งลานนา");
      expect(message.text).toContain("วันที่: 29/07/2569");
      expect(message.text).toContain(GUIDED_MENU_COPY.sendItemsHint);

      const row = db.tables.pending_sessions[0]!;
      expect(row.session_key).toBe(SESSION_KEY);
      expect(row.entry_origin).toBe("structured_menu");
      expect(row.session_kind).toBe("main");
      expect(row.initial_transaction_type).toBe(baseType);
      expect(row.declared_transaction_type).toBeNull();
      expect(row.additional_opener).toBeNull();
      // Seller is the produce staff_label (คนขาย) — never the operator's label.
      expect(row.staff_label).toBe("กี้");
      expect(row.market_label).toBe("วัดทุ่งลานนา");
      expect(row.business_date).toBe("2026-07-29");
      expect(row.transaction_time).toBe("10:00");
      expect(row.transaction_time_source).toBe("line_event");
      expect(row.line_user_id).toBe("U-op-1");
      expect(row.source_id).toBe("G-1");
      // A freshly opened session is immediately appendable by the parser.
      expect(row.terminalized).toBe(false);
      expect(row.accumulated_text).toBe("");
    });
  }

  it("resolves เมื่อวาน against the Bangkok calendar at press time", async () => {
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
    const yesterdayToken = collectPostbackData(date.messages).find(
      (t) => db.stateByWire(t)?.payload.date_mode === "yesterday",
    )!;
    const confirm = await handler.handlePostback({
      wireToken: yesterdayToken,
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
    expect(db.tables.pending_sessions[0]!.business_date).toBe("2026-07-28");
  });
});

describe("Slice 3A — idempotency and replay", () => {
  it("a redelivered confirm event replays the recorded reply and opens once", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await walkToConfirmToken(db, handler, "withdraw");

    const first = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-retry",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const openCallsAfterFirst = db.openProduceCalls;

    const retry = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-retry",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(first.screen).toBe("session_opened");
    expect(retry.screen).toBe("session_opened");
    expect(retry.messages).toEqual(first.messages);
    // The replay is served from the recorded result — no second RPC, one row,
    // and the generation the operator was told about is unchanged.
    expect(db.openProduceCalls).toBe(openCallsAfterFirst);
    expect(db.tables.pending_sessions).toHaveLength(1);
    expect(first.result.session_generation).toBe(
      retry.result.session_generation as string,
    );
  });

  it("a stale button pressed twice by different events refuses without writing", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await walkToConfirmToken(db, handler, "withdraw");

    await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-first",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const rowsAfterOpen = db.tables.pending_sessions.length;
    const callsAfterOpen = db.openProduceCalls;

    const stale = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-second",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(stale.screen).toBe("invalid");
    expect(stale.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.invalidOrExpired,
    });
    expect(db.openProduceCalls).toBe(callsAfterOpen);
    expect(db.tables.pending_sessions).toHaveLength(rowsAfterOpen);
  });

  it("an unknown token refuses without touching produce", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const outcome = await handler.handlePostback({
      wireToken: "gpm1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      lineEventId: "evt-unknown",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(outcome.screen).toBe("invalid");
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(0);
  });
});

describe("Slice 3A — cross-identity replay is refused", () => {
  it("another operator pressing the same confirm button writes nothing", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    db.seedOperator({
      line_user_id: "U-op-2",
      staff_label: "คนอื่น",
      active: true,
    });
    const token = await walkToConfirmToken(db, handler, "withdraw");

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-wrong-user",
      identity: {
        ...IDENTITY,
        lineUserId: "U-op-2",
        sessionKey: "group:G-1:user:U-op-2",
      },
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("invalid");
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(0);
  });

  it("the same button replayed from another group writes nothing", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await walkToConfirmToken(db, handler, "withdraw");

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-wrong-group",
      identity: {
        ...IDENTITY,
        sourceId: "G-2",
        sessionKey: "group:G-2:user:U-op-1",
      },
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("invalid");
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(0);
  });
});

describe("Slice 3A — catalog revalidation at press time", () => {
  it("refuses when the operator is deactivated after the button was minted", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await walkToConfirmToken(db, handler, "withdraw");
    db.seedOperator({
      line_user_id: IDENTITY.lineUserId,
      staff_label: "ผู้บันทึก",
      active: false,
    });

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-inactive-op",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("unmapped");
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(0);
  });

  /**
   * These three refuse at the DB consume boundary, not in the handler:
   * 0055/0056 guided_menu_payload_valid re-checks the active seller, active
   * market and active assignment when the token is redeemed, so a revoked
   * selection never reaches confirmOpen at all. The reply is deliberately the
   * generic invalid-menu copy — it discloses nothing about which catalog row
   * changed. What matters for 3A is that nothing is written either way.
   */
  it("refuses when the seller is deactivated after the button was minted", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await walkToConfirmToken(db, handler, "withdraw");
    db.seedSeller({
      seller_code: "kee",
      label: "กี้",
      active: false,
      sort_order: 1,
    });

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-inactive-seller",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("invalid");
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(0);
  });

  it("refuses when the market is deactivated after the button was minted", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await walkToConfirmToken(db, handler, "withdraw");
    db.seedMarket({
      market_code: "wat_thung_lanna",
      label: "วัดทุ่งลานนา",
      active: false,
    });

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-inactive-market",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("invalid");
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(0);
  });

  it("refuses when the seller→market assignment is revoked after the button was minted", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await walkToConfirmToken(db, handler, "withdraw");
    db.seedSellerMarket({
      seller_code: "kee",
      market_code: "wat_thung_lanna",
      active: false,
      sort_order: 1,
    });

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-revoked-assignment",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("invalid");
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(0);
  });

  /**
   * Handler-level revalidation still matters: a catalog row that stays active
   * but loses its label passes the DB payload check and must be caught here.
   */
  it("refuses when the seller label is blanked after the button was minted", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    const token = await walkToConfirmToken(db, handler, "withdraw");
    db.seedSeller({
      seller_code: "kee",
      label: "   ",
      active: true,
      sort_order: 1,
    });

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-blank-seller",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("seller_unavailable");
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(0);
  });
});

describe("Slice 3A — existing open session guard", () => {
  it("refuses and writes nothing when a live session already exists", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    db.seedPendingSession({
      session_key: SESSION_KEY,
      source_id: "G-1",
      line_user_id: "U-op-1",
      session_generation: "gen-existing",
      accumulated_text: "กี้ วัดทุ่งลานนา เบิก",
      terminalized: false,
      opened_line_event_id: "evt-earlier",
    });
    const token = await walkToConfirmToken(db, handler, "withdraw");

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-blocked",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_already_open");
    expect(outcome.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.sessionAlreadyOpen,
    });
    expect(outcome.result).toMatchObject({ opened: false, recorded: false });
    // Not one write: the pre-existing round keeps its generation and text.
    expect(db.openProduceCalls).toBe(0);
    expect(db.tables.pending_sessions).toHaveLength(1);
    expect(db.tables.pending_sessions[0]!.session_generation).toBe("gen-existing");
    expect(db.tables.pending_sessions[0]!.accumulated_text).toBe(
      "กี้ วัดทุ่งลานนา เบิก",
    );
  });

  it("rotates a terminalized row, carrying the observed generation for concurrency", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    db.seedPendingSession({
      session_key: SESSION_KEY,
      source_id: "G-1",
      line_user_id: "U-op-1",
      session_generation: "gen-done",
      accumulated_text: "รอบเก่า",
      terminalized: true,
      opened_line_event_id: "evt-old",
    });
    const token = await walkToConfirmToken(db, handler, "withdraw");

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-rotate",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_opened");
    expect(outcome.result).toMatchObject({ open_outcome: "rotated" });
    expect(db.tables.pending_sessions).toHaveLength(1);
    expect(db.tables.pending_sessions[0]!.terminalized).toBe(false);
    expect(db.tables.pending_sessions[0]!.accumulated_text).toBe("");
  });

  it("refuses when the row rotated between the guard read and the open", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    db.seedPendingSession({
      session_key: SESSION_KEY,
      source_id: "G-1",
      line_user_id: "U-op-1",
      session_generation: "gen-stale",
      accumulated_text: "",
      terminalized: true,
      opened_line_event_id: "evt-old",
    });
    const token = await walkToConfirmToken(db, handler, "withdraw");

    // Simulate a concurrent writer moving the row on after the lookup would
    // have observed gen-stale: the optimistic generation no longer matches.
    const originalRpc = db.rpc.bind(db);
    db.rpc = (async (name: string, args: Record<string, unknown>) => {
      if (name === "open_or_rotate_produce_structured_session") {
        db.seedPendingSession({
          session_key: SESSION_KEY,
          source_id: "G-1",
          line_user_id: "U-op-1",
          session_generation: "gen-moved-on",
          accumulated_text: "",
          terminalized: true,
          opened_line_event_id: "evt-old",
        });
      }
      return originalRpc(name, args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-raced",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_open_conflict");
    expect(outcome.result).toMatchObject({
      opened: false,
      reason: "generation_conflict",
    });
    expect(db.tables.pending_sessions[0]!.session_generation).toBe("gen-moved-on");
  });

  it("refuses when the session key is owned by a different LINE user", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    db.seedPendingSession({
      session_key: SESSION_KEY,
      source_id: "G-1",
      line_user_id: "U-someone-else",
      session_generation: "gen-other",
      accumulated_text: "",
      terminalized: true,
      opened_line_event_id: "evt-other",
    });
    const token = await walkToConfirmToken(db, handler, "withdraw");

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-owned",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_open_conflict");
    expect(outcome.result).toMatchObject({ reason: "ownership_conflict" });
    expect(db.tables.pending_sessions[0]!.line_user_id).toBe("U-someone-else");
  });
});
