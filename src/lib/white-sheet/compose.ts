import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  loadDigitalWhiteSheetSummary,
  normalizedMarketLabel,
  type DigitalWhiteSheetScope,
} from "./load";
import { loadWhiteSheetCashEntry, type WhiteSheetCashEntryState } from "./persist";
import type { DigitalWhiteSheetSummary, WhiteSheetExpenses } from "./types";
import { hasHardStopWarning } from "./warnings";

type Supabase = SupabaseClient<Database>;

const ZERO_EXPENSES: WhiteSheetExpenses = {
  labor: 0,
  locationFee: 0,
  bag: 0,
  snack: 0,
  other: 0,
};

export interface DigitalWhiteSheetPageModel {
  entryStatus: WhiteSheetCashEntryState["status"];
  summary: DigitalWhiteSheetSummary;
}

export class WhiteSheetNotSubmittedError extends Error {
  constructor() {
    super("White Sheet cash entry has not been submitted for this source/market/date");
    this.name = "WhiteSheetNotSubmittedError";
  }
}

export class WhiteSheetHardStopError extends Error {
  constructor() {
    super(
      "White Sheet financial result is not trustworthy: multiple completed main produce " +
        "sessions exist for this source/market/date (see warnings)",
    );
    this.name = "WhiteSheetHardStopError";
  }
}

/**
 * Combines the operational loader, the persisted expense/cash entry, and
 * calculateDigitalWhiteSheet into one page model — the only place these
 * three are wired together. React components must not calculate financial
 * totals themselves; they only render this model.
 *
 * When no entry has been submitted yet, `summary.expenses`, `expenseTotal`,
 * `expectedCash`, `actualCashSubmitted`, `difference`, and `status` are
 * computed from a zero placeholder purely so the entry-independent fields
 * (`expectedSales`, `verifiedTransfers`, `warnings`) can still be shown.
 * Callers MUST check `entryStatus` and hide those cash-derived fields
 * — never render them as a genuine $0 submission — when it is
 * "not_submitted" (see DigitalWhiteSheetSummary component and STEP 6/11 of
 * the White Sheet local persistence task). Use
 * requireSubmittedWhiteSheetSummary before anything (LINE push, finalization)
 * that assumes a real submitted entry.
 */
export async function loadDigitalWhiteSheetPageModel(
  supabase: Supabase,
  scope: DigitalWhiteSheetScope,
): Promise<DigitalWhiteSheetPageModel> {
  const marketLabelNormalized = normalizedMarketLabel(scope.marketLabel);
  const entry = await loadWhiteSheetCashEntry(supabase, {
    sourceId: scope.sourceId,
    marketLabelNormalized,
    businessDate: scope.businessDate,
  });

  const cashInput = entry.status === "submitted"
    ? { expenses: entry.expenses, actualCashSubmitted: entry.actualCashSubmitted }
    : { expenses: ZERO_EXPENSES, actualCashSubmitted: 0 };

  const summary = await loadDigitalWhiteSheetSummary(supabase, scope, cashInput);

  return { entryStatus: entry.status, summary };
}

/**
 * Structural guard for any downstream use (LINE push, PDF, finalization)
 * that must never run against a placeholder not-submitted summary.
 */
export function requireSubmittedWhiteSheetSummary(
  pageModel: DigitalWhiteSheetPageModel,
): DigitalWhiteSheetSummary {
  if (pageModel.entryStatus !== "submitted") {
    throw new WhiteSheetNotSubmittedError();
  }
  return pageModel.summary;
}

/**
 * Stricter guard for anything that must not run against an untrustworthy
 * result at all — LINE push, finalization, PDF export. Requires both a
 * submitted cash entry AND the absence of the multiple-main-session HARD
 * STOP warning (see src/lib/white-sheet/warnings.ts). Duplicate sessions
 * are never auto-resolved here; the caller must surface this error and let
 * an operator investigate.
 */
export function requireTrustedWhiteSheetSummary(
  pageModel: DigitalWhiteSheetPageModel,
): DigitalWhiteSheetSummary {
  const summary = requireSubmittedWhiteSheetSummary(pageModel);
  if (hasHardStopWarning(summary.warnings)) {
    throw new WhiteSheetHardStopError();
  }
  return summary;
}
