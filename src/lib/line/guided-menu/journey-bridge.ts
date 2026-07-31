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
  type GuidedJourneyContext,
} from "./journey";
import { resolveGuidedOwnership } from "./ownership-guard";
import {
  GuidedRoundService,
  GUIDED_ROUND_BLOCKER_ACTION_LABEL,
  classifyGuidedRoundBlockers,
  type GuidedRoundCloseOutcome,
} from "./round-close";
import { bindQuickReply, buildPlainTextMessage } from "./messages";
import { GUIDED_MENU_COPY } from "./ux-types";
import type {
  GuidedMenuIdentity,
  GuidedMenuLineMessage,
  LineQuickReply,
} from "./ux-types";
import type { GuidedMenuStateService } from "./menu-state-service";

/**
 * Mint a "เริ่มรายการใหม่" token — the `menu_root` action with an empty,
 * non-cancel payload, exactly what the seller screen's existing "back" button
 * already uses. Standalone so both the postback-driven UX handler and the
 * plain-text "ปิดรอบ" reply path (webhook-service.ts, outside the handler)
 * can offer the same one recovery action without duplicating token creation.
 */
export async function mintGuidedStartNewToken(
  stateService: GuidedMenuStateService,
  identity: GuidedMenuIdentity,
): Promise<string | null> {
  const created = await stateService.createState({
    actionType: "menu_root",
    lineUserId: identity.lineUserId,
    sourceType: identity.sourceType,
    sourceId: identity.sourceId,
    sessionKey: identity.sessionKey,
    payload: {},
  });
  return created.status === "created" ? created.wireToken : null;
}

/** Quick Reply offering only "เริ่มรายการใหม่", for a terminal journey screen. */
export async function buildGuidedStartNewQuickReply(
  stateService: GuidedMenuStateService,
  identity: GuidedMenuIdentity,
): Promise<LineQuickReply | undefined> {
  const wireToken = await mintGuidedStartNewToken(stateService, identity);
  if (!wireToken) return undefined;
  return bindQuickReply([
    {
      label: GUIDED_MENU_COPY.startNewLabel,
      actionType: "menu_root",
      payload: {},
      wireToken,
    },
  ]);
}

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
  | { verdict: "refused"; message: string; reason?: "stale_form" };

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
  messages: GuidedMenuLineMessage[];
  closed: boolean;
};

const round2 = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

function formatBaht(value: number): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} บาท`;
}

/**
 * "ตรวจและปิดรอบ" — the one authoritative check-and-close action.
 *
 * Reuses the exact existing contract unchanged: `GuidedRoundService.close`
 * (round-close.ts) already checks every lifecycle blocker and, only when none
 * remain, calls the same idempotent `tryFinalizeSettlement` the legacy
 * "ปิดรอบ" text command has always used. Nothing here decides whether the
 * round is allowed to close — it only renders three READ-ONLY outcomes: a
 * checklist of what is still missing, an amount mismatch, or a closed round.
 */
export async function processGuidedRoundClose(input: {
  journey: GuidedJourneyService;
  rounds: GuidedRoundService;
  identity: GuidedMenuIdentity;
  stateService: GuidedMenuStateService;
  push?: (to: string, text: string, retryKey?: string) => Promise<unknown>;
}): Promise<GuidedRoundCloseReply> {
  const state = await input.journey.resolve(input.identity);
  if (state.stage === "idle") {
    return {
      messages: [buildPlainTextMessage(GUIDED_MENU_COPY.roundCloseNoJourney)],
      closed: false,
    };
  }
  // An unfinished produce round is never skipped past to close a settlement.
  if (state.stage === "capture" || state.stage === "awaiting_confirm") {
    return {
      messages: [
        buildPlainTextMessage(
          [
            "ยังปิดรอบไม่ได้ รายการสินค้ายังไม่จบ",
            'กรุณากด "จบการกรอกสินค้า" และยืนยันให้เรียบร้อยก่อน',
          ].join("\n"),
        ),
      ],
      closed: false,
    };
  }
  // Produce rows are not proven to exist yet, or provably do not.
  if (state.stage === "finalizing") {
    return {
      messages: [buildPlainTextMessage(GUIDED_MENU_COPY.produceFinalizing)],
      closed: false,
    };
  }
  if (state.stage === "finalize_failed") {
    const quickReply = await buildGuidedStartNewQuickReply(
      input.stateService,
      input.identity,
    );
    const base = buildPlainTextMessage(GUIDED_MENU_COPY.produceFailedZeroWrites);
    return {
      messages: [quickReply ? { ...base, quickReply } : base],
      closed: false,
    };
  }
  // A round that already closed is re-checked idempotently below —
  // tryFinalizeSettlement answers `already_done`, never a second close.

  const whiteSheetSubmitted = state.whiteSheet.status !== "not_submitted";
  const outcome: GuidedRoundCloseOutcome = await input.rounds.close(
    state.context,
    whiteSheetSubmitted,
    input.push,
  );

  if (outcome.status === "closed") {
    const quickReply = await buildGuidedStartNewQuickReply(
      input.stateService,
      input.identity,
    );
    const base = buildPlainTextMessage(GUIDED_MENU_COPY.roundClosed);
    return { messages: [quickReply ? { ...base, quickReply } : base], closed: true };
  }

  const blockers =
    outcome.status === "settlement_refused" ? [] : outcome.report.blockers;
  const kind =
    outcome.status === "settlement_refused"
      ? "missing"
      : classifyGuidedRoundBlockers(blockers);

  if (kind === "mismatch_only") {
    const totals = outcome.report.totals;
    const checked = round2(totals.checkedSlipTotal);
    const submitted = round2(totals.submittedTransferTotal ?? 0);
    const difference = round2(totals.difference ?? submitted - checked);
    const text = [
      GUIDED_MENU_COPY.roundMismatchHeading,
      "",
      `ยอดที่ตรวจแล้ว: ${formatBaht(checked)}`,
      `ยอดส่งที่บันทึก: ${formatBaht(submitted)}`,
      `ผลต่าง: ${difference >= 0 ? "+" : ""}${formatBaht(difference)}`,
      "",
      GUIDED_MENU_COPY.roundMismatchNextStep,
    ].join("\n");
    return {
      messages: [buildPlainTextMessage(text)],
      closed: false,
    };
  }

  // "missing": one or more preconditions besides a plain amount mismatch.
  // Deduplicated and in the report's own priority order, so the FIRST line is
  // the one primary action — e.g. white-sheet-missing always outranks a slip
  // or settlement blocker, matching the journey's own stage ordering.
  const checklist =
    blockers.length > 0
      ? [...new Set(blockers.map((b) => GUIDED_ROUND_BLOCKER_ACTION_LABEL[b]))].map(
          (label) => `• ${label}`,
        )
      : [
          `• (${
            outcome.status === "settlement_refused" ? outcome.settlement : "unknown"
          })`,
        ];
  const text = [
    GUIDED_MENU_COPY.roundNotReadyHeading,
    "",
    GUIDED_MENU_COPY.roundNotReadyNextSteps,
    ...checklist,
  ].join("\n");
  return {
    messages: [buildPlainTextMessage(text)],
    closed: false,
  };
}
