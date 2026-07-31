/**
 * PR #15 review — stale-form recovery must be stage-aware, not a blind
 * "เมนู" resubmission that may land on an unrelated screen, AND the fresh
 * template it hands back must never be auto-submittable.
 *
 * `resolveGuidedOwnership` decides, PER PURPOSE, whether the caller's CURRENT
 * stage can still use that form (`regenerate` present) or not (absent — "no
 * longer applicable"). `buildStaleFormRecoveryMessages` (journey-bridge.ts)
 * turns that into the actual reply.
 *
 * BLOCKER FIX: a LINE `message` Quick Reply action SUBMITS its `text` on
 * press — it is not an editable draft. Embedding the whole regenerated
 * template (money fields defaulted to 0, plus a valid marker) inside a
 * "สร้างแบบฟอร์มใหม่" button meant pressing it silently submitted a
 * zero-filled White Sheet close or settlement. The fresh template is now sent
 * as an ordinary Bot message the operator must copy, edit and resend by
 * hand — no button in the reply ever carries it. The press-level tests below
 * prove this by resubmitting every button's literal text through the SAME
 * parsers and guards the real message router uses, not just by inspecting
 * that template generation is pure.
 */

process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

import { describe, expect, it } from "bun:test";
import type { GuidedJourneyContext, GuidedJourneyState } from "./journey";
import { resolveGuidedOwnership } from "./ownership-guard";
import {
  buildStaleFormRecoveryMessages,
  guardGuidedWhiteSheetSubmission,
} from "./journey-bridge";
import { guardGuidedSlipOpen } from "./slip-open-guard";
import {
  parseGuidedSettlementCommand,
  processGuidedSettlementSubmission,
} from "./settlement-command";
import { GuidedRoundService } from "./round-close";
import { RoundFakeDatabase } from "./test-fake-round-db";
import { extractGuidedMarker, signGuidedMarker, verifyGuidedMarker } from "./provenance";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity, LineTextMessage } from "./ux-types";
import { parseWhiteSheetCloseCommandFromMessage } from "@/lib/line/white-sheet-close-command";
import { parseSlipSessionHeader } from "@/lib/slips/slip-session-service";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";
const SELLER = "กี้";

const OWNER: GuidedMenuIdentity = {
  lineUserId: "U-owner",
  sourceType: "group",
  sourceId: SOURCE,
  sessionKey: `group:${SOURCE}:user:U-owner`,
};

const CONTEXT: GuidedJourneyContext = {
  sessionKey: OWNER.sessionKey!,
  sourceId: SOURCE,
  lineUserId: OWNER.lineUserId,
  sellerLabel: SELLER,
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  transactionType: "เบิก",
  sessionGeneration: "gen-2", // the round rotated since the stale form was minted
};

function stageState(stage: Exclude<GuidedJourneyState["stage"], "idle">): GuidedJourneyState {
  return {
    stage,
    context: CONTEXT,
    session: { session_key: CONTEXT.sessionKey } as never,
    whiteSheet: { status: "submitted", expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 }, actualCashSubmitted: 0, updatedAt: `${DATE}T05:00:00Z` },
  };
}

function fakeJourney(state: GuidedJourneyState) {
  return {
    resolve: async () => state,
    findRoundOwner: async () => ({
      kind: "owned" as const,
      lineUserId: OWNER.lineUserId,
      sessionKey: OWNER.sessionKey!,
    }),
  } as never;
}

/** A marker minted for an EARLIER round generation — the classic stale form. */
const STALE_MARKER = signGuidedMarker({
  purpose: "white_sheet",
  sourceId: SOURCE,
  lineUserId: OWNER.lineUserId,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  sessionGeneration: "gen-1",
})!;

function asTextMessages(
  messages: ReturnType<typeof buildStaleFormRecoveryMessages>,
): LineTextMessage[] {
  return messages.map((m) => {
    if (m.type !== "text") throw new Error(`expected a text message, got ${m.type}`);
    return m;
  });
}

describe("stale-form recovery — regeneration is offered only while the purpose still applies", () => {
  it("offers a real, freshly-marked form as a Bot message while still at white_sheet", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("white_sheet")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "white_sheet",
      marker: STALE_MARKER,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.reason).toBe("stale_form");
    expect(verdict.regenerate).toBeDefined();
    expect(verdict.debugReason).toBe("stale_generation");
    expect(verdict.message).toBe(
      [GUIDED_MENU_COPY.ownershipMarkerRejected, "", GUIDED_MENU_COPY.ownershipNothingRecorded].join("\n"),
    );

    const [notice, form] = asTextMessages(
      buildStaleFormRecoveryMessages(verdict.message, verdict.regenerate),
    );
    // Message 1: a short notice — never the template, no Quick Reply.
    expect(notice.text).toBe(GUIDED_MENU_COPY.regenerateFormNotice);
    expect(notice.quickReply).toBeUndefined();

    // Message 2: the fresh template as plain Bot text — a real, currently
    // valid template, same syntax parseWhiteSheetCloseCommand accepts.
    const { text: strippedTemplate, marker: freshMarker } = extractGuidedMarker(form.text);
    expect(strippedTemplate).toContain(`${MARKET} ปิดยอด`);
    expect(strippedTemplate).toContain("จบปิดยอด");
    // A genuinely fresh marker — different from the stale one, and it
    // verifies for the CURRENT generation.
    expect(freshMarker).not.toBeNull();
    expect(freshMarker).not.toBe(STALE_MARKER);
    expect(
      verifyGuidedMarker(freshMarker, {
        purpose: "white_sheet",
        sourceId: SOURCE,
        lineUserId: OWNER.lineUserId,
        marketLabelNormalized: MARKET,
        businessDate: DATE,
        sessionGeneration: CONTEXT.sessionGeneration,
      }),
    ).toBe(true);

    // No button anywhere in the reply carries the template.
    expect(form.quickReply).toBeDefined();
    for (const item of form.quickReply!.items) {
      expect(item.action.type).toBe("message");
      if (item.action.type !== "message") continue;
      expect(item.action.text).not.toContain(`${MARKET} ปิดยอด`);
      expect([...item.action.text].length).toBeLessThan(30);
    }
    // Minting the recovery messages writes nothing — it is a pure function
    // of the already-resolved context.
  });

  it("still offers slip-header regeneration while reconcile has no open batch — slips are optional", async () => {
    const marker = signGuidedMarker({
      purpose: "slip_open",
      sourceId: SOURCE,
      lineUserId: OWNER.lineUserId,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
      sessionGeneration: "gen-1",
    });
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("reconcile")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "slip_open",
      marker,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.regenerate).toBeDefined();

    const [, form] = asTextMessages(
      buildStaleFormRecoveryMessages(verdict.message, verdict.regenerate),
    );
    expect(form.text).toContain("สลิปเงินโอน");
  });

  it("does not offer settlement regeneration while still at slips — the form is not applicable yet", async () => {
    const marker = signGuidedMarker({
      purpose: "settlement",
      sourceId: SOURCE,
      lineUserId: OWNER.lineUserId,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
      sessionGeneration: "gen-1",
    });
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "settlement",
      marker,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.regenerate).toBeUndefined();
    expect(verdict.message).toBe(GUIDED_MENU_COPY.staleFormNoLongerApplicable);

    const messages = asTextMessages(
      buildStaleFormRecoveryMessages(verdict.message, verdict.regenerate),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe(GUIDED_MENU_COPY.staleFormNoLongerApplicable);
  });

  it("does not offer white-sheet regeneration once the round moved on to slips", async () => {
    const marker = signGuidedMarker({
      purpose: "white_sheet",
      sourceId: SOURCE,
      lineUserId: OWNER.lineUserId,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
      sessionGeneration: "gen-1",
    });
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "white_sheet",
      marker,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.regenerate).toBeUndefined();
  });

  it("falls back to the plain status-check recovery when no regeneration is offered", () => {
    const [message] = asTextMessages(buildStaleFormRecoveryMessages("some fallback text", undefined));
    expect(message.text).toBe("some fallback text");
    expect(message.quickReply!.items.map((i) => i.action.label)).toEqual(["ดูสถานะ", "ออกจากเมนู"]);
    for (const item of message.quickReply!.items) {
      expect(item.action.type).toBe("message");
    }
  });
});

describe("stale-form recovery — marker diagnostics are distinguishable (logs only)", () => {
  it("reports round_not_owned when no round exists for the marked target at all", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: {
        resolve: async () => ({ stage: "idle", reason: "no_session" }),
        findRoundOwner: async () => ({ kind: "none" as const }),
      } as never,
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "white_sheet",
      marker: STALE_MARKER,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.debugReason).toBe("round_not_owned");
    expect(verdict.regenerate).toBeUndefined();
  });

  it("reports marker_invalid for a malformed marker, not stale_generation", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("white_sheet")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "white_sheet",
      marker: "not-a-real-marker",
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.debugReason).toBe("marker_invalid");
  });

  it("reports marker_purpose_mismatch for a marker minted for a different purpose", async () => {
    const marker = signGuidedMarker({
      purpose: "slip_open",
      sourceId: SOURCE,
      lineUserId: OWNER.lineUserId,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
      sessionGeneration: CONTEXT.sessionGeneration, // same generation, wrong purpose
    });
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("white_sheet")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "white_sheet",
      marker,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.debugReason).toBe("marker_purpose_mismatch");
  });

  it("reports stale_generation for a well-shaped marker from an earlier round", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("white_sheet")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "white_sheet",
      marker: STALE_MARKER, // signed for gen-1; CONTEXT is gen-2
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.debugReason).toBe("stale_generation");
  });
});

describe("blocker fix — press-level: recovery buttons never write data, manual resend does", () => {
  const CATALOG_OK = { isActiveSellerMarket: async () => true };

  /** True if ANY of the three money-writing command parsers recognize `text`. */
  function moneyParsersRecognize(text: string): boolean {
    return (
      parseWhiteSheetCloseCommandFromMessage(text).kind !== "not_command" ||
      parseGuidedSettlementCommand(text).kind !== "not_command" ||
      parseSlipSessionHeader(text) !== null
    );
  }

  it("White Sheet: pressing every recovery button is a dead end; a manually edited resend is guard-approved exactly as before", async () => {
    const marker = signGuidedMarker({
      purpose: "white_sheet",
      sourceId: SOURCE,
      lineUserId: OWNER.lineUserId,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
      sessionGeneration: "gen-1",
    })!;
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("white_sheet")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "white_sheet",
      marker,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;

    const [, form] = asTextMessages(
      buildStaleFormRecoveryMessages(verdict.message, verdict.regenerate),
    );

    // Simulate pressing every button: its resubmitted TEXT is the only thing
    // that ever reaches the real message router — none of it is recognized
    // as a money-writing command, so no guard/write is ever reached.
    for (const item of form.quickReply!.items) {
      if (item.action.type !== "message") continue;
      expect(moneyParsersRecognize(item.action.text)).toBe(false);
    }

    // Manually copy the Bot message, edit a number, and resend it by hand —
    // the one legitimate path. The guard admits it exactly as any hand-typed
    // submission, because it IS one.
    const { text: stripped, marker: freshMarker } = extractGuidedMarker(form.text);
    const edited = stripped.replace("ค่าแรง 0", "ค่าแรง 500");
    const parsed = parseWhiteSheetCloseCommandFromMessage(edited);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.command.labor).toBe(500);

    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(stageState("white_sheet")),
      identity: OWNER,
      command: parsed.command,
      marker: freshMarker,
    });
    expect(guard.verdict).toBe("allowed");
  });

  it("slip header: pressing every recovery button is a dead end; a manual resend is guard-approved", async () => {
    const marker = signGuidedMarker({
      purpose: "slip_open",
      sourceId: SOURCE,
      lineUserId: OWNER.lineUserId,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
      sessionGeneration: "gen-1",
    });
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("reconcile")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "slip_open",
      marker,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;

    const [, form] = asTextMessages(
      buildStaleFormRecoveryMessages(verdict.message, verdict.regenerate),
    );
    for (const item of form.quickReply!.items) {
      if (item.action.type !== "message") continue;
      expect(moneyParsersRecognize(item.action.text)).toBe(false);
    }

    const { text: stripped, marker: freshMarker } = extractGuidedMarker(form.text);
    const header = parseSlipSessionHeader(stripped);
    expect(header).not.toBeNull();

    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("reconcile")),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header!,
      marker: freshMarker,
    });
    expect(guard.verdict).toBe("allowed");
  });

  it("settlement: pressing every recovery button saves nothing; a manually edited resend saves exactly one row, and a repeat stays one row", async () => {
    const marker = signGuidedMarker({
      purpose: "settlement",
      sourceId: SOURCE,
      lineUserId: OWNER.lineUserId,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
      sessionGeneration: "gen-1",
    });
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("reconcile")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: DATE },
      purpose: "settlement",
      marker,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;

    const [, form] = asTextMessages(
      buildStaleFormRecoveryMessages(verdict.message, verdict.regenerate),
    );

    const db = new RoundFakeDatabase().seedKnownMarket({
      sourceId: SOURCE,
      businessDate: DATE,
      marketName: MARKET,
    });
    const rounds = new GuidedRoundService(db.asClient());

    // Pressing every button resubmits ONLY its fixed text — never recognized
    // as a settlement command, so the submission handler saves nothing.
    for (const item of form.quickReply!.items) {
      if (item.action.type !== "message") continue;
      const reply = await processGuidedSettlementSubmission({
        supabase: db.asClient(),
        journey: fakeJourney(stageState("reconcile")),
        rounds,
        identity: OWNER,
        text: item.action.text,
        marker: null,
      });
      expect(reply.saved).toBe(false);
    }
    expect(db.tables.settlement_entries).toHaveLength(0);

    // Manually editing the numbers and resending the template by hand IS a
    // real, guarded write — exactly once — and a second identical resend
    // upserts the SAME row instead of creating a second one.
    const { text: stripped, marker: freshMarker } = extractGuidedMarker(form.text);
    const edited = stripped
      .replace("ยอดโอน 0", "ยอดโอน 1200")
      .replace("เงินสด 0", "เงินสด 300");

    const first = await processGuidedSettlementSubmission({
      supabase: db.asClient(),
      journey: fakeJourney(stageState("reconcile")),
      rounds,
      identity: OWNER,
      text: edited,
      marker: freshMarker,
    });
    expect(first.saved).toBe(true);
    expect(db.tables.settlement_entries).toHaveLength(1);
    expect(db.tables.settlement_entries[0]!.money_transfer).toBe(1200);

    const second = await processGuidedSettlementSubmission({
      supabase: db.asClient(),
      journey: fakeJourney(stageState("reconcile")),
      rounds,
      identity: OWNER,
      text: edited,
      marker: freshMarker,
    });
    expect(second.saved).toBe(true);
    expect(db.tables.settlement_entries).toHaveLength(1);
  });
});
