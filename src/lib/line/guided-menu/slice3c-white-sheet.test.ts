/**
 * Slice 3C — the guided White Sheet.
 *
 * The template is the EXISTING closing-command syntax; the submitted message
 * goes back through parseWhiteSheetCloseCommand + processWhiteSheetCloseCommand
 * untouched. These tests prove the template round-trips through that parser,
 * that a guided operator cannot file a sheet against another market or date,
 * and that the pre-existing direct command is unaffected.
 *
 * Generated templates carry a signed provenance marker on their last line
 * (provenance.ts), which the webhook strips before any parser runs. `body()` does
 * the same here, so the round-trip tests exercise exactly the text the existing
 * parsers receive.
 */

process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

import { describe, expect, it } from "bun:test";
import { GuidedMenuUxHandler } from "./ux-handler";
import { extractGuidedMarker, signGuidedMarker } from "./provenance";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GUIDED_MENU_COPY, LINE_REPLY_MESSAGE_MAX } from "./ux-types";
import {
  buildSlipHeaderTemplate,
  buildWhiteSheetTemplate,
  thaiDateFromIso,
  type GuidedJourneyContext,
  type GuidedJourneyState,
} from "./journey";
import {
  buildSlipHandoffMessages,
  guardGuidedWhiteSheetSubmission,
} from "./journey-bridge";
import { assertGuidedMenuMessageLimits } from "./messages";
import { parseWhiteSheetCloseCommandFromMessage } from "@/lib/line/white-sheet-close-command";
import { parseSlipSessionHeader } from "@/lib/slips/slip-session-service";

const IDENTITY = {
  lineUserId: "U-op-1",
  sourceType: "group" as const,
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};
const TS = Date.parse("2026-07-29T10:00:00+07:00");

const CONTEXT: GuidedJourneyContext = {
  sessionKey: "group:G-1:user:U-op-1",
  sourceId: "G-1",
  lineUserId: "U-op-1",
  sellerLabel: "กี้",
  marketLabel: "วัดทุ่งลานนา",
  marketLabelNormalized: "วัดทุ่งลานนา",
  businessDate: "2026-07-29",
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

type FakeOwner =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "ambiguous"; lineUserIds: string[] }
  | { kind: "owned"; lineUserId: string; sessionKey: string };

type OwnerQuery = { marketLabelNormalized: string; businessDate: string };

/**
 * A GuidedJourneyService stand-in. By default the source-wide owner of the
 * caller's OWN market/date is the caller, and no other tuple is owned — the shape
 * the real query has.
 */
function fakeJourney(
  state: GuidedJourneyState,
  owner: FakeOwner | ((q: OwnerQuery) => FakeOwner) = defaultOwner(state),
) {
  return {
    resolve: async () => state,
    findRoundOwner: async (q: OwnerQuery) =>
      typeof owner === "function" ? owner(q) : owner,
  } as never;
}

function defaultOwner(state: GuidedJourneyState): (q: OwnerQuery) => FakeOwner {
  if (state.stage === "idle") return () => ({ kind: "none" });
  const context = state.context;
  return (q) =>
    q.marketLabelNormalized === context.marketLabelNormalized &&
    q.businessDate === context.businessDate
      ? { kind: "owned", lineUserId: context.lineUserId, sessionKey: context.sessionKey }
      : { kind: "none" };
}

/** Ownership answer for ANY tuple — used when the target was edited. */
const OWNED_BY_CALLER: FakeOwner = {
  kind: "owned",
  lineUserId: CONTEXT.lineUserId,
  sessionKey: CONTEXT.sessionKey,
};

/** A generated template as the existing parsers see it: marker line removed. */
function body(text: string): string {
  return extractGuidedMarker(text).text;
}

/** The marker the bot puts on the operator's own White Sheet template. */
function whiteSheetMarker(): string {
  const marker = signGuidedMarker({
    purpose: "white_sheet",
    sourceId: CONTEXT.sourceId,
    lineUserId: CONTEXT.lineUserId,
    marketLabelNormalized: CONTEXT.marketLabelNormalized,
    businessDate: CONTEXT.businessDate,
    sessionGeneration: CONTEXT.sessionGeneration,
  });
  if (!marker) throw new Error("test setup: marker could not be signed");
  return marker;
}

function stageState(
  stage: Exclude<GuidedJourneyState["stage"], "idle">,
  whiteSheetStatus: "not_submitted" | "submitted" | "finalized" = "not_submitted",
): GuidedJourneyState {
  const whiteSheet =
    whiteSheetStatus === "not_submitted"
      ? ({ status: "not_submitted" } as const)
      : whiteSheetStatus === "submitted"
        ? ({
            status: "submitted",
            expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
            actualCashSubmitted: 0,
            updatedAt: "2026-07-29T05:00:00Z",
          } as const)
        : ({
            status: "finalized",
            expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
            actualCashSubmitted: 0,
            updatedAt: "2026-07-29T05:00:00Z",
            finalizedAt: "2026-07-29T06:00:00Z",
            finalizedBy: "admin",
          } as const);
  return {
    stage,
    context: CONTEXT,
    // The session row is only read for produce stages; a minimal stand-in is
    // enough for the white-sheet and slip stages under test here.
    session: { session_key: CONTEXT.sessionKey } as never,
    whiteSheet,
  };
}

async function mintViewStatusToken(db: GuidedMenuFakeDatabase): Promise<string> {
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
  return created.wireToken;
}

function seededHandler(
  db: GuidedMenuFakeDatabase,
  journey: GuidedJourneyState,
): GuidedMenuUxHandler {
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
  return new GuidedMenuUxHandler(db.asClient(), {
    journeyService: fakeJourney(journey),
  });
}

describe("Slice 3C — the template is the existing command", () => {
  it("round-trips through parseWhiteSheetCloseCommand with every field", () => {
    const generated = buildWhiteSheetTemplate(CONTEXT)!;
    // The provenance marker is the last line and is stripped before parsing.
    expect(extractGuidedMarker(generated).marker).not.toBeNull();
    const template = body(generated);
    expect(template).toContain("วัดทุ่งลานนา ปิดยอด 29/07/2569");
    expect(template.endsWith("จบปิดยอด")).toBe(true);

    const parsed = parseWhiteSheetCloseCommandFromMessage(template);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") throw new Error("expected ok");
    expect(parsed.command.marketLabelNormalized).toBe("วัดทุ่งลานนา");
    expect(parsed.command.businessDate).toBe("2026-07-29");
    // Every operator field is present and explicitly zero, not omitted.
    expect(parsed.command.labor).toBe(0);
    expect(parsed.command.locationFee).toBe(0);
    expect(parsed.command.bag).toBe(0);
    expect(parsed.command.snack).toBe(0);
    expect(parsed.command.other).toEqual({ amount: 0, note: null });
    expect(parsed.command.actualCashSubmitted).toBe(0);
  });

  it("accepts the template after the operator edits the numbers", () => {
    const edited = body(buildWhiteSheetTemplate(CONTEXT)!)
      .replace("ค่าแรง 0", "ค่าแรง 350")
      .replace("ค่าที่ 0", "ค่าที่ 120")
      .replace("เงินสด 0", "เงินสด 4,850.50");

    const parsed = parseWhiteSheetCloseCommandFromMessage(edited);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") throw new Error("expected ok");
    expect(parsed.command.labor).toBe(350);
    expect(parsed.command.locationFee).toBe(120);
    expect(parsed.command.actualCashSubmitted).toBe(4850.5);
  });

  it("rejects an edited template with a missing required field", () => {
    const missingCash = body(buildWhiteSheetTemplate(CONTEXT)!)
      .split("\n")
      .filter((line) => !line.startsWith("เงินสด"))
      .join("\n");

    const parsed = parseWhiteSheetCloseCommandFromMessage(missingCash);
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind !== "invalid") throw new Error("expected invalid");
    expect(parsed.message).toContain("เงินสด");
  });

  it("rejects an invalid number rather than silently fixing it", () => {
    for (const bad of ["เงินสด -100", "เงินสด 12.345", "เงินสด abc", "เงินสด 1,23"]) {
      const edited = buildWhiteSheetTemplate(CONTEXT)!.replace("เงินสด 0", bad);
      const parsed = parseWhiteSheetCloseCommandFromMessage(edited);
      expect(parsed.kind).toBe("invalid");
    }
  });

  it("refuses to build a template for an invalid business date", () => {
    expect(buildWhiteSheetTemplate({ ...CONTEXT, businessDate: "not-a-date" })).toBeNull();
    expect(thaiDateFromIso("2026-13-40")).toBe("40/13/2569");
  });
});

describe("Slice 3C — the guided white-sheet screen", () => {
  it("renders the template with the round's own seller, market and date", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db, stageState("white_sheet"));
    const token = await mintViewStatusToken(db);

    const outcome = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-ws",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("white_sheet_template");
    const [instructions, template] = outcome.messages as Array<{ text: string }>;
    expect(instructions.text).toContain(GUIDED_MENU_COPY.whiteSheetInstructions);
    expect(instructions.text).toContain("คนขาย: กี้");
    expect(instructions.text).toContain("ตลาด: วัดทุ่งลานนา");
    expect(instructions.text).toContain("วันที่: 29/07/2569");
    // The template arrives as its own message so it can be copied cleanly.
    expect(parseWhiteSheetCloseCommandFromMessage(body(template.text)).kind).toBe(
      "ok",
    );
    expect(outcome.result).toMatchObject({
      stage: "white_sheet",
      market_label_normalized: "วัดทุ่งลานนา",
      business_date: "2026-07-29",
    });
  });

  it("stays within LINE reply budgets", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db, stageState("white_sheet"));
    const outcome = await handler.handlePostback({
      wireToken: await mintViewStatusToken(db),
      lineEventId: "evt-limits",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    expect(outcome.messages.length).toBeLessThanOrEqual(LINE_REPLY_MESSAGE_MAX);
    expect(() => assertGuidedMenuMessageLimits(outcome.messages)).not.toThrow();
  });

  it("a redelivered press replays the recorded reply without re-rendering", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db, stageState("white_sheet"));
    const token = await mintViewStatusToken(db);

    const first = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-dup",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const retry = await handler.handlePostback({
      wireToken: token,
      lineEventId: "evt-dup",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(retry.messages).toEqual(first.messages);
  });

  it("moves on to the slip stage once the sheet is submitted", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db, stageState("slips", "submitted"));

    const outcome = await handler.handlePostback({
      wireToken: await mintViewStatusToken(db),
      lineEventId: "evt-slips",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("slip_instructions");
    const [, header] = outcome.messages as Array<{ text: string }>;
    expect(parseSlipSessionHeader(body(header.text))).toMatchObject({
      sellerName: "กี้",
      marketName: "วัดทุ่งลานนา",
      batchType: "TRANSFER_SLIPS",
    });
  });

  it("refuses when no guided round exists", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db, { stage: "idle", reason: "no_session" });

    const outcome = await handler.handlePostback({
      wireToken: await mintViewStatusToken(db),
      lineEventId: "evt-idle",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("no_open_session");
    expect(outcome.result).toMatchObject({ reason: "no_session" });
  });

  it("discloses nothing when the round belongs to another operator", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seededHandler(db, {
      stage: "idle",
      reason: "ownership_conflict",
    });

    const outcome = await handler.handlePostback({
      wireToken: await mintViewStatusToken(db),
      lineEventId: "evt-other",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(outcome.screen).toBe("invalid");
    expect(outcome.messages[0]).toEqual({
      type: "text",
      text: GUIDED_MENU_COPY.invalidOrExpired,
    });
  });
});

describe("Slice 3C — the journey guard on submission", () => {
  const command = {
    marketLabel: "วัดทุ่งลานนา",
    marketLabelNormalized: "วัดทุ่งลานนา",
    businessDate: "2026-07-29",
    labor: 0,
    locationFee: 0,
    bag: 0,
    snack: 0,
    other: { amount: 0, note: null },
    actualCashSubmitted: 100,
  };

  it("allows a submission that matches the active round", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(stageState("white_sheet")),
      identity: IDENTITY,
      command,
    });
    expect(guard.verdict).toBe("allowed");
  });

  it("allows the generated template's own signed marker", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(stageState("white_sheet")),
      identity: IDENTITY,
      command,
      marker: whiteSheetMarker(),
    });
    expect(guard.verdict).toBe("allowed");
  });

  it("refuses another market without writing anything", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      // Source-wide ownership answers "the caller" for the edited tuple too, so
      // the refusal is about the round, not about who asked.
      journey: fakeJourney(stageState("white_sheet"), OWNED_BY_CALLER),
      identity: IDENTITY,
      command: {
        ...command,
        marketLabel: "หน้าเซเวน",
        marketLabelNormalized: "หน้าเซเวน",
      },
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") throw new Error("expected refused");
    expect(guard.message).toContain("ไม่ตรงกับรอบที่เปิดอยู่");
    expect(guard.message).toContain("วัดทุ่งลานนา");
    expect(guard.message).toContain("29/07/2569");
  });

  it("refuses another business date without writing anything", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(stageState("white_sheet"), OWNED_BY_CALLER),
      identity: IDENTITY,
      command: { ...command, businessDate: "2026-07-28" },
    });
    expect(guard.verdict).toBe("refused");
  });

  it("leaves the pre-existing direct command untouched when nobody owns the round", async () => {
    for (const reason of ["no_session", "not_structured"] as const) {
      const guard = await guardGuidedWhiteSheetSubmission({
        journey: fakeJourney({ stage: "idle", reason }),
        identity: IDENTITY,
        command,
      });
      expect(guard.verdict).toBe("not_guided");
    }
  });

  it("fails closed on an ownership conflict instead of falling back", async () => {
    for (const reason of ["ownership_conflict", "session_key_mismatch"] as const) {
      const guard = await guardGuidedWhiteSheetSubmission({
        // The round exists and is someone else's; the caller's own key conflicts.
        journey: fakeJourney({ stage: "idle", reason }, OWNED_BY_CALLER),
        identity: { ...IDENTITY, lineUserId: "U-stranger" },
        command,
      });
      expect(guard.verdict).toBe("refused");
      if (guard.verdict !== "refused") throw new Error("expected refused");
      expect(guard.message).toContain(GUIDED_MENU_COPY.ownershipNothingRecorded);
    }
  });

  it("fails closed when the journey lookup itself fails", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: {
        resolve: async () => {
          throw new Error("db down");
        },
      } as never,
      identity: IDENTITY,
      command,
    });
    // Degrading to not_guided here is exactly what let a stranger through.
    expect(guard.verdict).toBe("refused");
  });
});

describe("Slice 3C → 3D handoff", () => {
  it("hands over the existing slip batch header", () => {
    const messages = buildSlipHandoffMessages(CONTEXT)!;
    expect(messages[0]).toContain(GUIDED_MENU_COPY.nextStepSlips);
    expect(parseSlipSessionHeader(body(messages[1]!))).toMatchObject({
      sellerName: "กี้",
      marketName: "วัดทุ่งลานนา",
    });
  });

  it("produces no handoff at all when the date cannot be formatted", () => {
    expect(
      buildSlipHandoffMessages({ ...CONTEXT, businessDate: "bad" }),
    ).toBeNull();
    expect(buildSlipHeaderTemplate({ ...CONTEXT, businessDate: "bad" })).toBeNull();
  });
});
