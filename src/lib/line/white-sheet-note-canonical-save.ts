import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  loadWhiteSheetCashEntry,
  saveWhiteSheetCashEntry,
  type WhiteSheetCashEntryState,
} from "@/lib/white-sheet/persist";
import type { ManualWhiteSheetNoteSessionRow } from "@/lib/line/white-sheet-note-session-service";

type Supabase = SupabaseClient<Database>;

/**
 * Saves a closed LINE White Sheet note session into the existing canonical
 * digital_white_sheet_cash_entries table, keyed on source_id + normalized
 * market label + business date. Only wraps the existing low-level
 * load/save helpers — no produce/slip/settlement calculation, no table
 * contract or money-field mapping duplicated here.
 *
 * A field the operator never entered this session (null on the session row)
 * falls back to whatever is already stored for this identity, so closing a
 * session that only touched one field never zeroes out fields someone else
 * already submitted; a brand-new identity defaults omitted fields to 0.
 * Rejects (via saveWhiteSheetCashEntry, which throws WhiteSheetPersistenceError)
 * when the existing row is FINALIZED.
 */
export async function saveManualWhiteSheetEntryFromLine(
  supabase: Supabase,
  session: ManualWhiteSheetNoteSessionRow,
): Promise<WhiteSheetCashEntryState> {
  const identity = {
    sourceId: session.source_id,
    marketLabelNormalized: session.market_label_normalized,
    businessDate: session.business_date,
  };

  const existing = await loadWhiteSheetCashEntry(supabase, identity);
  const existingExpenses = existing.status !== "not_submitted" ? existing.expenses : null;
  const existingCash = existing.status !== "not_submitted" ? existing.actualCashSubmitted : null;

  return saveWhiteSheetCashEntry(supabase, {
    ...identity,
    labor: session.labor ?? existingExpenses?.labor ?? 0,
    locationFee: session.location_fee ?? existingExpenses?.locationFee ?? 0,
    bag: session.bag ?? existingExpenses?.bag ?? 0,
    snack: session.snack ?? existingExpenses?.snack ?? 0,
    other: session.other_amount ?? existingExpenses?.other ?? 0,
    otherNote: session.other_amount !== null ? session.other_note : (existingExpenses?.otherNote ?? null),
    actualCashSubmitted: session.actual_cash ?? existingCash ?? 0,
  });
}
