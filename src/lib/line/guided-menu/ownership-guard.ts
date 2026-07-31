/**
 * Who may write for a guided round — asked before the White Sheet command, the
 * slip-batch open and the settlement submission.
 *
 * Two independent questions, in this order, and both must pass:
 *
 *   1. SOURCE-WIDE OWNERSHIP of the target (market + business date). The produce
 *      session key is per operator, so "does the sender have a round?" can never
 *      see a second member of the same LINE group standing on the same round.
 *      This asks the source-wide question first, and it fails closed on another
 *      owner, on more than one owner, and on a lookup it cannot answer.
 *
 *   2. PROVENANCE of the message. A generated template carries an opaque signed
 *      marker (provenance.ts). That is what separates the three cases plain text
 *      cannot:
 *        - marked   → this is our form: it must match this operator, this round
 *                     and this purpose exactly, or it is refused;
 *        - unmarked → judged only by whether the TARGET is owned. A legitimate
 *                     legacy command for an unowned market/date runs exactly as
 *                     it did before the guided flow existed, even when the sender
 *                     happens to have a guided round open for something else.
 *
 * That last point is the whole reason the marker exists: without it, refusing
 * every message whose target differs from the caller's own round breaks years of
 * legitimate legacy usage, and allowing it lets a copied template through.
 *
 * Nothing here writes, parses money or duplicates a lifecycle rule.
 */

import { normalizedMarketLabel } from "@/lib/market";
import { thaiDateFromIso } from "./journey";
import type {
  GuidedJourneyContext,
  GuidedJourneyService,
  GuidedJourneyState,
} from "./journey";
import { verifyGuidedMarker, type GuidedMarkerPurpose } from "./provenance";
import type { GuidedMenuIdentity } from "./ux-types";
import { GUIDED_MENU_COPY } from "./ux-types";

/**
 * Stages in which the produce round is proven saved and later steps may run.
 * `closed` is included on purpose: before it existed as its own stage these
 * rounds resolved to `reconcile`, which was already in this set, so keeping
 * it here preserves the exact same ownership/marker behavior — only the
 * journey-stage UX rendering changed, not what this guard allows through.
 */
const STAGES_AFTER_PRODUCE = new Set<GuidedJourneyState["stage"]>([
  "white_sheet",
  "slips",
  "reconcile",
  "closed",
]);

export type GuidedOwnershipVerdict =
  /** No guided round anywhere in this source for the market/date — legacy runs. */
  | { verdict: "not_guided" }
  /** The caller owns the round and it is past produce. */
  | { verdict: "allowed"; context: GuidedJourneyContext; state: GuidedJourneyState }
  /**
   * Refuse and write nothing. `reason: "stale_form"` marks specifically the
   * signed-marker-present-but-invalid case — a copied, edited, or
   * previous-generation template — so callers can offer the
   * "สร้างแบบฟอร์มใหม่" recovery action without string-matching `message`.
   */
  | { verdict: "refused"; message: string; reason?: "stale_form" };

export type GuidedOwnershipTarget = {
  marketLabelNormalized: string;
  businessDate: string;
};

export async function resolveGuidedOwnership(input: {
  journey: GuidedJourneyService;
  identity: GuidedMenuIdentity;
  target: GuidedOwnershipTarget;
  /** Which template this message claims to be. */
  purpose: GuidedMarkerPurpose;
  /** The signed marker the message carried, if any. */
  marker?: string | null;
}): Promise<GuidedOwnershipVerdict> {
  const target = {
    marketLabelNormalized: normalizedMarketLabel(
      input.target.marketLabelNormalized,
    ),
    businessDate: input.target.businessDate,
  };
  const marked = Boolean(input.marker);

  // ── 1. Source-wide ownership of the TARGET, before anything else ───────────
  let owner: Awaited<ReturnType<GuidedJourneyService["findRoundOwner"]>>;
  try {
    owner = await input.journey.findRoundOwner({
      sourceId: input.identity.sourceId,
      marketLabelNormalized: target.marketLabelNormalized,
      businessDate: target.businessDate,
    });
  } catch {
    owner = { kind: "unknown" };
  }
  if (owner.kind === "unknown") {
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.ownershipUnknown) };
  }
  if (owner.kind === "ambiguous") {
    // Two operators own a matching round. Nothing may pick one for them.
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.ownershipAmbiguous) };
  }
  if (owner.kind === "owned" && owner.lineUserId !== input.identity.lineUserId) {
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.ownershipOtherOperator),
    };
  }

  // ── 2. Nobody owns the target ─────────────────────────────────────────────
  if (owner.kind === "none") {
    if (!marked) {
      // A genuine legacy command. The caller's own unrelated round is not a
      // reason to block it — see the module comment.
      return { verdict: "not_guided" };
    }
    // A marker for a round that does not exist cannot be verified against
    // anything. It is our form, aimed somewhere it does not belong.
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.ownershipMarkerRejected),
      reason: "stale_form",
    };
  }

  // ── 3. The caller owns the target — their own journey decides the rest ─────
  let state: GuidedJourneyState;
  try {
    state = await input.journey.resolve(input.identity);
  } catch {
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.ownershipUnknown) };
  }

  if (state.stage === "idle") {
    // The source-wide query says this operator owns the round, yet their own
    // journey will not resolve. Never guess in that gap.
    if (
      state.reason === "ownership_conflict" ||
      state.reason === "session_key_mismatch"
    ) {
      return {
        verdict: "refused",
        message: refusal(GUIDED_MENU_COPY.ownershipOtherOperator),
      };
    }
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.ownershipUnknown) };
  }

  const context = state.context;
  if (
    context.marketLabelNormalized !== target.marketLabelNormalized ||
    context.businessDate !== target.businessDate
  ) {
    // They own the target round per the source-wide query, but the round their
    // own key resolves to is a different one — a rotated or second round.
    return { verdict: "refused", message: mismatchMessage(context) };
  }

  if (state.stage === "capture" || state.stage === "awaiting_confirm") {
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.ownershipProduceUnfinished),
    };
  }
  if (state.stage === "finalizing") {
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.produceFinalizing) };
  }
  if (state.stage === "finalize_failed") {
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.produceFinalizeFailedShort),
    };
  }
  if (!STAGES_AFTER_PRODUCE.has(state.stage)) {
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.ownershipProduceUnfinished),
    };
  }

  // ── 4. A marked message must be OUR form for THIS round ───────────────────
  if (
    marked &&
    !verifyGuidedMarker(input.marker, {
      purpose: input.purpose,
      sourceId: context.sourceId,
      lineUserId: input.identity.lineUserId,
      marketLabelNormalized: context.marketLabelNormalized,
      businessDate: context.businessDate,
      sessionGeneration: context.sessionGeneration,
    })
  ) {
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.ownershipMarkerRejected),
      reason: "stale_form",
    };
  }

  return { verdict: "allowed", context, state };
}

function refusal(reason: string): string {
  return [reason, "", GUIDED_MENU_COPY.ownershipNothingRecorded].join("\n");
}

function mismatchMessage(context: GuidedJourneyContext): string {
  const date = thaiDateFromIso(context.businessDate) ?? context.businessDate;
  return [
    GUIDED_MENU_COPY.ownershipRoundMismatch,
    `รอบที่เปิดอยู่: ${context.sellerLabel} — ${context.marketLabel} — ${date}`,
    GUIDED_MENU_COPY.ownershipUseTemplate,
    "",
    GUIDED_MENU_COPY.ownershipNothingRecorded,
  ].join("\n");
}
