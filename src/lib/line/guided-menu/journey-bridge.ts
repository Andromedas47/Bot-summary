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
  buildWhiteSheetTemplate,
  type GuidedJourneyContext,
} from "./journey";
import {
  resolveGuidedOwnership,
  type GuidedOwnershipDebugReason,
} from "./ownership-guard";
import type { GuidedMarkerPurpose } from "./provenance";
import { buildSettlementTemplate } from "./settlement-command";
import {
  GuidedRoundService,
  GUIDED_ROUND_BLOCKER_ACTION_LABEL,
  classifyGuidedRoundBlockers,
  type GuidedRoundCloseOutcome,
} from "./round-close";
import {
  bindMixedQuickReply,
  bindQuickReply,
  buildPlainTextMessage,
} from "./messages";
import { GUIDED_MENU_COPY, GUIDED_MENU_TRIGGER } from "./ux-types";
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

/**
 * Mint a "ดูสถานะ" (`view_status`) token — the SAME re-render every "ดูสถานะ"
 * button on every stage already uses (ux-handler.ts's viewStatus). It always
 * re-resolves the journey server-side at press time, so it can never be
 * stale: pressed early it shows the current stage, pressed after the round
 * moved on (or closed) it shows THAT instead — never the old stage.
 */
async function mintGuidedViewStatusToken(
  stateService: GuidedMenuStateService,
  identity: GuidedMenuIdentity,
): Promise<string | null> {
  const created = await stateService.createState({
    actionType: "view_status",
    lineUserId: identity.lineUserId,
    sourceType: identity.sourceType,
    sourceId: identity.sourceId,
    sessionKey: identity.sessionKey,
    payload: {},
  });
  return created.status === "created" ? created.wireToken : null;
}

/**
 * The purpose-specific template builder — the same pure function each
 * stage's own renderer already calls. Regenerating a stale form means
 * calling this again with the CURRENT context, never inventing a new path.
 */
function buildRegeneratedGuidedForm(
  purpose: GuidedMarkerPurpose,
  context: GuidedJourneyContext,
): string | null {
  if (purpose === "white_sheet") return buildWhiteSheetTemplate(context);
  if (purpose === "slip_open") return buildSlipHeaderTemplate(context);
  return buildSettlementTemplate(context);
}

/**
 * Recovery Quick Reply for ownership-guard's `reason: "stale_form"`.
 *
 * `regenerate` present → the SAME purpose still applies to the caller's
 * current stage: "สร้างแบบฟอร์มใหม่" resubmits a FRESH, purpose-specific
 * template built from the live context (a brand-new marker, since a stale
 * marker is only reachable via an older session generation or a tampered
 * signature — never the one the fresh call produces), through the exact same
 * text-command parser and guard every hand-typed submission already goes
 * through. Nothing is written by pressing the button itself.
 *
 * `regenerate` absent → the form no longer applies at all (the round moved
 * on, or closed): only a status check is offered, never a false promise of a
 * new form.
 */
export function buildStaleFormRecoveryQuickReply(
  regenerate?: { purpose: GuidedMarkerPurpose; context: GuidedJourneyContext },
): LineQuickReply {
  if (regenerate) {
    const fresh = buildRegeneratedGuidedForm(regenerate.purpose, regenerate.context);
    if (fresh) {
      try {
        return bindMixedQuickReply([
          {
            kind: "message",
            label: GUIDED_MENU_COPY.generateNewFormLabel,
            text: fresh,
          },
          { kind: "message", label: "ออกจากเมนู", text: "ออกจากเมนู" },
        ]);
      } catch {
        // Graceful fallback: an unexpectedly long template (e.g. unusually
        // long seller/market labels) never crashes the reply — it just falls
        // back to the plain status-check recovery below.
      }
    }
  }
  return bindMixedQuickReply([
    { kind: "message", label: "ดูสถานะ", text: GUIDED_MENU_TRIGGER },
    { kind: "message", label: "ออกจากเมนู", text: "ออกจากเมนู" },
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
  | {
      verdict: "refused";
      message: string;
      reason?: "stale_form";
      regenerate?: { purpose: GuidedMarkerPurpose; context: GuidedJourneyContext };
      debugReason?: GuidedOwnershipDebugReason;
    };

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
    // ONE primary action, on this ONE message: "แก้ไขยอดส่ง" re-renders the
    // reconcile screen, which (since difference_non_zero is the sole blocker)
    // hands back a fresh settlement template on THAT next screen — never
    // attached here too, so no message ever carries two competing Quick
    // Replies for the same next step.
    const quickReply = await buildRoundCloseActionQuickReply(
      input.stateService,
      input.identity,
      GUIDED_MENU_COPY.editSettlementLabel,
    );
    const base = buildPlainTextMessage(text);
    return {
      messages: [quickReply ? { ...base, quickReply } : base],
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
  // The FIRST blocker in the report's own priority order is the one primary
  // button — every other blocker stays a plain bullet above, per the required
  // UX (one authoritative next step, not a wall of buttons).
  const primaryLabel =
    blockers.length > 0
      ? GUIDED_ROUND_BLOCKER_ACTION_LABEL[blockers[0]!]
      : "ดูสถานะ";
  const quickReply = await buildRoundCloseActionQuickReply(
    input.stateService,
    input.identity,
    primaryLabel,
  );
  const base = buildPlainTextMessage(text);
  return {
    messages: [quickReply ? { ...base, quickReply } : base],
    closed: false,
  };
}

/**
 * ONE primary recovery action for a non-terminal ตรวจและปิดรอบ result, always
 * bound to the SAME "ดูสถานะ" (`view_status`) re-render every stage screen
 * already uses — it re-resolves the journey server-side at press time, so the
 * button always lands on whatever is actually next (the White Sheet template,
 * the still-open slip batch, the settlement template, …), never a stale
 * screen. `ดูสถานะ` is added as a secondary button only when the primary
 * label is itself something else, so the same action is never offered twice.
 * A token-mint failure degrades to no Quick Reply — the checklist text alone
 * still renders.
 */
async function buildRoundCloseActionQuickReply(
  stateService: GuidedMenuStateService,
  identity: GuidedMenuIdentity,
  primaryLabel: string,
): Promise<LineQuickReply | undefined> {
  try {
    const primaryToken = await mintGuidedViewStatusToken(stateService, identity);
    if (!primaryToken) return undefined;
    const buttons: Array<{
      kind: "token";
      label: string;
      wireToken: string;
    }> = [{ kind: "token", label: primaryLabel, wireToken: primaryToken }];
    if (primaryLabel !== "ดูสถานะ") {
      const statusToken = await mintGuidedViewStatusToken(stateService, identity);
      if (statusToken) {
        buttons.push({ kind: "token", label: "ดูสถานะ", wireToken: statusToken });
      }
    }
    return bindMixedQuickReply(buttons);
  } catch {
    return undefined;
  }
}
