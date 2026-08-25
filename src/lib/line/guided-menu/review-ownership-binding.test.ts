/**
 * PR #10 review findings #2, #3 and #5 — one guided owner per round, and a
 * message's provenance decides how strictly it is judged.
 *
 * The templates are plain text in a shared LINE group, so three questions have
 * to be kept apart:
 *
 *   1. does anyone in this SOURCE own the market/date the message names?
 *   2. is the sender that owner?
 *   3. is this message our generated form, or a hand-typed legacy command?
 *
 * (1) and (2) are the source-wide ownership query; (3) is the signed marker.
 * Answering (3) is what lets a legitimate legacy command for an unowned target
 * keep working even while the sender has a guided round open for something else.
 */

process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

import { describe, expect, it } from "bun:test";
import { GuidedJourneyService } from "./journey";
import type { GuidedJourneyContext, GuidedJourneyState } from "./journey";
import { resolveGuidedOwnership } from "./ownership-guard";
import { signGuidedMarker } from "./provenance";
import { guardGuidedSlipOpen } from "./slip-open-guard";
import { guardGuidedWhiteSheetSubmission } from "./journey-bridge";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GuidedMenuStateService } from "./menu-state-service";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity } from "./ux-types";
import type { WhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import type { SlipSessionHeader } from "@/lib/slips/slip-session-service";
import type { WhiteSheetCashEntryState } from "@/lib/white-sheet/persist";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const OTHER_DATE = "2026-07-28";
const MARKET = "วัดทุ่งลานนา";
const OTHER_MARKET = "หน้าเซเวน";
const SELLER = "กี้";

const OWNER: GuidedMenuIdentity = {
  lineUserId: "U-owner",
  sourceType: "group",
  sourceId: SOURCE,
  sessionKey: `group:${SOURCE}:user:U-owner`,
};
const OTHER_OPERATOR: GuidedMenuIdentity = {
  lineUserId: "U-other",
  sourceType: "group",
  sourceId: SOURCE,
  sessionKey: `group:${SOURCE}:user:U-other`,
};
const OTHER_GROUP: GuidedMenuIdentity = {
  lineUserId: "U-owner",
  sourceType: "group",
  sourceId: "G-2",
  sessionKey: "group:G-2:user:U-owner",
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
  sessionGeneration: "gen-1",
};

const SUBMITTED: WhiteSheetCashEntryState = {
  status: "submitted",
  expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
  actualCashSubmitted: 0,
  updatedAt: `${DATE}T05:00:00Z`,
};

type FakeOwner =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "ambiguous"; lineUserIds: string[] }
  | { kind: "owned"; lineUserId: string; sessionKey: string };

type OwnerQuery = { marketLabelNormalized: string; businessDate: string };

/**
 * A journey double whose ownership answer is a FUNCTION of the query, the way
 * the real source-wide lookup is. By default the caller's own round owns its own
 * market/date and nothing else — a query for another target answers "nobody".
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
      ? {
          kind: "owned",
          lineUserId: context.lineUserId,
          sessionKey: context.sessionKey,
        }
      : { kind: "none" };
}

/** Answers "the round's owner" for every tuple — an edited target is still theirs. */
const OWNED_BY_ROUND_OWNER: FakeOwner = {
  kind: "owned",
  lineUserId: OWNER.lineUserId,
  sessionKey: OWNER.sessionKey!,
};

function stageState(
  stage: Exclude<GuidedJourneyState["stage"], "idle">,
  whiteSheet: WhiteSheetCashEntryState = SUBMITTED,
): GuidedJourneyState {
  return {
    stage,
    context: CONTEXT,
    session: { session_key: CONTEXT.sessionKey } as never,
    whiteSheet,
  };
}

const COMMAND: WhiteSheetCloseCommand = {
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  whiteSheetSales: 0,
  ownerCash: 0,
  labor: 0,
  locationFee: 0,
  bag: 0,
  snack: 0,
  other: undefined,
  actualCashSubmitted: 0,
};

function header(overrides: Partial<SlipSessionHeader> = {}): SlipSessionHeader {
  return {
    sellerName: SELLER,
    marketName: MARKET,
    slipDate: "29/07/2569",
    rawHeaderText: `${SELLER} ${MARKET} สลิปเงินโอน 29/07/2569`,
    batchType: "TRANSFER_SLIPS",
    ...overrides,
  };
}

/** The marker the bot would have put on the owner's own template. */
function ownerMarker(
  purpose: "white_sheet" | "slip_open" | "settlement",
  overrides: Partial<{
    lineUserId: string;
    sourceId: string;
    marketLabelNormalized: string;
    businessDate: string;
    sessionGeneration: string;
  }> = {},
): string {
  const marker = signGuidedMarker({
    purpose,
    sourceId: SOURCE,
    lineUserId: OWNER.lineUserId,
    marketLabelNormalized: MARKET,
    businessDate: DATE,
    sessionGeneration: CONTEXT.sessionGeneration,
    ...overrides,
  });
  if (!marker) throw new Error("test setup: marker could not be signed");
  return marker;
}

/** Always-assigned catalog, unless a test says otherwise. */
const CATALOG_OK = { isActiveSellerMarket: async () => true };
const CATALOG_REVOKED = { isActiveSellerMarket: async () => false };

// ── The shared ownership resolver ───────────────────────────────────────────

describe("source-wide guided ownership", () => {
  const target = { marketLabelNormalized: MARKET, businessDate: DATE };

  it("allows the owner past produce", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips")),
      identity: OWNER,
      target,
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("allowed");
  });

  it("refuses another operator when the round exists", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(
        { stage: "idle", reason: "no_session" },
        OWNED_BY_ROUND_OWNER,
      ),
      identity: OTHER_OPERATOR,
      target,
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.message).toContain(GUIDED_MENU_COPY.ownershipNothingRecorded);
    expect(verdict.message).toContain("เป็นของผู้ใช้อีกคน");
  });

  it("fails closed when two operators own a matching round", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }, {
        kind: "ambiguous",
        lineUserIds: [OWNER.lineUserId, OTHER_OPERATOR.lineUserId],
      }),
      identity: OWNER,
      target,
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.message).toContain("มากกว่าหนึ่งรอบ");
  });

  it("refuses the caller even when their own row also matches an ambiguous round", async () => {
    // B has a round of their own AND A owns the same tuple: still refused.
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips"), {
        kind: "ambiguous",
        lineUserIds: [OWNER.lineUserId, OTHER_OPERATOR.lineUserId],
      }),
      identity: OWNER,
      target,
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("refused");
  });

  it("refuses when the ownership question cannot be answered", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }, { kind: "unknown" }),
      identity: OTHER_OPERATOR,
      target,
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("refused");
  });

  it("refuses when the owner's own journey will not resolve", async () => {
    for (const reason of ["lookup_failed", "ownership_conflict"] as const) {
      const verdict = await resolveGuidedOwnership({
        journey: fakeJourney({ stage: "idle", reason }, OWNED_BY_ROUND_OWNER),
        identity: OWNER,
        target,
        purpose: "white_sheet",
      });
      expect(verdict.verdict).toBe("refused");
    }
  });

  it("keeps legacy fallback when nobody owns the market/date", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }, { kind: "none" }),
      identity: OTHER_OPERATOR,
      target,
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("not_guided");
  });

  it("refuses while the caller's own round is still in produce", async () => {
    for (const stage of ["capture", "awaiting_confirm"] as const) {
      const verdict = await resolveGuidedOwnership({
        journey: fakeJourney(stageState(stage, { status: "not_submitted" })),
        identity: OWNER,
        target,
        purpose: "white_sheet",
      });
      expect(verdict.verdict).toBe("refused");
    }
  });

  it("refuses while produce finalization is pending or failed", async () => {
    for (const [stage, copy] of [
      ["finalizing", GUIDED_MENU_COPY.produceFinalizing],
      ["finalize_failed", GUIDED_MENU_COPY.produceFinalizeFailedShort],
    ] as const) {
      const verdict = await resolveGuidedOwnership({
        journey: fakeJourney(stageState(stage, { status: "not_submitted" })),
        identity: OWNER,
        target,
        purpose: "white_sheet",
      });
      expect(verdict.verdict).toBe("refused");
      if (verdict.verdict !== "refused") return;
      expect(verdict.message).toContain(copy.split("\n")[0]!);
    }
  });

  it("refuses when the caller owns the target but their key resolves elsewhere", async () => {
    // Source-wide says this is their round; their own key says another one.
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips"), OWNED_BY_ROUND_OWNER),
      identity: OWNER,
      target: { marketLabelNormalized: OTHER_MARKET, businessDate: DATE },
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("refused");
  });
});

// ── Finding #5: provenance ─────────────────────────────────────────────────

describe("guided provenance decides how strictly a message is judged", () => {
  const target = { marketLabelNormalized: MARKET, businessDate: DATE };

  it("accepts the owner's own marked template", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips")),
      identity: OWNER,
      target,
      purpose: "white_sheet",
      marker: ownerMarker("white_sheet"),
    });
    expect(verdict.verdict).toBe("allowed");
  });

  it("rejects the owner's marked template copied by another operator", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips"), OWNED_BY_ROUND_OWNER),
      identity: OTHER_OPERATOR,
      target,
      purpose: "white_sheet",
      marker: ownerMarker("white_sheet"),
    });
    expect(verdict.verdict).toBe("refused");
  });

  it("rejects a marker minted for another operator, market, date or generation", async () => {
    for (const overrides of [
      { lineUserId: OTHER_OPERATOR.lineUserId },
      { marketLabelNormalized: OTHER_MARKET },
      { businessDate: OTHER_DATE },
      { sessionGeneration: "gen-2" },
      { sourceId: "G-2" },
    ]) {
      const verdict = await resolveGuidedOwnership({
        journey: fakeJourney(stageState("slips")),
        identity: OWNER,
        target,
        purpose: "white_sheet",
        marker: ownerMarker("white_sheet", overrides),
      });
      expect(verdict.verdict).toBe("refused");
      if (verdict.verdict !== "refused") continue;
      expect(verdict.message).toContain(GUIDED_MENU_COPY.ownershipNothingRecorded);
    }
  });

  it("rejects a marker minted for a different purpose", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips")),
      identity: OWNER,
      target,
      purpose: "white_sheet",
      marker: ownerMarker("slip_open"),
    });
    expect(verdict.verdict).toBe("refused");
  });

  it("rejects a tampered signature", async () => {
    const real = ownerMarker("white_sheet");
    const flipped = `${real.slice(0, -1)}${real.endsWith("A") ? "B" : "A"}`;
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips")),
      identity: OWNER,
      target,
      purpose: "white_sheet",
      marker: flipped,
    });
    expect(verdict.verdict).toBe("refused");
  });

  it("rejects a marked message aimed at a market/date nobody owns", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }, { kind: "none" }),
      identity: OWNER,
      target,
      purpose: "white_sheet",
      marker: ownerMarker("white_sheet"),
    });
    expect(verdict.verdict).toBe("refused");
  });

  it("does not let the caller's own round A block a legacy command for target B", async () => {
    // The whole point of the marker: an unmarked, hand-typed command for a
    // market/date no guided round owns runs exactly as it always did.
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips")),
      identity: OWNER,
      target: { marketLabelNormalized: OTHER_MARKET, businessDate: DATE },
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("not_guided");
  });

  it("still refuses an unmarked command aimed at an owned tuple", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }, OWNED_BY_ROUND_OWNER),
      identity: OTHER_OPERATOR,
      target,
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("refused");
  });

  it("leaves a later business date unaffected", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(stageState("slips")),
      identity: OWNER,
      target: { marketLabelNormalized: MARKET, businessDate: "2026-07-30" },
      purpose: "white_sheet",
    });
    expect(verdict.verdict).toBe("not_guided");
  });
});

// ── findRoundOwner against the fake database ───────────────────────────────

describe("findRoundOwner reads the source, not the caller", () => {
  function seedRound(db: GuidedMenuFakeDatabase, overrides: Record<string, unknown> = {}) {
    db.seedPendingSession({
      session_key: OWNER.sessionKey,
      source_id: SOURCE,
      line_user_id: OWNER.lineUserId,
      session_generation: "gen-1",
      accumulated_text: "",
      terminalized: true,
      finalization_status: "finalized",
      entry_origin: "structured_menu",
      business_date: DATE,
      staff_label: SELLER,
      market_label: MARKET,
      ...overrides,
    });
  }

  it("finds the owner of a terminalized round", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRound(db);
    const owner = await new GuidedJourneyService(db.asClient()).findRoundOwner({
      sourceId: SOURCE,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
    });
    expect(owner).toMatchObject({ kind: "owned", lineUserId: OWNER.lineUserId });
  });

  it("canonicalizes a messy raw market label before matching", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRound(db, { market_label: `  ${MARKET}  ` });
    const owner = await new GuidedJourneyService(db.asClient()).findRoundOwner({
      sourceId: SOURCE,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
    });
    expect(owner).toMatchObject({ kind: "owned" });
  });

  it("reports ambiguous when two operators own the same tuple", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRound(db);
    seedRound(db, {
      session_key: OTHER_OPERATOR.sessionKey,
      line_user_id: OTHER_OPERATOR.lineUserId,
    });
    const owner = await new GuidedJourneyService(db.asClient()).findRoundOwner({
      sourceId: SOURCE,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
    });
    expect(owner.kind).toBe("ambiguous");
  });

  it("stays 'owned' for the same operator's rotated rounds", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRound(db);
    seedRound(db, { session_generation: "gen-2" });
    const owner = await new GuidedJourneyService(db.asClient()).findRoundOwner({
      sourceId: SOURCE,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
    });
    expect(owner).toMatchObject({ kind: "owned", lineUserId: OWNER.lineUserId });
  });

  it("reports nobody for another market, another date or another source", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRound(db);
    const journey = new GuidedJourneyService(db.asClient());
    for (const query of [
      { sourceId: SOURCE, marketLabelNormalized: OTHER_MARKET, businessDate: DATE },
      { sourceId: SOURCE, marketLabelNormalized: MARKET, businessDate: OTHER_DATE },
      { sourceId: "G-2", marketLabelNormalized: MARKET, businessDate: DATE },
    ]) {
      expect(await journey.findRoundOwner(query)).toEqual({ kind: "none" });
    }
  });

  it("ignores legacy rows that carry no guided origin", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRound(db, { entry_origin: null });
    const owner = await new GuidedJourneyService(db.asClient()).findRoundOwner({
      sourceId: SOURCE,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
    });
    expect(owner).toEqual({ kind: "none" });
  });
});

// ── Finding #2: the White Sheet ────────────────────────────────────────────

describe("white sheet cannot be filed by a stranger", () => {
  it("lets the owner submit", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(stageState("white_sheet", { status: "not_submitted" })),
      identity: OWNER,
      command: COMMAND,
      marker: ownerMarker("white_sheet"),
    });
    expect(guard.verdict).toBe("allowed");
  });

  it("refuses another operator in the same group who copied the template", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(
        { stage: "idle", reason: "no_session" },
        OWNED_BY_ROUND_OWNER,
      ),
      identity: OTHER_OPERATOR,
      command: COMMAND,
      marker: ownerMarker("white_sheet"),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("refuses another group that copied the template", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(
        { stage: "idle", reason: "ownership_conflict" },
        OWNED_BY_ROUND_OWNER,
      ),
      identity: OTHER_GROUP,
      command: COMMAND,
      marker: ownerMarker("white_sheet"),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("still leaves a genuinely unguided market/date to the legacy command", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }, { kind: "none" }),
      identity: OTHER_OPERATOR,
      command: COMMAND,
    });
    expect(guard.verdict).toBe("not_guided");
  });

  it("refuses a marked sheet edited onto another date", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(
        stageState("white_sheet", { status: "not_submitted" }),
        OWNED_BY_ROUND_OWNER,
      ),
      identity: OWNER,
      command: { ...COMMAND, businessDate: OTHER_DATE },
      marker: ownerMarker("white_sheet"),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("gives the same verdict for a replayed identical submission", async () => {
    const journey = fakeJourney(stageState("white_sheet", { status: "not_submitted" }));
    const marker = ownerMarker("white_sheet");
    const first = await guardGuidedWhiteSheetSubmission({
      journey,
      identity: OWNER,
      command: COMMAND,
      marker,
    });
    const second = await guardGuidedWhiteSheetSubmission({
      journey,
      identity: OWNER,
      command: COMMAND,
      marker,
    });
    expect(second.verdict).toBe(first.verdict);
  });
});

// ── Finding #3 / #4: opening the slip batch ────────────────────────────────

describe("guided slip open is bound to the round", () => {
  it("lets the owner open the batch from the generated header", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header(),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("allowed");
  });

  it("rejects an edited seller", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header({ sellerName: "คนอื่น" }),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") return;
    expect(guard.message).toContain(GUIDED_MENU_COPY.ownershipNothingRecorded);
  });

  it("rejects an edited market", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips"), OWNED_BY_ROUND_OWNER),
      catalog: CATALOG_OK,
      identity: OTHER_OPERATOR,
      header: header({ marketName: OTHER_MARKET }),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("rejects an edited date on a marked header", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips"), OWNED_BY_ROUND_OWNER),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header({ slipDate: "28/07/2569" }),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("rejects a header whose date cannot be read at all", async () => {
    // Finding #4: recognized header, unreadable date — refuse, never legacy.
    for (const bad of ["32/13/2569", "29-07-2569", "ไม่ระบุ", null]) {
      const guard = await guardGuidedSlipOpen({
        journey: fakeJourney({ stage: "idle", reason: "no_session" }, { kind: "none" }),
        catalog: CATALOG_OK,
        identity: OTHER_OPERATOR,
        header: header({ slipDate: bad }),
      });
      expect(guard.verdict).toBe("refused");
      if (guard.verdict !== "refused") continue;
      expect(guard.message).toContain("วันที่ในหัวข้อสลิปไม่ถูกต้อง");
    }
  });

  it("rejects a header copied by another operator in the group", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(
        { stage: "idle", reason: "no_session" },
        OWNED_BY_ROUND_OWNER,
      ),
      catalog: CATALOG_OK,
      identity: OTHER_OPERATOR,
      header: header(),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("rejects a header used from another group", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(
        { stage: "idle", reason: "ownership_conflict" },
        OWNED_BY_ROUND_OWNER,
      ),
      catalog: CATALOG_OK,
      identity: OTHER_GROUP,
      header: header(),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("rejects a revoked seller-market assignment", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_REVOKED,
      identity: OWNER,
      header: header(),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") return;
    expect(guard.message).toContain("ไม่ได้ผูกกันในระบบแล้ว");
  });

  it("refuses before the white sheet is in", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("white_sheet", { status: "not_submitted" })),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header(),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") return;
    expect(guard.message).toContain("ยังไม่ได้บันทึกใบขาว");
  });

  it("refuses while produce is unfinished or failed", async () => {
    for (const stage of ["capture", "awaiting_confirm", "finalizing", "finalize_failed"] as const) {
      const guard = await guardGuidedSlipOpen({
        journey: fakeJourney(stageState(stage, { status: "not_submitted" })),
        catalog: CATALOG_OK,
        identity: OWNER,
        header: header(),
        marker: ownerMarker("slip_open"),
      });
      expect(guard.verdict).toBe("refused");
    }
  });

  it("refuses when the catalog lookup itself fails", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: {
        isActiveSellerMarket: async () => {
          throw new Error("catalog down");
        },
      },
      identity: OWNER,
      header: header(),
      marker: ownerMarker("slip_open"),
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") return;
    expect(guard.message).not.toContain("catalog down");
  });

  it("leaves a non-guided slip open untouched", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }, { kind: "none" }),
      catalog: CATALOG_OK,
      identity: OTHER_OPERATOR,
      header: header({ sellerName: "ใครก็ได้", marketName: "ตลาดอื่น" }),
    });
    expect(guard.verdict).toBe("not_guided");
  });

  it("leaves an unidentifiable market to the legacy path", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header({ marketName: "  " }),
    });
    expect(guard.verdict).toBe("not_guided");
  });

  it("gives the same verdict for a duplicate delivery of the same header", async () => {
    const journey = fakeJourney(stageState("slips"));
    const marker = ownerMarker("slip_open");
    const first = await guardGuidedSlipOpen({
      journey,
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header(),
      marker,
    });
    const second = await guardGuidedSlipOpen({
      journey,
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header(),
      marker,
    });
    expect(second.verdict).toBe(first.verdict);
  });
});

// ── The catalog check reuses the existing active-catalog loaders ───────────

describe("isActiveSellerMarket", () => {
  function catalogDb(active: { seller: boolean; market: boolean; link: boolean }) {
    const db = new GuidedMenuFakeDatabase();
    db.seedMarket({ market_code: "wat", label: MARKET, active: active.market });
    db.seedSeller({
      seller_code: "kee",
      label: SELLER,
      active: active.seller,
      sort_order: 1,
    });
    db.seedSellerMarket({
      seller_code: "kee",
      market_code: "wat",
      active: active.link,
      sort_order: 1,
    });
    return new GuidedMenuStateService(db.asClient());
  }

  it("is true for a live assignment", async () => {
    const service = catalogDb({ seller: true, market: true, link: true });
    expect(
      await service.isActiveSellerMarket({
        sellerLabel: SELLER,
        marketLabelNormalized: MARKET,
      }),
    ).toBe(true);
  });

  it("is false when the seller, the market or the link is inactive", async () => {
    for (const flags of [
      { seller: false, market: true, link: true },
      { seller: true, market: false, link: true },
      { seller: true, market: true, link: false },
    ]) {
      const service = catalogDb(flags);
      expect(
        await service.isActiveSellerMarket({
          sellerLabel: SELLER,
          marketLabelNormalized: MARKET,
        }),
      ).toBe(false);
    }
  });

  it("is false for an unknown seller or market", async () => {
    const service = catalogDb({ seller: true, market: true, link: true });
    expect(
      await service.isActiveSellerMarket({
        sellerLabel: "ไม่มีคนนี้",
        marketLabelNormalized: MARKET,
      }),
    ).toBe(false);
    expect(
      await service.isActiveSellerMarket({
        sellerLabel: SELLER,
        marketLabelNormalized: "ไม่มีตลาดนี้",
      }),
    ).toBe(false);
  });
});
