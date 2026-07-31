/**
 * Slice 3D — slip status, reconciliation and closing the round.
 *
 * "ปิดรอบ" is the EXISTING settlement finalization. These tests prove the
 * blockers are the existing lifecycle states, that a slip is only ever called
 * verified when the existing evidence rules verify it, and that a retry never
 * closes twice.
 */

import { describe, expect, it } from "bun:test";
import { RoundFakeDatabase, type Row } from "./test-fake-round-db";
import {
  buildGuidedRoundReport,
  closeGuidedRound,
  loadGuidedSlipRows,
  summarizeSlipStatuses,
  GUIDED_SLIP_STATUS_LABEL,
  GUIDED_ROUND_BLOCKER_LABEL,
  type GuidedRoundBlocker,
} from "./round-close";
import { processGuidedRoundClose, isGuidedRoundCloseCommand } from "./journey-bridge";
import { buildRoundStatusMessage, splitTextForLineReply } from "./messages";
import { assertGuidedMenuMessageLimits } from "./messages";
import { GUIDED_MENU_COPY, LINE_REPLY_MESSAGE_MAX } from "./ux-types";
import type { GuidedJourneyContext, GuidedJourneyState } from "./journey";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";

const CONTEXT: GuidedJourneyContext = {
  sessionKey: "group:G-1:user:U-op-1",
  sourceId: SOURCE,
  lineUserId: "U-op-1",
  sellerLabel: "กี้",
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

/** Inside the business-date UTC window (prev 21:00Z → date 21:00Z). */
const IN_WINDOW = "2026-07-29T05:00:00Z";
const OUT_OF_WINDOW = "2026-07-27T05:00:00Z";

function baseDb(): RoundFakeDatabase {
  return new RoundFakeDatabase().seedKnownMarket({
    sourceId: SOURCE,
    businessDate: DATE,
    marketName: MARKET,
  });
}

/** One evidence row plus its check, with sane defaults. */
function seedSlip(
  db: RoundFakeDatabase,
  input: {
    id: string;
    market?: string | null;
    status?: string;
    amount?: number | null;
    reference?: string | null;
    transactionTime?: string | null;
    receivedAt?: string;
    createdAt?: string;
  },
): void {
  db.seed("slip_evidences", [
    {
      id: `ev-${input.id}`,
      source_id: SOURCE,
      market_label: input.market === undefined ? MARKET : input.market,
      market_label_normalized: input.market === undefined ? MARKET : input.market,
      received_at: input.receivedAt ?? IN_WINDOW,
    },
  ]);
  db.seed("slip_checks", [
    {
      id: input.id,
      evidence_id: `ev-${input.id}`,
      status: input.status ?? "EXTRACTED",
      transfer_amount: input.amount === undefined ? 1000 : input.amount,
      reference_id: input.reference === undefined ? `ref-${input.id}` : input.reference,
      transaction_time: input.transactionTime ?? IN_WINDOW,
      created_at: input.createdAt ?? IN_WINDOW,
    },
  ]);
}

function seedSettlement(db: RoundFakeDatabase, moneyTransfer: number, extra?: Row[]): void {
  db.seed("settlement_entries", [
    {
      source_id: SOURCE,
      settlement_date: DATE,
      settlement_time: "18:00",
      staff_name: "กี้",
      market_name: MARKET,
      money_transfer: moneyTransfer,
      money_cash: 0,
      expenses: 0,
      labor: 0,
      notes: null,
    },
    ...(extra ?? []),
  ]);
}

function fakeJourney(state: GuidedJourneyState) {
  return { resolve: async () => state } as never;
}

function reconcileState(): GuidedJourneyState {
  return {
    stage: "reconcile",
    context: CONTEXT,
    session: { session_key: CONTEXT.sessionKey } as never,
    whiteSheet: {
      status: "submitted",
      expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
      actualCashSubmitted: 0,
      updatedAt: IN_WINDOW,
    },
  };
}

describe("Slice 3D — per-slip status uses existing evidence truth", () => {
  it("classifies a clean, uniquely referenced, in-window slip as verified", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1" });
    const rows = await loadGuidedSlipRows(
      db.asClient() as never,
      CONTEXT,
      new Set([MARKET]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("verified");
  });

  it("never calls an unverified OCR status verified", async () => {
    for (const status of ["PROCESSING", "NEED_REVIEW", "FAILED"]) {
      const db = baseDb();
      seedSlip(db, { id: `c-${status}`, status });
      const rows = await loadGuidedSlipRows(
        db.asClient() as never,
        CONTEXT,
        new Set([MARKET]),
      );
      expect(rows[0]!.status).toBe("manual_review");
    }
  });

  it("treats a verified check with no reference id as manual review, not verified", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", reference: null });
    const rows = await loadGuidedSlipRows(
      db.asClient() as never,
      CONTEXT,
      new Set([MARKET]),
    );
    expect(rows[0]!.status).toBe("manual_review");
  });

  it("marks the later slip sharing a reference as a duplicate", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", reference: "SHARED", createdAt: "2026-07-29T05:00:00Z" });
    seedSlip(db, { id: "c2", reference: "SHARED", createdAt: "2026-07-29T06:00:00Z" });
    const rows = await loadGuidedSlipRows(
      db.asClient() as never,
      CONTEXT,
      new Set([MARKET]),
    );
    const byId = new Map(rows.map((r) => [r.checkId, r.status]));
    expect(byId.get("c1")).toBe("verified");
    expect(byId.get("c2")).toBe("duplicate");
  });

  it("marks a slip with no market attribution as market_unclear", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", market: null });
    const rows = await loadGuidedSlipRows(
      db.asClient() as never,
      CONTEXT,
      new Set([MARKET]),
    );
    expect(rows[0]!.status).toBe("market_unclear");
  });

  it("marks a slip attributed to an unknown market as market_unclear", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", market: "ตลาดที่ไม่รู้จัก" });
    const rows = await loadGuidedSlipRows(
      db.asClient() as never,
      CONTEXT,
      new Set([MARKET]),
    );
    expect(rows[0]!.status).toBe("market_unclear");
  });

  it("marks an out-of-window transaction time as date_mismatch", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", transactionTime: OUT_OF_WINDOW });
    const rows = await loadGuidedSlipRows(
      db.asClient() as never,
      CONTEXT,
      new Set([MARKET]),
    );
    expect(rows[0]!.status).toBe("date_mismatch");
  });

  it("summarizes counts in a stable display order with Thai labels", () => {
    const counts = summarizeSlipStatuses([
      { checkId: "1", status: "duplicate", amount: 1, referenceId: "a" },
      { checkId: "2", status: "verified", amount: 1, referenceId: "b" },
      { checkId: "3", status: "verified", amount: 1, referenceId: "c" },
      { checkId: "4", status: "manual_review", amount: null, referenceId: null },
    ]);
    expect(counts).toEqual([
      [GUIDED_SLIP_STATUS_LABEL.verified, 2],
      [GUIDED_SLIP_STATUS_LABEL.manual_review, 1],
      [GUIDED_SLIP_STATUS_LABEL.duplicate, 1],
    ]);
  });
});

describe("Slice 3D — blockers are existing lifecycle states", () => {
  async function blockersOf(
    db: RoundFakeDatabase,
    whiteSheetSubmitted = true,
  ): Promise<GuidedRoundBlocker[]> {
    const report = await buildGuidedRoundReport(
      db.asClient() as never,
      CONTEXT,
      whiteSheetSubmitted,
    );
    return report.blockers;
  }

  it("blocks when the white sheet has not been submitted", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1000);
    expect(await blockersOf(db, false)).toContain("white_sheet_not_submitted");
  });

  it("blocks while the slip batch is still collecting", async () => {
    const db = baseDb();
    db.seed("slip_batches", [{ id: "b1", source_id: SOURCE, status: "collecting" }]);
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1000);
    expect(await blockersOf(db)).toContain("slip_batch_open");
  });

  it("blocks while OCR is still processing", async () => {
    const db = baseDb();
    db.seed("slip_batches", [{ id: "b1", source_id: SOURCE, status: "processing" }]);
    seedSettlement(db, 0);
    expect(await blockersOf(db)).toContain("ocr_pending");
  });

  it("blocks while any slip still needs manual review", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", status: "NEED_REVIEW", amount: null, reference: null });
    seedSettlement(db, 0);
    expect(await blockersOf(db)).toContain("ocr_pending");
  });

  it("blocks while a manual slip session is open", async () => {
    const db = baseDb();
    db.seed("manual_slip_sessions", [
      { id: "m1", source_id: SOURCE, business_date: DATE, status: "open", market_label: MARKET },
    ]);
    seedSettlement(db, 0);
    expect(await blockersOf(db)).toContain("manual_slip_open");
  });

  it("blocks when attribution is ambiguous", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", market: null, amount: 500 });
    seedSettlement(db, 0);
    expect(await blockersOf(db)).toContain("attribution_ambiguous");
  });

  it("blocks when no settlement entry exists", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    const report = await buildGuidedRoundReport(db.asClient() as never, CONTEXT, true);
    expect(report.blockers).toContain("settlement_missing");
    // A missing settlement is never rendered as a zero.
    expect(report.totals.submittedTransferTotal).toBeNull();
    expect(report.totals.difference).toBeNull();
  });

  it("blocks when more than one settlement entry exists", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1000, [
      {
        source_id: SOURCE,
        settlement_date: DATE,
        settlement_time: "19:00",
        staff_name: "กี้",
        market_name: MARKET,
        money_transfer: 900,
      },
    ]);
    expect(await blockersOf(db)).toContain("settlement_ambiguous");
  });

  it("blocks on a non-zero difference and reports the exact amount", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1500);
    const report = await buildGuidedRoundReport(db.asClient() as never, CONTEXT, true);
    expect(report.blockers).toContain("difference_non_zero");
    expect(report.totals.checkedSlipTotal).toBe(1000);
    expect(report.totals.submittedTransferTotal).toBe(1500);
    expect(report.totals.difference).toBe(500);
  });

  it("uses checked = ai + manual and clears every blocker on an exact match", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    db.seed("manual_slip_sessions", [
      { id: "m1", source_id: SOURCE, business_date: DATE, status: "closed", market_label: MARKET },
    ]);
    db.seed("manual_slip_entries", [{ session_id: "m1", amount: 250 }]);
    seedSettlement(db, 1250);

    const report = await buildGuidedRoundReport(db.asClient() as never, CONTEXT, true);
    expect(report.totals.aiVerifiedTotal).toBe(1000);
    expect(report.totals.manualSlipTotal).toBe(250);
    expect(report.totals.checkedSlipTotal).toBe(1250);
    expect(report.totals.difference).toBe(0);
    expect(report.blockers).toEqual([]);
  });

  it("counts multiple verified slips towards the checked total", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 600 });
    seedSlip(db, { id: "c2", amount: 400 });
    seedSettlement(db, 1000);
    const report = await buildGuidedRoundReport(db.asClient() as never, CONTEXT, true);
    expect(report.slips.filter((s) => s.status === "verified")).toHaveLength(2);
    expect(report.totals.checkedSlipTotal).toBe(1000);
    expect(report.blockers).toEqual([]);
  });
});

describe("Slice 3D — closing the round", () => {
  it("does not touch settlement while any blocker remains", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1500);
    let pushed = 0;

    const outcome = await closeGuidedRound(
      db.asClient() as never,
      CONTEXT,
      true,
      async () => {
        pushed += 1;
      },
    );

    expect(outcome.status).toBe("blocked");
    expect(pushed).toBe(0);
    expect(db.tables.settlement_finalizations).toHaveLength(0);
  });

  it("closes through the existing settlement finalization on an exact match", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1000);
    db.seed("line_groups", []);

    const outcome = await closeGuidedRound(db.asClient() as never, CONTEXT, true);

    expect(outcome.report.blockers).toEqual([]);
    expect(outcome.status).toBe("closed");
    if (outcome.status !== "closed") throw new Error("expected closed");
    expect(outcome.settlement).toBe("finalized");
    // The round is closed by the EXISTING settlement finalization row.
    expect(db.tables.settlement_finalizations).toHaveLength(1);
    expect(db.tables.settlement_finalizations[0]).toMatchObject({
      source_id: SOURCE,
      business_date: DATE,
    });
  });

  it("a repeated close is idempotent — no second finalization row", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1000);

    const first = await closeGuidedRound(db.asClient() as never, CONTEXT, true);
    const rowsAfterFirst = db.tables.settlement_finalizations.length;
    const second = await closeGuidedRound(db.asClient() as never, CONTEXT, true);

    expect(first.status).toBe("closed");
    expect(second.status).toBe("closed");
    if (second.status !== "closed") throw new Error("expected closed");
    expect(second.settlement).toBe("already_done");
    expect(db.tables.settlement_finalizations).toHaveLength(rowsAfterFirst);
  });
});

/** processGuidedRoundClose only mints a start-new token on "closed"/"finalize_failed". */
const NOOP_STATE_SERVICE = {
  createState: async () => ({ status: "invalid_or_expired" as const }),
} as never;

function textOf(message: { type: string; text?: string }): string {
  if (message.type !== "text" || typeof message.text !== "string") {
    throw new Error(`expected a text message, got ${message.type}`);
  }
  return message.text;
}

describe("Slice 3D — the ตรวจและปิดรอบ / ปิดรอบ command", () => {
  it("matches only the exact word", () => {
    expect(isGuidedRoundCloseCommand("ปิดรอบ")).toBe(true);
    expect(isGuidedRoundCloseCommand("  ปิดรอบ  ")).toBe(true);
    expect(isGuidedRoundCloseCommand("ปิดรอบขาย")).toBe(false);
    expect(isGuidedRoundCloseCommand("ขอปิดรอบ")).toBe(false);
    expect(isGuidedRoundCloseCommand("ปิดยอด")).toBe(false);
    expect(isGuidedRoundCloseCommand("จบสลิป")).toBe(false);
  });

  it("refuses when there is no journey to close", async () => {
    const reply = await processGuidedRoundClose({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }),
      rounds: { report: async () => ({}), close: async () => ({}) } as never,
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: SOURCE,
        sessionKey: CONTEXT.sessionKey,
      },
      stateService: NOOP_STATE_SERVICE,
    });
    expect(reply.closed).toBe(false);
    expect(textOf(reply.messages[0]!)).toBe(GUIDED_MENU_COPY.roundCloseNoJourney);
  });

  it("refuses to skip past an unfinished produce round", async () => {
    for (const stage of ["capture", "awaiting_confirm"] as const) {
      const reply = await processGuidedRoundClose({
        journey: fakeJourney({
          stage,
          context: CONTEXT,
          session: {} as never,
          whiteSheet: { status: "not_submitted" },
        }),
        rounds: {
          report: async () => {
            throw new Error("must not be reached");
          },
          close: async () => {
            throw new Error("must not be reached");
          },
        } as never,
        identity: {
          lineUserId: "U-op-1",
          sourceType: "group",
          sourceId: SOURCE,
          sessionKey: CONTEXT.sessionKey,
        },
        stateService: NOOP_STATE_SERVICE,
      });
      expect(reply.closed).toBe(false);
      expect(textOf(reply.messages[0]!)).toContain("จบการกรอกสินค้า");
    }
  });

  it("case 1 — missing preconditions show only an actionable checklist, no accounting report", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSlip(db, { id: "c2", status: "NEED_REVIEW", amount: null, reference: null });
    seedSettlement(db, 1500);
    const { GuidedRoundService } = await import("./round-close");

    const reply = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds: new GuidedRoundService(db.asClient() as never),
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: SOURCE,
        sessionKey: CONTEXT.sessionKey,
      },
      stateService: NOOP_STATE_SERVICE,
    });

    expect(reply.closed).toBe(false);
    const text = textOf(reply.messages[0]!);
    expect(text).toContain(GUIDED_MENU_COPY.roundNotReadyHeading);
    // No full accounting report leaks into the missing-blockers screen.
    expect(text).not.toContain("ตรวจยอดรอบขาย");
    expect(text).not.toContain("ยอดสลิปที่ตรวจแล้ว");
    // ocr_pending is present (a NEED_REVIEW slip) — its one resolving action.
    expect(text).toContain("ดูสถานะ");
  });

  it("case 2 — a pure amount mismatch shows totals, difference and one recommended action", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 900);
    const { GuidedRoundService } = await import("./round-close");

    const reply = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds: new GuidedRoundService(db.asClient() as never),
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: SOURCE,
        sessionKey: CONTEXT.sessionKey,
      },
      stateService: NOOP_STATE_SERVICE,
    });

    expect(reply.closed).toBe(false);
    const text = textOf(reply.messages[0]!);
    expect(text).toContain(GUIDED_MENU_COPY.roundMismatchHeading);
    expect(text).toContain("1,000");
    expect(text).toContain("900");
    expect(text).toContain(GUIDED_MENU_COPY.roundMismatchNextStep);
    // Never both ตรวจยอด and ปิดรอบ offered as separate next steps.
    expect(text).not.toContain(GUIDED_MENU_COPY.roundNotReadyHeading);
  });

  /** A stateService stub that actually mints tokens, to assert real Quick Reply contents. */
  function mintingStateService(): { createState: () => Promise<{ status: "created"; wireToken: string }> } {
    let n = 0;
    return {
      createState: async () => {
        n += 1;
        return { status: "created" as const, wireToken: `gpm1:stub-${n}` };
      },
    };
  }

  function quickReplyLabelsAndTypes(message: unknown): Array<[string, string]> {
    const items =
      (message as { quickReply?: { items?: unknown[] } }).quickReply?.items ?? [];
    return items.map((item) => {
      const action = (item as { action: { label: string; type: string } }).action;
      return [action.label, action.type];
    });
  }

  it("case 1 — settlement_missing becomes the primary Quick Reply action (กรอกยอดส่ง)", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    // No settlement entry seeded at all — settlement_missing is the only blocker.
    const { GuidedRoundService } = await import("./round-close");

    const reply = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds: new GuidedRoundService(db.asClient() as never),
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: SOURCE,
        sessionKey: CONTEXT.sessionKey,
      },
      stateService: mintingStateService() as never,
    });

    expect(reply.closed).toBe(false);
    const text = textOf(reply.messages[0]!);
    expect(text).toContain("กรอกยอดส่ง");
    const message = reply.messages[0]! as { quickReply?: { items: unknown[] } };
    // ONE primary action ("กรอกยอดส่ง") — no duplicate ดูสถานะ needed since
    // it is not the primary label here, so it IS offered as secondary.
    expect(quickReplyLabelsAndTypes(message)).toEqual([
      ["กรอกยอดส่ง", "postback"],
      ["ดูสถานะ", "postback"],
    ]);
  });

  it("case 1 — a single ocr_pending blocker offers only ดูสถานะ, not a duplicate", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", status: "NEED_REVIEW", amount: null, reference: null });
    seedSettlement(db, 0);
    const { GuidedRoundService } = await import("./round-close");

    const reply = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds: new GuidedRoundService(db.asClient() as never),
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: SOURCE,
        sessionKey: CONTEXT.sessionKey,
      },
      stateService: mintingStateService() as never,
    });

    expect(reply.closed).toBe(false);
    const message = reply.messages[0]! as { quickReply?: { items: unknown[] } };
    expect(quickReplyLabelsAndTypes(message)).toEqual([["ดูสถานะ", "postback"]]);
  });

  it("case 2 — the mismatch screen's ONE Quick Reply is แก้ไขยอดส่ง, on the ONE message", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 900);
    const { GuidedRoundService } = await import("./round-close");

    const reply = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds: new GuidedRoundService(db.asClient() as never),
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: SOURCE,
        sessionKey: CONTEXT.sessionKey,
      },
      stateService: mintingStateService() as never,
    });

    expect(reply.closed).toBe(false);
    expect(reply.messages).toHaveLength(1);
    const message = reply.messages[0]! as { quickReply?: { items: unknown[] } };
    // แก้ไขยอดส่ง is the PRIMARY (first) action; ดูสถานะ is offered as the
    // only secondary — never a second, competing primary.
    expect(quickReplyLabelsAndTypes(message)).toEqual([
      [GUIDED_MENU_COPY.editSettlementLabel, "postback"],
      ["ดูสถานะ", "postback"],
    ]);
  });

  it("case 3 — the closed screen's ONE Quick Reply is เริ่มรายการใหม่", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1000);
    db.seed("line_groups", []);
    const { GuidedRoundService } = await import("./round-close");

    const reply = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds: new GuidedRoundService(db.asClient() as never),
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: SOURCE,
        sessionKey: CONTEXT.sessionKey,
      },
      stateService: mintingStateService() as never,
    });

    expect(reply.closed).toBe(true);
    const message = reply.messages[0]! as { quickReply?: { items: unknown[] } };
    expect(quickReplyLabelsAndTypes(message)).toEqual([
      [GUIDED_MENU_COPY.startNewLabel, "postback"],
    ]);
  });

  it("case 3 — matched totals close the round and offer เริ่มรายการใหม่", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1000);
    db.seed("line_groups", []);
    const { GuidedRoundService } = await import("./round-close");
    let startNewMinted = 0;
    const stateService = {
      createState: async () => {
        startNewMinted += 1;
        return { status: "created" as const, wireToken: "gpm1:stub" };
      },
    } as never;

    const reply = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds: new GuidedRoundService(db.asClient() as never),
      identity: {
        lineUserId: "U-op-1",
        sourceType: "group",
        sourceId: SOURCE,
        sessionKey: CONTEXT.sessionKey,
      },
      stateService,
    });

    expect(reply.closed).toBe(true);
    expect(textOf(reply.messages[0]!)).toBe(GUIDED_MENU_COPY.roundClosed);
    expect(startNewMinted).toBe(1);
    const quickReply = (reply.messages[0] as { quickReply?: { items: unknown[] } })
      .quickReply;
    expect(quickReply?.items.length).toBe(1);
  });

  it("a repeated close is idempotent — no second finalization row, same screen", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1000);
    const { GuidedRoundService } = await import("./round-close");
    const rounds = new GuidedRoundService(db.asClient() as never);
    const identity = {
      lineUserId: "U-op-1",
      sourceType: "group" as const,
      sourceId: SOURCE,
      sessionKey: CONTEXT.sessionKey,
    };

    const first = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds,
      identity,
      stateService: NOOP_STATE_SERVICE,
    });
    const second = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds,
      identity,
      stateService: NOOP_STATE_SERVICE,
    });

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(db.tables.settlement_finalizations).toHaveLength(1);
  });

  it("a repeated close while blocked stays blocked and writes nothing", async () => {
    const db = baseDb();
    seedSlip(db, { id: "c1", amount: 1000 });
    seedSettlement(db, 1500);
    const { GuidedRoundService } = await import("./round-close");
    const rounds = new GuidedRoundService(db.asClient() as never);
    const identity = {
      lineUserId: "U-op-1",
      sourceType: "group" as const,
      sourceId: SOURCE,
      sessionKey: CONTEXT.sessionKey,
    };

    const first = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds,
      identity,
      stateService: NOOP_STATE_SERVICE,
    });
    const second = await processGuidedRoundClose({
      journey: fakeJourney(reconcileState()),
      rounds,
      identity,
      stateService: NOOP_STATE_SERVICE,
    });

    expect(first.closed).toBe(false);
    expect(textOf(second.messages[0]!)).toBe(textOf(first.messages[0]!));
    expect(db.tables.settlement_finalizations).toHaveLength(0);
  });
});

describe("Slice 3D — receipt rendering and LINE budgets", () => {
  it("renders a closed receipt with a zero difference", () => {
    const message = buildRoundStatusMessage({
      sellerLabel: "กี้",
      marketLabel: MARKET,
      dateThaiShort: "29/07/2569",
      totals: {
        checkedSlipTotal: 1250,
        submittedTransferTotal: 1250,
        difference: 0,
      },
      slipCounts: [[GUIDED_SLIP_STATUS_LABEL.verified, 2]],
      blockerLines: [],
      closed: true,
    });
    expect(message.text).toContain("ปิดรอบเรียบร้อย ✅");
    expect(message.text).toContain("ยอดส่งตามใบขาว: 1,250 บาท");
    expect(message.text).toContain("ยอดสลิปที่ตรวจแล้ว: 1,250 บาท");
    expect(message.text).toContain("ผลต่าง: 0 บาท");
    expect(message.text).not.toContain("ยังปิดรอบไม่ได้");
    expect(() => assertGuidedMenuMessageLimits([message])).not.toThrow();
  });

  it("shows an em dash rather than a guessed zero for a missing settlement", () => {
    const message = buildRoundStatusMessage({
      sellerLabel: "กี้",
      marketLabel: MARKET,
      dateThaiShort: "29/07/2569",
      totals: { checkedSlipTotal: 0, submittedTransferTotal: null, difference: null },
      slipCounts: [],
      blockerLines: [GUIDED_ROUND_BLOCKER_LABEL.settlement_missing],
      closed: false,
    });
    expect(message.text).toContain("ยอดส่งตามใบขาว: —");
    expect(message.text).toContain("ผลต่าง: —");
  });

  it("stays within LINE's five-message and code-point limits", () => {
    const message = buildRoundStatusMessage({
      sellerLabel: "กี้",
      marketLabel: MARKET,
      dateThaiShort: "29/07/2569",
      totals: { checkedSlipTotal: 1, submittedTransferTotal: 1, difference: 0 },
      slipCounts: Object.values(GUIDED_SLIP_STATUS_LABEL).map(
        (label) => [label, 99] as [string, number],
      ),
      blockerLines: Object.values(GUIDED_ROUND_BLOCKER_LABEL),
      closed: false,
    });
    expect([...message.text].length).toBeLessThanOrEqual(5000);
    expect(
      splitTextForLineReply(message.text, LINE_REPLY_MESSAGE_MAX).length,
    ).toBeLessThanOrEqual(LINE_REPLY_MESSAGE_MAX);
    expect(() => assertGuidedMenuMessageLimits([message])).not.toThrow();
  });
});
