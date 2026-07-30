/**
 * Source-wide ownership for the two legacy writers a guided operator is handed
 * a template for: the White Sheet closing command and the transfer-slip batch
 * header.
 *
 * Both templates are plain text in a shared LINE group, so any member can copy
 * one. The journey key is per operator, which means a second member resolves
 * `idle` — and `idle` used to mean "not guided, let the legacy path run". That
 * let operator B file operator A's round.
 *
 * This module answers the source-wide question instead: does anyone own the
 * guided round for this market and business date? Legacy fallback survives only
 * when the answer is nobody. Nothing here writes, parses money or duplicates a
 * lifecycle rule; it decides one thing, and it fails closed.
 */

import { normalizedMarketLabel } from "@/lib/market";
import { thaiDateFromIso } from "./journey";
import type {
  GuidedJourneyContext,
  GuidedJourneyService,
  GuidedJourneyState,
} from "./journey";
import type { GuidedMenuIdentity } from "./ux-types";
import { GUIDED_MENU_COPY } from "./ux-types";

/** Stages in which the produce round is proven saved and later steps may run. */
const STAGES_AFTER_PRODUCE = new Set<GuidedJourneyState["stage"]>([
  "white_sheet",
  "slips",
  "reconcile",
]);

export type GuidedOwnershipVerdict =
  /** No guided round anywhere in this source for the market/date — legacy runs. */
  | { verdict: "not_guided" }
  /** The caller owns the round and it is past produce. */
  | { verdict: "allowed"; context: GuidedJourneyContext; state: GuidedJourneyState }
  /** Refuse and write nothing. */
  | { verdict: "refused"; message: string };

export type GuidedOwnershipTarget = {
  marketLabelNormalized: string;
  businessDate: string;
};

/**
 * Resolve the caller's own journey, then — only if they have none — ask whether
 * someone else owns the round for the submitted market/date.
 *
 * A transient lookup failure refuses. Degrading to `not_guided` would silently
 * widen the legacy path exactly when the ownership question cannot be answered,
 * which is how finding #2 happened.
 */
export async function resolveGuidedOwnership(input: {
  journey: GuidedJourneyService;
  identity: GuidedMenuIdentity;
  target: GuidedOwnershipTarget;
}): Promise<GuidedOwnershipVerdict> {
  const target = {
    marketLabelNormalized: normalizedMarketLabel(
      input.target.marketLabelNormalized,
    ),
    businessDate: input.target.businessDate,
  };

  let state: GuidedJourneyState;
  try {
    state = await input.journey.resolve(input.identity);
  } catch {
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.ownershipUnknown) };
  }

  if (state.stage !== "idle") {
    const context = state.context;
    const matches =
      context.marketLabelNormalized === target.marketLabelNormalized &&
      context.businessDate === target.businessDate;

    if (!matches) {
      // The caller's own round is for another market/date. Their submission is
      // wrong regardless of who owns the target round.
      return { verdict: "refused", message: mismatchMessage(context) };
    }
    if (state.stage === "capture" || state.stage === "awaiting_confirm") {
      return {
        verdict: "refused",
        message: refusal(GUIDED_MENU_COPY.ownershipProduceUnfinished),
      };
    }
    if (state.stage === "finalizing") {
      return {
        verdict: "refused",
        message: refusal(GUIDED_MENU_COPY.produceFinalizing),
      };
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
    return { verdict: "allowed", context, state };
  }

  // The caller has no round of their own. An identity conflict is never
  // "not guided" — it is a stranger reaching for someone else's round.
  if (
    state.reason === "ownership_conflict" ||
    state.reason === "session_key_mismatch"
  ) {
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.ownershipOtherOperator) };
  }
  if (state.reason === "lookup_failed") {
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.ownershipUnknown) };
  }

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
  if (owner.kind === "owned" && owner.lineUserId !== input.identity.lineUserId) {
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.ownershipOtherOperator),
    };
  }
  // Nobody owns this market/date in this source — the pre-existing direct
  // command is untouched.
  return { verdict: "not_guided" };
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
