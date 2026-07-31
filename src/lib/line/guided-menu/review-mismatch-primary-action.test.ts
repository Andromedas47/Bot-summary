/**
 * PR #15 review — MEDIUM: the reconcile screen (ux-handler.ts's
 * renderRoundStatus, reached via "ดูสถานะ") must not tell the operator to
 * correct the settlement while showing "ตรวจและปิดรอบ" as the primary
 * action — that primary action was blocked by the very difference the text
 * says to fix. "แก้ไขยอดส่ง" must be primary whenever a correction template
 * is required, and only ONE message in the reply may ever carry the Quick
 * Reply.
 */

process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

import { describe, expect, it } from "bun:test";
import { GuidedMenuUxHandler } from "./ux-handler";
import type { GuidedJourneyContext, GuidedJourneyState } from "./journey";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity, LineTextMessage } from "./ux-types";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";
const SELLER = "กี้";

const IDENTITY: GuidedMenuIdentity = {
  lineUserId: "U-op-1",
  sourceType: "group",
  sourceId: SOURCE,
  sessionKey: `group:${SOURCE}:user:U-op-1`,
};

const CONTEXT: GuidedJourneyContext = {
  sessionKey: IDENTITY.sessionKey!,
  sourceId: SOURCE,
  lineUserId: IDENTITY.lineUserId,
  sellerLabel: SELLER,
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

const RECONCILE_STATE: GuidedJourneyState = {
  stage: "reconcile",
  context: CONTEXT,
  session: { session_key: CONTEXT.sessionKey } as never,
  whiteSheet: {
    status: "submitted",
    expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
    actualCashSubmitted: 0,
    updatedAt: `${DATE}T05:00:00Z`,
  },
};

function mintingStateService() {
  let n = 0;
  return {
    resolveOperator: async () => ({ status: "mapped" as const }),
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

function handlerWithReport(report: {
  totals: {
    checkedSlipTotal: number;
    submittedTransferTotal: number | null;
    difference: number | null;
  };
  blockers: string[];
}): GuidedMenuUxHandler {
  return new GuidedMenuUxHandler({} as never, {
    stateService: mintingStateService() as never,
    journeyService: { resolve: async () => RECONCILE_STATE } as never,
    roundService: {
      report: async () => ({
        totals: report.totals,
        slips: [],
        blockers: report.blockers,
        unresolvedCount: 0,
        pendingReferenceCount: 0,
      }),
    } as never,
  });
}

describe("reconcile mismatch — primary action agrees with the correction instruction", () => {
  it("submitted + mismatch: primary Quick Reply is แก้ไขยอดส่ง, never ตรวจและปิดรอบ first", async () => {
    const handler = handlerWithReport({
      totals: { checkedSlipTotal: 1000, submittedTransferTotal: 1200, difference: 200 },
      blockers: ["difference_non_zero"],
    });

    const result = await handler.openMenu({ identity: IDENTITY });
    const messages = result.messages as LineTextMessage[];

    // The correction template is included in the response.
    expect(result.screen).toBe("settlement_template");
    expect(messages.some((m) => m.text.includes("ส่งยอด"))).toBe(true);

    // Text and primary action agree: the operator is told to correct and
    // resend, never to close.
    const statusMessage = messages[0]!;
    expect(statusMessage.text).toContain(GUIDED_MENU_COPY.roundMismatchHeading);
    expect(statusMessage.text).toContain(GUIDED_MENU_COPY.roundMismatchSubmittedNextStep);

    // At most one message in a multi-message reply carries a Quick Reply.
    const withQuickReply = messages.filter((m) => m.quickReply);
    expect(withQuickReply).toHaveLength(1);

    // The ONE Quick Reply's first action is แก้ไขยอดส่ง — ตรวจและปิดรอบ is
    // never offered while a correction is required.
    const labels = quickReplyLabelsAndTypes(withQuickReply[0]!);
    expect(labels[0]![0]).toBe(GUIDED_MENU_COPY.editSettlementLabel);
    expect(labels.map(([label]) => label)).not.toContain(
      GUIDED_MENU_COPY.checkAndCloseLabel,
    );
  });

  it("submitted + ready (no blockers): primary Quick Reply is ตรวจและปิดรอบ", async () => {
    const handler = handlerWithReport({
      totals: { checkedSlipTotal: 1000, submittedTransferTotal: 1000, difference: 0 },
      blockers: [],
    });

    const result = await handler.openMenu({ identity: IDENTITY });
    const messages = result.messages as LineTextMessage[];
    expect(result.screen).toBe("round_status");

    const withQuickReply = messages.filter((m) => m.quickReply);
    expect(withQuickReply).toHaveLength(1);
    const labels = quickReplyLabelsAndTypes(withQuickReply[0]!);
    expect(labels[0]![0]).toBe(GUIDED_MENU_COPY.checkAndCloseLabel);
  });

  it("not yet submitted (settlement_missing): primary Quick Reply is กรอกยอดส่ง — unaffected by the mismatch fix", async () => {
    const handler = handlerWithReport({
      totals: { checkedSlipTotal: 1000, submittedTransferTotal: null, difference: null },
      blockers: ["settlement_missing"],
    });

    const result = await handler.openMenu({ identity: IDENTITY });
    const messages = result.messages as LineTextMessage[];
    const withQuickReply = messages.filter((m) => m.quickReply);
    expect(withQuickReply).toHaveLength(1);
    const labels = quickReplyLabelsAndTypes(withQuickReply[0]!);
    expect(labels[0]![0]).toBe("กรอกยอดส่ง");
  });
});
