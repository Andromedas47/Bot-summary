/**
 * Slices 3C/3D — where the guided journey meets the existing text commands.
 *
 * The guided flow hands the operator ready-made messages in the syntax the
 * existing commands already accept, so the White Sheet and the transfer-slip
 * batch keep exactly one parser, one validator and one lifecycle each. This
 * module adds only two things around them:
 *
 *   1. a guard so a guided operator cannot submit a White Sheet for a market
 *      or date other than the round they are standing in;
 *   2. the handoff copy that carries them to the next stage.
 *
 * It never parses money, never persists a sheet and never closes a batch.
 */

import type { WhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import {
  GuidedJourneyService,
  buildSlipHeaderTemplate,
  thaiDateFromIso,
  type GuidedJourneyContext,
} from "./journey";
import { resolveGuidedOwnership } from "./ownership-guard";
import {
  GuidedRoundService,
  GUIDED_ROUND_BLOCKER_LABEL,
  summarizeSlipStatuses,
  type GuidedRoundCloseOutcome,
} from "./round-close";
import { buildRoundStatusMessage } from "./messages";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity } from "./ux-types";

/** Exact text that asks the guided flow to close the round. */
export function isGuidedRoundCloseCommand(text: string): boolean {
  return text.trim() === GUIDED_MENU_COPY.roundCloseCommand;
}

export type GuidedWhiteSheetGuard =
  /** No guided round for this operator — the legacy direct command is unaffected. */
  | { verdict: "not_guided" }
  /** Submission agrees with the round; let the existing command through. */
  | { verdict: "allowed"; context: GuidedJourneyContext }
  /** Submission targets another market/date — refuse, write nothing. */
  | { verdict: "refused"; message: string };

/**
 * Verify a White Sheet closing command against the guided round that owns the
 * submitted market and business date.
 *
 * The question is deliberately source-wide, not per operator: the template is
 * plain text in a shared group, so asking only "does the sender have a round?"
 * let a second member copy the first member's sheet and fall through to the
 * legacy group writer. `resolveGuidedOwnership` answers ownership for the
 * market/date and fails closed when it cannot — including on a lookup error,
 * because degrading to `not_guided` is exactly how that hole appeared.
 *
 * Legacy behaviour is preserved where it is genuinely legacy: a market/date no
 * guided round owns still runs the pre-existing direct command untouched, even
 * when the sender happens to have a guided round open for something else. The
 * signed marker on generated templates is what makes that distinction safe.
 */
export async function guardGuidedWhiteSheetSubmission(input: {
  journey: GuidedJourneyService;
  identity: GuidedMenuIdentity;
  command: WhiteSheetCloseCommand;
  marker?: string | null;
}): Promise<GuidedWhiteSheetGuard> {
  const ownership = await resolveGuidedOwnership({
    journey: input.journey,
    identity: input.identity,
    target: {
      marketLabelNormalized: input.command.marketLabelNormalized,
      businessDate: input.command.businessDate,
    },
    purpose: "white_sheet",
    marker: input.marker,
  });
  if (ownership.verdict === "allowed") {
    return { verdict: "allowed", context: ownership.context };
  }
  return ownership;
}

/**
 * The 3C → 3D handoff appended after a White Sheet submission that persisted.
 * Returns null when the round context cannot produce a valid slip header, so a
 * malformed handoff is never shown.
 */
export function buildSlipHandoffMessages(
  context: GuidedJourneyContext,
): string[] | null {
  const header = buildSlipHeaderTemplate(context);
  if (!header) return null;
  return [
    [
      GUIDED_MENU_COPY.nextStepSlips,
      "",
      GUIDED_MENU_COPY.slipInstructions,
    ].join("\n"),
    header,
    `เมื่อตรวจสลิปครบแล้ว พิมพ์ "${GUIDED_MENU_COPY.roundCloseCommand}" เพื่อปิดรอบ`,
  ];
}

export type GuidedRoundCloseReply = {
  messages: string[];
  closed: boolean;
};

/**
 * Handle the `ปิดรอบ` command end to end and render the operator's receipt.
 *
 * The decision to close is never made here: closeGuidedRound checks the
 * existing lifecycle blockers and then defers to tryFinalizeSettlement, which
 * remains authoritative and idempotent on retry.
 */
export async function processGuidedRoundClose(input: {
  journey: GuidedJourneyService;
  rounds: GuidedRoundService;
  identity: GuidedMenuIdentity;
  push?: (to: string, text: string, retryKey?: string) => Promise<unknown>;
  closeLineEventId?: string;
}): Promise<GuidedRoundCloseReply> {
  const state = await input.journey.resolve(input.identity);
  if (state.stage === "idle") {
    return { messages: [GUIDED_MENU_COPY.roundCloseNoJourney], closed: false };
  }
  // An unfinished produce round is never skipped past to close a settlement.
  if (state.stage === "capture" || state.stage === "awaiting_confirm") {
    return {
      messages: [
        [
          "ยังปิดรอบไม่ได้ รายการสินค้ายังไม่จบ",
          'กรุณากด "จบรายการ" และยืนยันให้เรียบร้อยก่อน',
        ].join("\n"),
      ],
      closed: false,
    };
  }
  // Produce rows are not proven to exist yet, or provably do not.
  if (state.stage === "finalizing") {
    return { messages: [GUIDED_MENU_COPY.produceFinalizing], closed: false };
  }
  if (state.stage === "finalize_failed") {
    return {
      messages: [GUIDED_MENU_COPY.produceFinalizeFailedShort],
      closed: false,
    };
  }

  const whiteSheetSubmitted = state.whiteSheet.status !== "not_submitted";
  const outcome: GuidedRoundCloseOutcome = await input.rounds.close(
    state.context,
    whiteSheetSubmitted,
    input.push,
    input.closeLineEventId,
  );

  const dateThaiShort =
    thaiDateFromIso(state.context.businessDate) ?? state.context.businessDate;
  const blockerLines =
    outcome.status === "closed"
      ? []
      : [
          ...outcome.report.blockers.map((b) => GUIDED_ROUND_BLOCKER_LABEL[b]),
          ...(outcome.status === "settlement_refused"
            ? [`ระบบปิดยอดยังไม่พร้อม (${outcome.settlement})`]
            : []),
          `แก้ไขแล้วพิมพ์ "${GUIDED_MENU_COPY.roundCloseCommand}" อีกครั้ง`,
        ];

  const receipt = buildRoundStatusMessage({
    sellerLabel: state.context.sellerLabel,
    marketLabel: state.context.marketLabel,
    dateThaiShort,
    totals: outcome.report.totals,
    slipCounts: summarizeSlipStatuses(outcome.report.slips),
    blockerLines,
    closed: outcome.status === "closed",
  });

  return { messages: [receipt.text], closed: outcome.status === "closed" };
}
