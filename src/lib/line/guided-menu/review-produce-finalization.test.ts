/**
 * PR #10 review finding #1 — never report produce success before the deferred
 * finalizer has proven the rows exist.
 *
 * Releasing the 0050 hold only satisfies the transport barrier. The round can
 * still terminalize as `failed_closed`, in which case nothing was saved and the
 * White Sheet must not be offered.
 */

import { describe, expect, it } from "bun:test";
import { GuidedMenuUxHandler } from "./ux-handler";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GuidedJourneyService } from "./journey";
import { GuidedSessionCaptureService } from "./session-capture";
import {
  classifyGuidedProduceFinalization,
  guidedProduceHandedToFinalizer,
  SUCCESSFUL_PRODUCE_FINALIZATION_STATUSES,
} from "./produce-finalization";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { MenuActionType } from "./menu-state-types";

const IDENTITY = {
  lineUserId: "U-op-1",
  sourceType: "group" as const,
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};
const SESSION_KEY = "group:G-1:user:U-op-1";
const TS = Date.parse("2026-07-29T10:00:00+07:00");

/** Two items that genuinely finalize: product line + quantity/unit line. */
const VALID_TEXT = "1.ทุเรียน100บาท\n2โล\n2.มังคุด50บาท\n3โล";
/** Parses into items but has no quantity/unit — the finalizer would reject it. */
const PARTIAL_TEXT = "1.ทุเรียน100บาท\n2.มังคุด50บาท";

function seed(db: GuidedMenuFakeDatabase): GuidedMenuUxHandler {
  db.seedOperator({
    line_user_id: IDENTITY.lineUserId,
    staff_label: "ผู้บันทึก",
    active: true,
  });
  db.seedMarket({ market_code: "wat", label: "วัดทุ่งลานนา", active: true });
  db.seedSeller({ seller_code: "kee", label: "กี้", active: true, sort_order: 1 });
  db.seedSellerMarket({
    seller_code: "kee",
    market_code: "wat",
    active: true,
    sort_order: 1,
  });
  return new GuidedMenuUxHandler(db.asClient());
}

function seedClosedRound(
  db: GuidedMenuFakeDatabase,
  overrides: Record<string, unknown> = {},
): void {
  db.seedPendingSession({
    session_key: SESSION_KEY,
    source_id: "G-1",
    line_user_id: "U-op-1",
    session_generation: "gen-open",
    accumulated_text: VALID_TEXT,
    terminalized: false,
    close_event_timestamp_ms: TS,
    close_line_event_id: "evt-close",
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
    finalization_status: "pending",
    ...overrides,
  });
}

async function mintConfirm(db: GuidedMenuFakeDatabase): Promise<string> {
  const { GuidedMenuStateService } = await import("./menu-state-service");
  const created = await new GuidedMenuStateService(db.asClient()).createState({
    actionType: "confirm_finalize" as Extract<MenuActionType, "confirm_finalize">,
    lineUserId: IDENTITY.lineUserId,
    sourceType: IDENTITY.sourceType,
    sourceId: IDENTITY.sourceId,
    sessionKey: IDENTITY.sessionKey,
    payload: {},
  });
  if (created.status !== "created") throw new Error("token mint failed");
  return created.wireToken;
}

async function mintStatus(db: GuidedMenuFakeDatabase): Promise<string> {
  const { GuidedMenuStateService } = await import("./menu-state-service");
  const created = await new GuidedMenuStateService(db.asClient()).createState({
    actionType: "view_status" as Extract<MenuActionType, "view_status">,
    lineUserId: IDENTITY.lineUserId,
    sourceType: IDENTITY.sourceType,
    sourceId: IDENTITY.sourceId,
    sessionKey: IDENTITY.sessionKey,
    payload: {},
  });
  if (created.status !== "created") throw new Error("token mint failed");
  return created.wireToken;
}

function bodyOf(result: { messages: unknown[] }): string {
  return result.messages.map((m) => (m as { text: string }).text).join("\n");
}

function quickReplyLabels(message: unknown): string[] {
  const quickReply = (message as { quickReply?: { items?: unknown[] } })
    ?.quickReply;
  return (quickReply?.items ?? []).map(
    (item) => (item as { action: { label: string } }).action.label,
  );
}

// ── The classifier itself ────────────────────────────────────────────────────

describe("produce finalization is decided by an allowlist", () => {
  it("accepts exactly finalized and duplicate", () => {
    expect([...SUCCESSFUL_PRODUCE_FINALIZATION_STATUSES]).toEqual([
      "finalized",
      "duplicate",
    ]);
    for (const status of SUCCESSFUL_PRODUCE_FINALIZATION_STATUSES) {
      expect(
        classifyGuidedProduceFinalization({ finalization_status: status, terminalized: true }),
      ).toBe("succeeded");
    }
  });

  it("treats failed_closed as failed, terminalized or not", () => {
    for (const terminalized of [true, false]) {
      expect(
        classifyGuidedProduceFinalization({
          finalization_status: "failed_closed",
          terminalized,
        }),
      ).toBe("failed");
    }
  });

  it("never treats an unknown status as success", () => {
    // A future/foreign status such as validation_failed must fail closed once
    // the row is terminal, and read as still running while it is live.
    expect(
      classifyGuidedProduceFinalization({
        finalization_status: "validation_failed" as never,
        terminalized: true,
      }),
    ).toBe("failed");
    expect(
      classifyGuidedProduceFinalization({
        finalization_status: "validation_failed" as never,
        terminalized: false,
      }),
    ).toBe("pending");
  });

  it("treats terminalized alone as failure, not success", () => {
    expect(
      classifyGuidedProduceFinalization({
        finalization_status: undefined,
        terminalized: true,
      }),
    ).toBe("failed");
  });

  it("reports a live pending/processing row as pending", () => {
    for (const status of ["pending", "processing"] as const) {
      expect(
        classifyGuidedProduceFinalization({ finalization_status: status, terminalized: false }),
      ).toBe("pending");
    }
  });

  it("knows when the round has been handed to the finalizer", () => {
    expect(
      guidedProduceHandedToFinalizer({ finalize_confirmed_at: null, terminalized: false }),
    ).toBe(false);
    expect(
      guidedProduceHandedToFinalizer({ finalize_confirmed_at: "now", terminalized: false }),
    ).toBe(true);
    expect(
      guidedProduceHandedToFinalizer({ finalize_confirmed_at: null, terminalized: true }),
    ).toBe(true);
  });
});

// ── Pre-confirm validation gate ─────────────────────────────────────────────

describe("a session that cannot finalize is never confirmed", () => {
  it("refuses a partial parse before releasing the hold", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db, { accumulated_text: PARTIAL_TEXT });

    const outcome = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_validation_failed");
    expect(bodyOf(outcome)).toContain(GUIDED_MENU_COPY.produceValidationFailed);
    // Zero writes: the hold was never released.
    expect(db.tables.pending_sessions[0]!.finalize_confirmed_at).toBeUndefined();
    expect(db.tables.pending_sessions[0]!.finalization_status).toBe("pending");
  });

  it("names the offending item without leaking internals", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db, { accumulated_text: PARTIAL_TEXT });

    const outcome = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    const body = bodyOf(outcome);
    // The existing buildWeighSessionValidationReply names the products; the raw
    // English validation string and any exception text stay out of LINE.
    expect(body).toContain("อ่านรายการไม่ครบ");
    expect(body).toContain("ทุเรียน");
    expect(body).toContain("มังคุด");
    expect(body).not.toContain("Error");
    expect(body).not.toContain("invalid quantity");
    expect(body).not.toContain("item #");
  });

  it("does not offer the white sheet on a validation failure", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db, { accumulated_text: PARTIAL_TEXT });

    const outcome = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(bodyOf(outcome)).not.toContain(GUIDED_MENU_COPY.nextStepWhiteSheet);
    expect(JSON.stringify(outcome.messages)).not.toContain("กรอกใบขาว");
  });

  it("keeps the journey out of the white-sheet stage for such a round", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedClosedRound(db, { accumulated_text: PARTIAL_TEXT });
    const state = await new GuidedJourneyService(db.asClient()).resolve(IDENTITY);
    expect(state.stage).toBe("awaiting_confirm");
  });
});

// ── After confirm: only a successful status is success ──────────────────────

describe("the reply after confirm reflects the authoritative row", () => {
  it("reports a still-pending finalizer as processing, not saved", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    // The deferred finalizer has NOT run — production's normal case.
    db.deferredFinalizerOutcome = null;

    const outcome = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_finalizing");
    expect(bodyOf(outcome)).toBe(GUIDED_MENU_COPY.produceFinalizing);
    expect(bodyOf(outcome)).not.toContain("เรียบร้อย ✅");
    expect(bodyOf(outcome)).not.toContain(GUIDED_MENU_COPY.nextStepWhiteSheet);
    expect(outcome.result).toMatchObject({ saved: false });
    // The hold really was released; only the claim of success is withheld.
    expect(db.tables.pending_sessions[0]!.finalize_confirmed_at).toBeTruthy();
  });

  it("offers the white sheet once the finalizer reports success", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    db.deferredFinalizerOutcome = "finalized";

    const outcome = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_finalize_confirmed");
    expect(bodyOf(outcome)).toContain(GUIDED_MENU_COPY.nextStepWhiteSheet);
    expect(outcome.result).toMatchObject({ produce_finalization: "finalized" });
  });

  it("treats a duplicate finalization as saved — the rows exist", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    db.deferredFinalizerOutcome = "duplicate";

    const outcome = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_finalize_confirmed");
    expect(outcome.result).toMatchObject({ produce_finalization: "duplicate" });
  });

  it("does not treat a terminalized failed_closed round as success", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    db.deferredFinalizerOutcome = "failed_closed";

    const outcome = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_finalize_failed");
    const body = bodyOf(outcome);
    expect(body).toContain("ไม่ได้บันทึกรายการนี้");
    expect(body).toContain("แจ้งผู้ดูแล");
    expect(body).not.toContain(GUIDED_MENU_COPY.nextStepWhiteSheet);
    expect(outcome.result).toMatchObject({ produce_finalization: "failed", saved: false });
  });

  it("does not treat an unknown terminal status as success either", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    db.deferredFinalizerOutcome = "validation_failed";

    const outcome = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("session_finalize_failed");
    expect(bodyOf(outcome)).not.toContain(GUIDED_MENU_COPY.nextStepWhiteSheet);
  });

  it("stays idempotent when a successful confirmation is repeated", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);
    db.deferredFinalizerOutcome = "finalized";

    const first = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm-1",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const confirmedAt = db.tables.pending_sessions[0]!.finalize_confirmed_at;

    const second = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm-2",
      identity: IDENTITY,
      lineTimestampMs: TS + 1000,
    });

    expect(first.screen).toBe("session_finalize_confirmed");
    expect(second.screen).toBe("session_finalize_confirmed");
    expect(db.tables.pending_sessions[0]!.finalize_confirmed_at).toBe(confirmedAt);
    expect(db.tables.pending_sessions).toHaveLength(1);
  });
});

// ── ดูสถานะ re-reads the authoritative state ────────────────────────────────

describe("ดูสถานะ re-reads the produce outcome", () => {
  it("turns a pending finalization into success once it completes", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);

    const pending = await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(pending.screen).toBe("session_finalizing");

    // The deferred finalizer completes between presses.
    db.runDeferredFinalizer("finalized");

    const after = await handler.handlePostback({
      wireToken: await mintStatus(db),
      lineEventId: "evt-status",
      identity: IDENTITY,
      lineTimestampMs: TS + 2000,
    });
    // Produce rows now exist, so the journey has genuinely advanced and the
    // status screen renders the next stage — the White Sheet template.
    expect(after.screen).toBe("white_sheet_template");
    expect(bodyOf(after)).toContain("ปิดยอด 29/07/2569");
  });

  it("turns a pending finalization into the failure reply when it fails", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedClosedRound(db);

    await handler.handlePostback({
      wireToken: await mintConfirm(db),
      lineEventId: "evt-confirm",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    db.runDeferredFinalizer("failed_closed");

    const after = await handler.handlePostback({
      wireToken: await mintStatus(db),
      lineEventId: "evt-status",
      identity: IDENTITY,
      lineTimestampMs: TS + 2000,
    });
    expect(after.screen).toBe("session_finalize_failed");
    // No action offers the white sheet; only "ดูสถานะ" and the exit remain.
    expect(quickReplyLabels(after.messages[0])).toEqual(["ดูสถานะ", "ออกจากเมนู"]);
  });

  it("keeps a failed round out of every later stage", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedClosedRound(db, {
      finalize_confirmed_at: "2026-07-29T04:00:00Z",
      terminalized: true,
      finalization_status: "failed_closed",
    });

    const state = await new GuidedJourneyService(db.asClient()).resolve(IDENTITY);
    expect(state.stage).toBe("finalize_failed");
  });

  it("reports a round still with the finalizer as finalizing", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedClosedRound(db, {
      finalize_confirmed_at: "2026-07-29T04:00:00Z",
      terminalized: false,
      finalization_status: "processing",
    });

    const state = await new GuidedJourneyService(db.asClient()).resolve(IDENTITY);
    expect(state.stage).toBe("finalizing");
  });

  it("exposes the same three outcomes through the capture service", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedClosedRound(db, {
      finalize_confirmed_at: "2026-07-29T04:00:00Z",
      terminalized: true,
      finalization_status: "finalized",
    });

    const capture = new GuidedSessionCaptureService(db.asClient());
    const outcome = await capture.produceOutcome(IDENTITY);
    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") return;
    expect(outcome.produce).toBe("finalized");
    expect(outcome.parsed.items).toHaveLength(2);
  });
});
