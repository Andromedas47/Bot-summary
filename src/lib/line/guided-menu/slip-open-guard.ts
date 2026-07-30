/**
 * Pre-write guard for the transfer-slip batch header the guided flow hands out.
 *
 * The header is plain text, so it can be edited or copied by anyone in the
 * group, and the legacy open path would happily create a `slip_batches` row for
 * whatever seller/market/date it read — after which images attach to that batch.
 * This runs BEFORE the open and refuses anything that does not match the round
 * it belongs to, so no row is ever created for the wrong round.
 *
 * It opens nothing itself: on `allowed` the existing `SlipSessionService`
 * performs exactly the open it always did, and unrelated image routing is
 * untouched.
 */

import { normalizedMarketLabel } from "@/lib/market";
import { parseBusinessDate } from "@/lib/line/white-sheet-close-command";
import type { SlipSessionHeader } from "@/lib/slips/slip-session-service";
import { resolveGuidedOwnership } from "./ownership-guard";
import type { GuidedJourneyContext, GuidedJourneyService } from "./journey";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity } from "./ux-types";

/** The catalog question the guard asks; satisfied by GuidedMenuStateService. */
export interface GuidedSellerMarketCatalog {
  isActiveSellerMarket(input: {
    sellerLabel: string;
    marketLabelNormalized: string;
  }): Promise<boolean>;
}

export type GuidedSlipOpenGuard =
  /** No guided round owns this market/date — the legacy open runs unchanged. */
  | { verdict: "not_guided" }
  | { verdict: "allowed"; context: GuidedJourneyContext }
  /** Refuse before the open — zero rows. */
  | { verdict: "refused"; message: string };

export async function guardGuidedSlipOpen(input: {
  journey: GuidedJourneyService;
  catalog: GuidedSellerMarketCatalog;
  identity: GuidedMenuIdentity;
  header: SlipSessionHeader;
}): Promise<GuidedSlipOpenGuard> {
  const marketLabelNormalized = normalizedMarketLabel(input.header.marketName);
  const businessDate = input.header.slipDate
    ? parseBusinessDate(input.header.slipDate)
    : null;

  // An undated or unreadable header can never be matched to a round. It is only
  // the guided flow's business if someone in this source owns a round at all,
  // which cannot be determined without a date — so leave it to the legacy path,
  // exactly as before this guard existed.
  if (!marketLabelNormalized || !businessDate) return { verdict: "not_guided" };

  const ownership = await resolveGuidedOwnership({
    journey: input.journey,
    identity: input.identity,
    target: { marketLabelNormalized, businessDate },
  });
  if (ownership.verdict !== "allowed") return ownership;

  const { context, state } = ownership;

  // Slips come after the White Sheet: `white_sheet` means it is still missing.
  if (state.stage === "white_sheet") {
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.slipOpenWhiteSheetMissing),
    };
  }

  // The seller is not part of the ownership question — it is part of the round.
  // An edited seller must not open a batch under the round's identity.
  if (normalizeName(input.header.sellerName) !== normalizeName(context.sellerLabel)) {
    return { verdict: "refused", message: mismatch(context) };
  }

  // The assignment must still be live now, not merely when the round opened.
  let assigned: boolean;
  try {
    assigned = await input.catalog.isActiveSellerMarket({
      sellerLabel: context.sellerLabel,
      marketLabelNormalized: context.marketLabelNormalized,
    });
  } catch {
    return { verdict: "refused", message: refusal(GUIDED_MENU_COPY.ownershipUnknown) };
  }
  if (!assigned) {
    return {
      verdict: "refused",
      message: refusal(GUIDED_MENU_COPY.slipOpenAssignmentRevoked),
    };
  }

  return { verdict: "allowed", context };
}

function normalizeName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function refusal(reason: string): string {
  return [reason, "", GUIDED_MENU_COPY.ownershipNothingRecorded].join("\n");
}

function mismatch(context: GuidedJourneyContext): string {
  return refusal(
    [
      GUIDED_MENU_COPY.ownershipRoundMismatch,
      `รอบที่เปิดอยู่: ${context.sellerLabel} — ${context.marketLabel}`,
      GUIDED_MENU_COPY.ownershipUseTemplate,
    ].join("\n"),
  );
}
