/**
 * Regression coverage for the 2026-07-30 production incident: a guided
 * withdraw round captured "1. แตงโม 40 บาท\n3 ลูก" across two LINE messages,
 * "เมนู" reported zero items, and "จบรายการ" listed every raw line as an
 * independent, unrecognized error — including a typed "ยกเลิก" that had been
 * silently appended into the produce document.
 *
 * Root cause (two bugs, confirmed against the actual production row):
 *   1. RE.ITEM required the product name to start immediately after the
 *      item-number dot, so a typed "1. name price บาท" (dot then space)
 *      never matched — only the compact scale form "1.name price บาท" did.
 *   2. "ยกเลิก" / "ออกจากเมนู" had no plain-text interception anywhere in
 *      webhook-service.ts, so typed control text fell into the generic
 *      pending-session append and was written into accumulated_text.
 *
 * These tests exercise the read/parse side of both fixes directly through
 * GuidedSessionCaptureService — the same authoritative snapshot both
 * "เมนู" (renderCaptureStatus) and "จบรายการ" (requestClose) read from.
 */

import { describe, expect, it } from "bun:test";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GuidedSessionCaptureService } from "./session-capture";
import type { GuidedMenuIdentity } from "./ux-types";

const IDENTITY: GuidedMenuIdentity = {
  lineUserId: "U-op-1",
  sourceType: "group",
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};
const SESSION_KEY = "group:G-1:user:U-op-1";

function seedStructured(
  db: GuidedMenuFakeDatabase,
  accumulatedText: string,
  overrides: Record<string, unknown> = {},
): void {
  db.seedPendingSession({
    session_key: SESSION_KEY,
    source_id: "G-1",
    line_user_id: "U-op-1",
    session_generation: "gen-open",
    accumulated_text: accumulatedText,
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

describe("guided capture — multiline/multi-message reconstruction (production incident regression)", () => {
  it("1. a single multiline item message parses as one complete item", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedStructured(db, "\n1. แตงโม 40 บาท\n3 ลูก");
    const capture = new GuidedSessionCaptureService(db.asClient());

    const snapshot = await capture.snapshot(IDENTITY);
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") return;
    expect(snapshot.parsed.parse_errors).toEqual([]);
    expect(snapshot.parsed.items).toHaveLength(1);
    expect(snapshot.parsed.items[0]).toMatchObject({
      item_number: 1,
      product_name: "แตงโม",
      price_per_unit: 40,
      quantity: 3,
      unit: "ลูก",
    });
  });

  it("2. two multiline LINE messages reconstruct as two complete items", async () => {
    const db = new GuidedMenuFakeDatabase();
    // Exactly the production accumulated_text before the "ยกเลิก" line arrived —
    // append() joins each inbound LINE message with a single "\n".
    seedStructured(
      db,
      "\n1. แตงโม 40 บาท\n3 ลูก\n2. มะละกอ 20 บาท\n5 ลูก",
    );
    const capture = new GuidedSessionCaptureService(db.asClient());

    const snapshot = await capture.snapshot(IDENTITY);
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") return;
    expect(snapshot.parsed.parse_errors).toEqual([]);
    expect(snapshot.parsed.items).toHaveLength(2);
    expect(snapshot.parsed.items.map((i) => i.product_name)).toEqual([
      "แตงโม",
      "มะละกอ",
    ]);
    expect(snapshot.parsed.items.map((i) => i.quantity)).toEqual([3, 5]);
  });

  it("4. ดูรายการ (snapshot) and จบรายการ (requestClose) read the same reconstructed document", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedStructured(
      db,
      "\n1. แตงโม 40 บาท\n3 ลูก\n2. มะละกอ 20 บาท\n5 ลูก",
    );
    const capture = new GuidedSessionCaptureService(db.asClient());

    const viewed = await capture.snapshot(IDENTITY);
    expect(viewed.status).toBe("ok");
    if (viewed.status !== "ok") return;

    const closed = await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: 1_000,
    });
    expect(closed.status).toBe("closed");
    if (closed.status !== "closed") return;

    // Same accumulated_text, same seed, same parser call — item-for-item parity.
    expect(closed.parsed.items).toEqual(viewed.parsed.items);
    expect(db.closeRpcCalls).toBe(1);
  });

  it("9. an incomplete item line remains fail-closed at close time (no boundary created)", async () => {
    const db = new GuidedMenuFakeDatabase();
    // Item header with no following quantity line — genuinely incomplete.
    seedStructured(db, "\n1. แตงโม 40 บาท");
    const capture = new GuidedSessionCaptureService(db.asClient());

    const closed = await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: 1_000,
    });
    expect(closed.status).toBe("validation_failed");
    if (closed.status !== "validation_failed") return;
    expect(closed.errors.length).toBeGreaterThan(0);
    // No close boundary was created — the round stays open for correction.
    expect(db.closeRpcCalls).toBe(0);
    const [row] = db.tables.pending_sessions;
    expect(row!.close_event_timestamp_ms).toBeNull();
  });

  it("10. a legacy (entry_origin NULL) produce session is refused, not read, by guided capture", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedStructured(db, "1.แตงโม40บาท\n3ลูก", { entry_origin: null });
    const capture = new GuidedSessionCaptureService(db.asClient());

    const snapshot = await capture.snapshot(IDENTITY);
    expect(snapshot).toEqual({ status: "refused", reason: "not_structured" });
  });

  it("12. ownership protection is unchanged — a round recorded for another operator is refused", async () => {
    const db = new GuidedMenuFakeDatabase();
    // Same session key IDENTITY resolves to, but the row's recorded owner
    // differs — the existing ownership_conflict guard, untouched by this fix.
    seedStructured(db, "\n1. แตงโม 40 บาท\n3 ลูก", { line_user_id: "U-other" });
    const capture = new GuidedSessionCaptureService(db.asClient());

    const snapshot = await capture.snapshot(IDENTITY);
    expect(snapshot).toEqual({ status: "refused", reason: "ownership_conflict" });
  });
});
