/**
 * Slice 3D.1 — guided settlement submission ("ส่งยอด").
 *
 * These tests prove three things:
 *   1. the generated template is exactly what the parser accepts (round trip);
 *   2. every binding failure refuses BEFORE the authoritative write, so a
 *      refusal never leaves a settlement row behind;
 *   3. the write itself is the existing POST /api/settlement boundary, so a
 *      retry updates one row instead of creating an ambiguous second one.
 */

import { describe, expect, it } from "bun:test";
import { RoundFakeDatabase, type Row } from "./test-fake-round-db";
import {
  buildSettlementTemplate,
  isGuidedSettlementCommandText,
  parseGuidedSettlementCommand,
  processGuidedSettlementSubmission,
} from "./settlement-command";
import { extractGuidedMarker } from "./provenance";
import { processGuidedRoundClose } from "./journey-bridge";
import { GuidedRoundService } from "./round-close";
import {
  assertGuidedMenuMessageLimits,
  buildSettlementSavedMessage,
} from "./messages";
import { GUIDED_MENU_COPY, LINE_REPLY_MESSAGE_MAX } from "./ux-types";
import type { GuidedMenuIdentity } from "./ux-types";
import type { GuidedJourneyContext, GuidedJourneyState } from "./journey";
import type { WhiteSheetCashEntryState } from "@/lib/white-sheet/persist";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";
const SELLER = "กี้";
const IN_WINDOW = "2026-07-29T05:00:00Z";

const CONTEXT: GuidedJourneyContext = {
  sessionKey: "group:G-1:user:U-op-1",
  sourceId: SOURCE,
  lineUserId: "U-op-1",
  sellerLabel: SELLER,
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

const IDENTITY: GuidedMenuIdentity = {
  lineUserId: "U-op-1",
  sourceType: "group",
  sourceId: SOURCE,
  sessionKey: CONTEXT.sessionKey,
};

const SUBMITTED_SHEET: WhiteSheetCashEntryState = {
  status: "submitted",
  expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
  actualCashSubmitted: 0,
  updatedAt: IN_WINDOW,
};

const FINALIZED_SHEET: WhiteSheetCashEntryState = {
  status: "finalized",
  expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
  actualCashSubmitted: 0,
  updatedAt: IN_WINDOW,
  finalizedAt: IN_WINDOW,
  finalizedBy: "admin-1",
};

function state(
  whiteSheet: WhiteSheetCashEntryState = SUBMITTED_SHEET,
): GuidedJourneyState {
  return {
    stage: "reconcile",
    context: CONTEXT,
    session: { session_key: CONTEXT.sessionKey } as never,
    whiteSheet,
  };
}

function fakeJourney(resolved: GuidedJourneyState) {
  return {
    resolve: async () => resolved,
    findRoundOwner: async () => ({
      kind: "owned",
      lineUserId: CONTEXT.lineUserId,
      sessionKey: CONTEXT.sessionKey,
    }),
  } as never;
}

function baseDb(): RoundFakeDatabase {
  return new RoundFakeDatabase().seedKnownMarket({
    sourceId: SOURCE,
    businessDate: DATE,
    marketName: MARKET,
  });
}

/** One verified transfer slip so checked_slip_total is a real number. */
function seedVerifiedSlip(db: RoundFakeDatabase, id: string, amount: number): void {
  db.seed("slip_evidences", [
    {
      id: `ev-${id}`,
      source_id: SOURCE,
      market_label: MARKET,
      market_label_normalized: MARKET,
      received_at: IN_WINDOW,
    },
  ]);
  db.seed("slip_checks", [
    {
      id,
      evidence_id: `ev-${id}`,
      status: "EXTRACTED",
      transfer_amount: amount,
      reference_id: `ref-${id}`,
      transaction_time: IN_WINDOW,
      created_at: IN_WINDOW,
    },
  ]);
}

function template(overrides: Partial<Record<string, string>> = {}): string {
  let text = extractGuidedMarker(buildSettlementTemplate(CONTEXT)!).text;
  for (const [from, to] of Object.entries(overrides)) {
    text = text.replace(from, to!);
  }
  return text;
}

async function submit(
  db: RoundFakeDatabase,
  text: string,
  resolved: GuidedJourneyState = state(),
  marker = extractGuidedMarker(buildSettlementTemplate(CONTEXT)!).marker,
) {
  return processGuidedSettlementSubmission({
    supabase: db.asClient(),
    journey: fakeJourney(resolved),
    rounds: new GuidedRoundService(db.asClient()),
    identity: IDENTITY,
    text,
    marker,
  });
}

function entries(db: RoundFakeDatabase): Row[] {
  return db.tables.settlement_entries;
}

// ── Template and parser ───────────────────────────────────────────────────────

describe("guided settlement template", () => {
  it("renders the exact fields the settlement contract accepts", () => {
    expect(extractGuidedMarker(buildSettlementTemplate(CONTEXT)!).text).toBe(
      [
        "กี้ วัดทุ่งลานนา ส่งยอด 29/07/2569",
        "ยอดโอน 0",
        "เงินสด 0",
        "ค่าใช้จ่าย 0",
        "ค่าแรง 0",
        "จบส่งยอด",
      ].join("\n"),
    );
  });

  it("round-trips through its own parser", () => {
    const parsed = parseGuidedSettlementCommand(template());
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.command.subject).toBe("กี้ วัดทุ่งลานนา");
    expect(parsed.command.businessDate).toBe(DATE);
    expect(parsed.command.moneyTransfer).toBe(0);
  });

  it("returns null for an unusable business date", () => {
    expect(
      buildSettlementTemplate({ ...CONTEXT, businessDate: "not-a-date" }),
    ).toBeNull();
  });

  it("parses the amounts the White Sheet money rules already accept", () => {
    const parsed = parseGuidedSettlementCommand(
      template({
        "ยอดโอน 0": "ยอดโอน 12,500.50",
        "เงินสด 0": "เงินสด 3000",
        "ค่าใช้จ่าย 0": "ค่าใช้จ่าย 250.25",
        "ค่าแรง 0": "ค่าแรง 800",
      }),
    );
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.command.moneyTransfer).toBe(12500.5);
    expect(parsed.command.moneyCash).toBe(3000);
    expect(parsed.command.expenses).toBe(250.25);
    expect(parsed.command.labor).toBe(800);
  });

  it("leaves unrelated messages alone", () => {
    for (const text of [
      "แตงโม 10 ลูก 500",
      "วัดทุ่งลานนา ปิดยอด 29/07/2569\nเงินสด 0\nจบปิดยอด",
      "ปิดรอบ",
      "จบสลิป",
    ]) {
      expect(parseGuidedSettlementCommand(text).kind).toBe("not_command");
      expect(isGuidedSettlementCommandText(text)).toBe(false);
    }
  });

  it("claims a message carrying the guided settlement header", () => {
    expect(isGuidedSettlementCommandText(template())).toBe(true);
  });

  it("tolerates LINE transcript export prefixes", () => {
    const prefixed = template()
      .split("\n")
      .map((line) => `09:12 กี้ ${line}`)
      .join("\n");
    expect(parseGuidedSettlementCommand(prefixed).kind).toBe("ok");
  });

  it("rejects an invalid amount", () => {
    for (const bad of ["ยอดโอน abc", "ยอดโอน -100", "ยอดโอน 1.234", "ยอดโอน 1,00"]) {
      const parsed = parseGuidedSettlementCommand(
        template({ "ยอดโอน 0": bad }),
      );
      expect(parsed.kind).toBe("invalid");
      if (parsed.kind === "invalid") {
        expect(parsed.message).toContain("จำนวนเงินไม่ถูกต้อง");
      }
    }
  });

  it("rejects a missing required field", () => {
    const withoutCash = template()
      .split("\n")
      .filter((line) => !line.startsWith("เงินสด"))
      .join("\n");
    const parsed = parseGuidedSettlementCommand(withoutCash);
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.message).toContain("เงินสด");
  });

  it("rejects a duplicated field line", () => {
    const parsed = parseGuidedSettlementCommand(
      template({ "ยอดโอน 0": "ยอดโอน 100\nยอดโอน 200" }),
    );
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.message).toContain("ซ้ำ");
  });

  it("rejects a missing closing line", () => {
    const parsed = parseGuidedSettlementCommand(
      template().replace("\nจบส่งยอด", ""),
    );
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.message).toContain("จบส่งยอด");
  });

  it("rejects an unknown line", () => {
    const parsed = parseGuidedSettlementCommand(
      template({ "ค่าแรง 0": "ค่าน้ำมัน 50" }),
    );
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.message).toContain("ไม่รู้จัก");
  });

  it("rejects an impossible date", () => {
    const parsed = parseGuidedSettlementCommand(
      template({ "29/07/2569": "32/07/2569" }),
    );
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.message).toContain("วันที่ไม่ถูกต้อง");
  });
});

// ── Binding: everything is refused before the write ───────────────────────────

describe("guided settlement binding", () => {
  it("accepts the owner's signed template", async () => {
    const db = baseDb();
    const reply = await submit(db, template());
    expect(reply.saved).toBe(true);
    expect(entries(db)).toHaveLength(1);
  });

  it("rejects a copied or tampered signed template before writing", async () => {
    const generated = extractGuidedMarker(buildSettlementTemplate(CONTEXT)!);
    const copied = await processGuidedSettlementSubmission({
      supabase: baseDb().asClient(),
      journey: fakeJourney(state()),
      rounds: new GuidedRoundService(baseDb().asClient()),
      identity: {
        ...IDENTITY,
        lineUserId: "U-other",
        sessionKey: `group:${SOURCE}:user:U-other`,
      },
      text: generated.text,
      marker: generated.marker,
    });
    expect(copied.saved).toBe(false);

    const db = baseDb();
    const marker = generated.marker!;
    const tampered = await submit(
      db,
      generated.text,
      state(),
      `${marker.slice(0, -1)}${marker.endsWith("A") ? "B" : "A"}`,
    );
    expect(tampered.saved).toBe(false);
    expect(entries(db)).toHaveLength(0);
  });

  it("saves nothing when the amount is invalid", async () => {
    const db = baseDb();
    const reply = await submit(db, template({ "ยอดโอน 0": "ยอดโอน -5" }));
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain(GUIDED_MENU_COPY.settlementNotRecorded);
    expect(entries(db)).toHaveLength(0);
  });

  it("refuses when the market differs from the guided round", async () => {
    const db = baseDb();
    const reply = await submit(
      db,
      template({ "กี้ วัดทุ่งลานนา ส่งยอด": "กี้ ตลาดอื่น ส่งยอด" }),
    );
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain("ไม่ตรงกับรอบที่เปิดอยู่");
    expect(entries(db)).toHaveLength(0);
  });

  it("refuses when the seller differs from the guided round", async () => {
    const db = baseDb();
    const reply = await submit(
      db,
      template({ "กี้ วัดทุ่งลานนา ส่งยอด": "คนอื่น วัดทุ่งลานนา ส่งยอด" }),
    );
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain("ไม่ตรงกับรอบที่เปิดอยู่");
    expect(entries(db)).toHaveLength(0);
  });

  it("refuses when the business date differs from the guided round", async () => {
    const db = baseDb();
    const reply = await submit(db, template({ "29/07/2569": "28/07/2569" }));
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain("ไม่ตรงกับรอบที่เปิดอยู่");
    expect(entries(db)).toHaveLength(0);
  });

  it("refuses a wrong operator — ownership resolves to no round", async () => {
    const db = baseDb();
    const reply = await submit(db, template(), {
      stage: "idle",
      reason: "ownership_conflict",
    });
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain(GUIDED_MENU_COPY.settlementNoJourney);
    expect(entries(db)).toHaveLength(0);
  });

  it("refuses a wrong group — no round for that source", async () => {
    const db = baseDb();
    const reply = await submit(db, template(), {
      stage: "idle",
      reason: "no_session",
    });
    expect(reply.saved).toBe(false);
    expect(entries(db)).toHaveLength(0);
  });

  it("writes against the round's own source, never a value from the message", async () => {
    const db = baseDb();
    seedVerifiedSlip(db, "c-1", 0);
    const reply = await submit(db, template());
    expect(reply.saved).toBe(true);
    expect(entries(db)[0]!.source_id).toBe(SOURCE);
  });

  it("refuses while the produce session is not finalized", async () => {
    for (const stage of ["capture", "awaiting_confirm"] as const) {
      const db = baseDb();
      const reply = await submit(db, template(), {
        stage,
        context: CONTEXT,
        session: { session_key: CONTEXT.sessionKey } as never,
        whiteSheet: { status: "not_submitted" },
      });
      expect(reply.saved).toBe(false);
      expect(reply.messages[0]).toContain(
        GUIDED_MENU_COPY.settlementProduceUnfinished,
      );
      expect(entries(db)).toHaveLength(0);
    }
  });

  it("refuses while the white sheet has not been submitted", async () => {
    const db = baseDb();
    const reply = await submit(db, template(), state({ status: "not_submitted" }));
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain(
      GUIDED_MENU_COPY.settlementWhiteSheetMissing,
    );
    expect(entries(db)).toHaveLength(0);
  });

  it("accepts a FINALIZED white sheet as well as a SUBMITTED one", async () => {
    const db = baseDb();
    const reply = await submit(db, template(), state(FINALIZED_SHEET));
    expect(reply.saved).toBe(true);
    expect(entries(db)).toHaveLength(1);
  });

  it("refuses when an open manual slip session blocks reconcile", async () => {
    const db = baseDb();
    db.seed("manual_slip_sessions", [
      { id: "ms-1", source_id: SOURCE, business_date: DATE, status: "open" },
    ]);
    const reply = await submit(db, template());
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain("จบสลิปมือ");
    expect(entries(db)).toHaveLength(0);
  });
});

// ── Idempotency and update behaviour ─────────────────────────────────────────

describe("guided settlement persistence", () => {
  it("persists the four amounts under the Dashboard's own key", async () => {
    const db = baseDb();
    const reply = await submit(
      db,
      template({
        "ยอดโอน 0": "ยอดโอน 12,000",
        "เงินสด 0": "เงินสด 3000",
        "ค่าใช้จ่าย 0": "ค่าใช้จ่าย 500",
        "ค่าแรง 0": "ค่าแรง 800",
      }),
    );
    expect(reply.saved).toBe(true);
    expect(entries(db)).toHaveLength(1);
    expect(entries(db)[0]).toMatchObject({
      source_id: SOURCE,
      settlement_date: DATE,
      settlement_time: "",
      staff_name: SELLER,
      market_name: MARKET,
      money_transfer: 12000,
      money_cash: 3000,
      expenses: 500,
      labor: 800,
    });
  });

  it("shows the receipt and the ตรวจยอด reconciliation", async () => {
    const db = baseDb();
    seedVerifiedSlip(db, "c-1", 12000);
    const reply = await submit(db, template({ "ยอดโอน 0": "ยอดโอน 12000" }));
    expect(reply.messages).toHaveLength(2);
    expect(reply.messages[0]).toContain("บันทึกยอดส่งเรียบร้อย ✅");
    expect(reply.messages[0]).toContain("ยอดโอน: 12,000 บาท");
    expect(reply.messages[0]).toContain(GUIDED_MENU_COPY.nextStepReconcile);
    expect(reply.messages[1]).toContain("ตรวจยอดรอบขาย");
  });

  it("a repeated LINE event updates one row and never adds a second", async () => {
    const db = baseDb();
    const text = template({ "ยอดโอน 0": "ยอดโอน 12000" });
    const first = await submit(db, text);
    const second = await submit(db, text);
    expect(first.saved).toBe(true);
    expect(second.saved).toBe(true);
    expect(second.messages[0]).toBe(first.messages[0]);
    expect(entries(db)).toHaveLength(1);
    expect(entries(db)[0]!.money_transfer).toBe(12000);
  });

  it("a corrected resubmission updates the same row (the API's upsert rule)", async () => {
    const db = baseDb();
    await submit(db, template({ "ยอดโอน 0": "ยอดโอน 11000" }));
    await submit(db, template({ "ยอดโอน 0": "ยอดโอน 12000" }));
    expect(entries(db)).toHaveLength(1);
    expect(entries(db)[0]!.money_transfer).toBe(12000);
  });

  it("never adds a second row beside an entry stored under another key", async () => {
    const db = baseDb();
    db.seed("settlement_entries", [
      {
        source_id: SOURCE,
        settlement_date: DATE,
        settlement_time: "18:00",
        staff_name: SELLER,
        market_name: MARKET,
        money_transfer: 9000,
      },
    ]);
    const reply = await submit(db, template({ "ยอดโอน 0": "ยอดโอน 12000" }));
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain(GUIDED_MENU_COPY.settlementAmbiguous);
    expect(entries(db)).toHaveLength(1);
    expect(entries(db)[0]!.money_transfer).toBe(9000);
  });

  it("refuses to silently overwrite a settlement whose round already closed", async () => {
    const db = baseDb();
    db.seed("settlement_entries", [
      {
        source_id: SOURCE,
        settlement_date: DATE,
        settlement_time: "",
        staff_name: SELLER,
        market_name: MARKET,
        money_transfer: 12000,
      },
    ]);
    db.seed("settlement_finalizations", [
      {
        id: "fin-1",
        source_id: SOURCE,
        business_date: DATE,
        status: "sent",
        message_sent_at: IN_WINDOW,
        line_retry_key: "k-1",
      },
    ]);
    const reply = await submit(db, template({ "ยอดโอน 0": "ยอดโอน 1" }));
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain(GUIDED_MENU_COPY.settlementAlreadyClosed);
    expect(entries(db)[0]!.money_transfer).toBe(12000);
  });

  it("reports the write as failed without claiming a save", async () => {
    const db = baseDb();
    const reply = await processGuidedSettlementSubmission({
      supabase: db.asClient(),
      journey: fakeJourney(state()),
      rounds: new GuidedRoundService(db.asClient()),
      identity: IDENTITY,
      text: template(),
      submit: async () => ({ status: "failed", reason: "boom" }),
    });
    expect(reply.saved).toBe(false);
    expect(reply.messages[0]).toContain(GUIDED_MENU_COPY.settlementWriteFailed);
  });
});

// ── Reconciliation and the close that follows ───────────────────────────────

describe("guided settlement then reconciliation", () => {
  it("reaches an exact match with no blockers left", async () => {
    const db = baseDb();
    seedVerifiedSlip(db, "c-1", 8000);
    seedVerifiedSlip(db, "c-2", 4000);
    await submit(db, template({ "ยอดโอน 0": "ยอดโอน 12000" }));

    const report = await new GuidedRoundService(db.asClient()).report(
      CONTEXT,
      true,
    );
    expect(report.totals.checkedSlipTotal).toBe(12000);
    expect(report.totals.submittedTransferTotal).toBe(12000);
    expect(report.totals.difference).toBe(0);
    expect(report.blockers).toEqual([]);
  });

  it("keeps difference_non_zero when the submitted total disagrees", async () => {
    const db = baseDb();
    seedVerifiedSlip(db, "c-1", 12000);
    const reply = await submit(db, template({ "ยอดโอน 0": "ยอดโอน 11500" }));
    expect(reply.saved).toBe(true);

    const report = await new GuidedRoundService(db.asClient()).report(
      CONTEXT,
      true,
    );
    expect(report.totals.difference).toBe(-500);
    expect(report.blockers).toContain("difference_non_zero");
    expect(reply.messages[1]).toContain("ยอดสลิปกับยอดส่งเงินยังไม่ตรงกัน");
  });

  it("does not close the round on submission — ปิดรอบ still does that", async () => {
    const db = baseDb();
    seedVerifiedSlip(db, "c-1", 12000);
    await submit(db, template({ "ยอดโอน 0": "ยอดโอน 12000" }));
    expect(db.tables.settlement_finalizations).toHaveLength(0);
  });

  it("lets ปิดรอบ finalize a round settled from LINE, then stays idempotent", async () => {
    const db = baseDb();
    seedVerifiedSlip(db, "c-1", 12000);
    await submit(db, template({ "ยอดโอน 0": "ยอดโอน 12000" }));

    const rounds = new GuidedRoundService(db.asClient());
    const first = await processGuidedRoundClose({
      journey: fakeJourney(state()),
      rounds,
      identity: IDENTITY,
    });
    expect(first.closed).toBe(true);
    expect(first.messages[0]).toContain("ปิดรอบเรียบร้อย ✅");

    const second = await processGuidedRoundClose({
      journey: fakeJourney(state()),
      rounds,
      identity: IDENTITY,
    });
    expect(second.closed).toBe(true);
    expect(db.tables.settlement_finalizations).toHaveLength(1);
  });

  it("refuses ปิดรอบ while no settlement has been submitted", async () => {
    const db = baseDb();
    seedVerifiedSlip(db, "c-1", 12000);
    const outcome = await processGuidedRoundClose({
      journey: fakeJourney(state()),
      rounds: new GuidedRoundService(db.asClient()),
      identity: IDENTITY,
    });
    expect(outcome.closed).toBe(false);
    expect(outcome.messages[0]).toContain("ยังไม่มียอดส่งเงินของรอบนี้ในระบบ");
  });
});

// ── LINE limits ─────────────────────────────────────────────────────────────

describe("guided settlement message limits", () => {
  it("stays inside the reply budget", async () => {
    const db = baseDb();
    seedVerifiedSlip(db, "c-1", 12000);
    const reply = await submit(db, template({ "ยอดโอน 0": "ยอดโอน 12000" }));
    expect(reply.messages.length).toBeLessThanOrEqual(LINE_REPLY_MESSAGE_MAX);
    assertGuidedMenuMessageLimits(
      reply.messages.map((text) => ({ type: "text" as const, text })),
    );
  });

  it("keeps the receipt within one LINE text message", () => {
    const message = buildSettlementSavedMessage({
      moneyTransfer: 1234567.89,
      moneyCash: 1234567.89,
      expenses: 1234567.89,
      labor: 1234567.89,
    });
    assertGuidedMenuMessageLimits([message]);
    expect([...message.text].length).toBeLessThan(5000);
  });
});
