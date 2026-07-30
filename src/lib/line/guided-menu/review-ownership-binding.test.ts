/**
 * PR #10 review findings #2 and #3 — the two legacy writers a guided operator is
 * handed a template for must be bound to the round that owns the market/date.
 *
 * Both templates are plain text in a shared LINE group. Asking only "does the
 * sender have a round?" let a second member copy the first member's message and
 * fall through to the shared legacy writer, so the question here is source-wide
 * and it fails closed.
 */

import { describe, expect, it } from "bun:test";
import { GuidedJourneyService } from "./journey";
import type { GuidedJourneyContext, GuidedJourneyState } from "./journey";
import { resolveGuidedOwnership } from "./ownership-guard";
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
const MARKET = "วัดทุ่งลานนา";
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
  | { kind: "owned"; lineUserId: string; sessionKey: string };

function fakeJourney(state: GuidedJourneyState, owner: FakeOwner = { kind: "none" }) {
  return {
    resolve: async () => state,
    findRoundOwner: async () => owner,
  } as never;
}

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
    });
    expect(verdict.verdict).toBe("allowed");
  });

  it("refuses another operator who owns nothing but the round exists", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney(
        { stage: "idle", reason: "no_session" },
        { kind: "owned", lineUserId: OWNER.lineUserId, sessionKey: OWNER.sessionKey! },
      ),
      identity: OTHER_OPERATOR,
      target,
    });
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.message).toContain(GUIDED_MENU_COPY.ownershipNothingRecorded);
    expect(verdict.message).toContain("เป็นของผู้ใช้อีกคน");
  });

  it("refuses an ownership conflict rather than calling it not_guided", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney({ stage: "idle", reason: "ownership_conflict" }),
      identity: OTHER_OPERATOR,
      target,
    });
    expect(verdict.verdict).toBe("refused");
  });

  it("refuses when the ownership question cannot be answered", async () => {
    for (const journey of [
      fakeJourney({ stage: "idle", reason: "lookup_failed" }),
      fakeJourney({ stage: "idle", reason: "no_session" }, { kind: "unknown" }),
    ]) {
      const verdict = await resolveGuidedOwnership({
        journey,
        identity: OTHER_OPERATOR,
        target,
      });
      expect(verdict.verdict).toBe("refused");
    }
  });

  it("keeps legacy fallback when nobody owns the market/date", async () => {
    const verdict = await resolveGuidedOwnership({
      journey: fakeJourney({ stage: "idle", reason: "no_session" }, { kind: "none" }),
      identity: OTHER_OPERATOR,
      target,
    });
    expect(verdict.verdict).toBe("not_guided");
  });

  it("refuses while the caller's own round is still in produce", async () => {
    for (const stage of ["capture", "awaiting_confirm"] as const) {
      const verdict = await resolveGuidedOwnership({
        journey: fakeJourney(stageState(stage, { status: "not_submitted" })),
        identity: OWNER,
        target,
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
      });
      expect(verdict.verdict).toBe("refused");
      if (verdict.verdict !== "refused") return;
      expect(verdict.message).toContain(copy.split("\n")[0]!);
    }
  });

  it("refuses a market or date that is not the caller's round", async () => {
    for (const other of [
      { marketLabelNormalized: "หน้าเซเวน", businessDate: DATE },
      { marketLabelNormalized: MARKET, businessDate: "2026-07-28" },
    ]) {
      const verdict = await resolveGuidedOwnership({
        journey: fakeJourney(stageState("slips")),
        identity: OWNER,
        target: other,
      });
      expect(verdict.verdict).toBe("refused");
    }
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

  it("reports nobody for another market, another date or another source", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRound(db);
    const journey = new GuidedJourneyService(db.asClient());
    for (const query of [
      { sourceId: SOURCE, marketLabelNormalized: "หน้าเซเวน", businessDate: DATE },
      { sourceId: SOURCE, marketLabelNormalized: MARKET, businessDate: "2026-07-28" },
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
    });
    expect(guard.verdict).toBe("allowed");
  });

  it("refuses another operator in the same group who copied the template", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(
        { stage: "idle", reason: "no_session" },
        { kind: "owned", lineUserId: OWNER.lineUserId, sessionKey: OWNER.sessionKey! },
      ),
      identity: OTHER_OPERATOR,
      command: COMMAND,
    });
    expect(guard.verdict).toBe("refused");
  });

  it("refuses another group that copied the template", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(
        { stage: "idle", reason: "ownership_conflict" },
        { kind: "owned", lineUserId: OWNER.lineUserId, sessionKey: OWNER.sessionKey! },
      ),
      identity: OTHER_GROUP,
      command: COMMAND,
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

  it("refuses a wrong market/date for the owner too", async () => {
    const guard = await guardGuidedWhiteSheetSubmission({
      journey: fakeJourney(stageState("white_sheet", { status: "not_submitted" })),
      identity: OWNER,
      command: { ...COMMAND, businessDate: "2026-07-28" },
    });
    expect(guard.verdict).toBe("refused");
  });

  it("gives the same verdict for a replayed identical submission", async () => {
    const journey = fakeJourney(stageState("white_sheet", { status: "not_submitted" }));
    const first = await guardGuidedWhiteSheetSubmission({
      journey,
      identity: OWNER,
      command: COMMAND,
    });
    const second = await guardGuidedWhiteSheetSubmission({
      journey,
      identity: OWNER,
      command: COMMAND,
    });
    expect(second.verdict).toBe(first.verdict);
  });
});

// ── Finding #3: opening the slip batch ─────────────────────────────────────

describe("guided slip open is bound to the round", () => {
  it("lets the owner open the batch from the generated header", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header(),
    });
    expect(guard.verdict).toBe("allowed");
  });

  it("rejects an edited seller", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header({ sellerName: "คนอื่น" }),
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") return;
    expect(guard.message).toContain(GUIDED_MENU_COPY.ownershipNothingRecorded);
  });

  it("rejects an edited market", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header({ marketName: "หน้าเซเวน" }),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("rejects an edited date", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header({ slipDate: "28/07/2569" }),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("rejects a header copied by another operator in the group", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(
        { stage: "idle", reason: "no_session" },
        { kind: "owned", lineUserId: OWNER.lineUserId, sessionKey: OWNER.sessionKey! },
      ),
      catalog: CATALOG_OK,
      identity: OTHER_OPERATOR,
      header: header(),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("rejects a header used from another group", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(
        { stage: "idle", reason: "ownership_conflict" },
        { kind: "owned", lineUserId: OWNER.lineUserId, sessionKey: OWNER.sessionKey! },
      ),
      catalog: CATALOG_OK,
      identity: OTHER_GROUP,
      header: header(),
    });
    expect(guard.verdict).toBe("refused");
  });

  it("rejects a revoked seller-market assignment", async () => {
    const guard = await guardGuidedSlipOpen({
      journey: fakeJourney(stageState("slips")),
      catalog: CATALOG_REVOKED,
      identity: OWNER,
      header: header(),
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

  it("leaves an undated or unreadable header to the legacy path", async () => {
    for (const bad of [{ slipDate: null }, { slipDate: "ไม่ระบุ" }, { marketName: "  " }]) {
      const guard = await guardGuidedSlipOpen({
        journey: fakeJourney(stageState("slips")),
        catalog: CATALOG_OK,
        identity: OWNER,
        header: header(bad),
      });
      expect(guard.verdict).toBe("not_guided");
    }
  });

  it("gives the same verdict for a duplicate delivery of the same header", async () => {
    const journey = fakeJourney(stageState("slips"));
    const first = await guardGuidedSlipOpen({
      journey,
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header(),
    });
    const second = await guardGuidedSlipOpen({
      journey,
      catalog: CATALOG_OK,
      identity: OWNER,
      header: header(),
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
