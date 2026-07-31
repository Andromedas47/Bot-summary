/**
 * PR #15 review — stale-form recovery must be stage-aware, not a blind
 * "เมนู" resubmission that may land on an unrelated screen.
 *
 * `resolveGuidedOwnership` now decides, PER PURPOSE, whether the caller's
 * CURRENT stage can still use that form (`regenerate` present) or not
 * (absent — "no longer applicable"). `buildStaleFormRecoveryQuickReply`
 * (journey-bridge.ts) turns that into the actual button: when regeneration
 * is valid, the button's resubmitted TEXT *is* a freshly built, correctly
 * marked template — pressing it is byte-identical to the operator re-pasting
 * a brand new copy, so it goes through the exact same parser and guard as
 * any hand-typed submission. Nothing is generated or written by minting the
 * button itself.
 */

process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

import { describe, expect, it } from "bun:test";
import type { GuidedJourneyContext, GuidedJourneyState } from "./journey";
import { resolveGuidedOwnership } from "./ownership-guard";
import { buildStaleFormRecoveryQuickReply } from "./journey-bridge";
import { extractGuidedMarker, signGuidedMarker, verifyGuidedMarker } from "./provenance";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity } from "./ux-types";
import type { LineMessageAction } from "./ux-types";

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

function messageActionOf(qr: ReturnType<typeof buildStaleFormRecoveryQuickReply>, label: string): LineMessageAction {
  const item = qr.items.find((i) => i.action.label === label);
  if (!item || item.action.type !== "message") {
    throw new Error(`expected a message action labelled ${label}`);
  }
  return item.action;
}

describe("stale-form recovery — regeneration is offered only while the purpose still applies", () => {
  it("offers a real, freshly-marked regenerate button while still at white_sheet", async () => {
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

    const qr = buildStaleFormRecoveryQuickReply(verdict.regenerate);
    const button = messageActionOf(qr, GUIDED_MENU_COPY.generateNewFormLabel);
    const { text: strippedTemplate, marker: freshMarker } = extractGuidedMarker(button.text);

    // A real, currently-valid template — same syntax parseWhiteSheetCloseCommand accepts.
    expect(strippedTemplate).toContain(`${MARKET} ปิดยอด`);
    expect(strippedTemplate).toContain("จบปิดยอด");
    // A genuinely fresh marker — different from the stale one, and it verifies
    // for the CURRENT generation.
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
    // Minting the recovery button writes nothing — it is a pure function of
    // the already-resolved context.
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

    const qr = buildStaleFormRecoveryQuickReply(verdict.regenerate);
    const button = messageActionOf(qr, GUIDED_MENU_COPY.generateNewFormLabel);
    expect(button.text).toContain("สลิปเงินโอน");
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
    const qr = buildStaleFormRecoveryQuickReply(undefined);
    expect(qr.items.map((i) => i.action.label)).toEqual(["ดูสถานะ", "ออกจากเมนู"]);
    for (const item of qr.items) {
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
