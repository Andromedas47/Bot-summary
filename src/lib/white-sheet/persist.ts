import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { WhiteSheetExpenses } from "./types";

type Supabase = SupabaseClient<Database>;
type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

const TABLE = "digital_white_sheet_cash_entries" as const;
const OTHER_NOTE_MAX_LENGTH = 1000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class WhiteSheetPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhiteSheetPersistenceError";
  }
}

/**
 * The Local-MVP identity for one White Sheet cash/expense entry. Deliberately
 * NOT the caller-supplied marketKey — see docs/core-white-sheet-integration.md
 * "Market identity before persistence". marketLabelNormalized must already be
 * the same normalized label the calculation loader uses (displayMarketName +
 * NFC + trim), so callers should derive it the same way as load.ts does
 * (see normalizeMarketLabelForPersistence below).
 */
export interface WhiteSheetCashEntryIdentity {
  sourceId: string;
  marketLabelNormalized: string;
  businessDate: string;
}

export type WhiteSheetCashEntryState =
  | { status: "not_submitted" }
  | {
      status: "submitted";
      expenses: WhiteSheetExpenses;
      actualCashSubmitted: number;
      updatedAt: string;
    };

export interface WhiteSheetCashEntryInput extends WhiteSheetCashEntryIdentity {
  labor: number;
  locationFee: number;
  bag: number;
  snack: number;
  other: number;
  otherNote?: string | null;
  actualCashSubmitted: number;
}

function requireIdentityField(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) {
    throw new WhiteSheetPersistenceError(`${field} must not be empty`);
  }
  return normalized;
}

function requireBusinessDate(value: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE_PATTERN.test(trimmed)) {
    throw new WhiteSheetPersistenceError("businessDate must be an ISO date (YYYY-MM-DD)");
  }
  // Reject calendar-invalid dates like 2026-02-30 that still match the pattern.
  const [year, month, day] = trimmed.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!roundTrips) {
    throw new WhiteSheetPersistenceError(`businessDate is not a valid calendar date: ${trimmed}`);
  }
  return trimmed;
}

/** True only for a finite, non-negative amount with at most 2 decimal places. */
function isValidMoney(value: number): boolean {
  if (!Number.isFinite(value) || value < 0) return false;
  const cents = value * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6;
}

function requireMoney(value: number, field: string): number {
  if (!isValidMoney(value)) {
    throw new WhiteSheetPersistenceError(
      `${field} must be a finite non-negative number with at most 2 decimal places`,
    );
  }
  // Normalize -0 and float noise (e.g. 19.999999999999996) to a clean cent value.
  return Math.round(value * 100) / 100;
}

function requireOtherNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length > OTHER_NOTE_MAX_LENGTH) {
    throw new WhiteSheetPersistenceError(
      `otherNote must be at most ${OTHER_NOTE_MAX_LENGTH} characters`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toExpenses(row: CashEntryRow): WhiteSheetExpenses {
  return {
    labor: Number(row.labor),
    locationFee: Number(row.location_fee),
    bag: Number(row.bag),
    snack: Number(row.snack),
    other: Number(row.other),
    ...(row.other_note ? { otherNote: row.other_note } : {}),
  };
}

/**
 * Reads the operator-entered White Sheet cash/expense entry for one
 * source/market/business-date identity. A missing row is reported as
 * `{ status: "not_submitted" }` — callers must never substitute zeroed
 * expenses/cash for that state.
 */
export async function loadWhiteSheetCashEntry(
  supabase: Supabase,
  rawIdentity: WhiteSheetCashEntryIdentity,
): Promise<WhiteSheetCashEntryState> {
  const sourceId = requireIdentityField(rawIdentity.sourceId, "sourceId");
  const marketLabelNormalized = requireIdentityField(
    rawIdentity.marketLabelNormalized,
    "marketLabelNormalized",
  );
  const businessDate = requireBusinessDate(rawIdentity.businessDate);

  const { data, error } = await supabase
    .from(TABLE)
    .select("labor, location_fee, bag, snack, other, other_note, actual_cash_submitted, updated_at")
    .eq("source_id", sourceId)
    .eq("market_label_normalized", marketLabelNormalized)
    .eq("business_date", businessDate)
    .maybeSingle();

  if (error) {
    throw new WhiteSheetPersistenceError(`white sheet cash entry query failed: ${error.message}`);
  }
  if (!data) return { status: "not_submitted" };

  const row = data as CashEntryRow;
  return {
    status: "submitted",
    expenses: toExpenses(row),
    actualCashSubmitted: Number(row.actual_cash_submitted),
    updatedAt: row.updated_at,
  };
}

/**
 * Validates and upserts one White Sheet cash/expense entry, keyed on
 * (source_id, market_label_normalized, business_date). Last-write-wins —
 * no audit history in Local MVP (see task scope: deferred).
 */
export async function saveWhiteSheetCashEntry(
  supabase: Supabase,
  rawInput: WhiteSheetCashEntryInput,
): Promise<WhiteSheetCashEntryState> {
  const sourceId = requireIdentityField(rawInput.sourceId, "sourceId");
  const marketLabelNormalized = requireIdentityField(
    rawInput.marketLabelNormalized,
    "marketLabelNormalized",
  );
  const businessDate = requireBusinessDate(rawInput.businessDate);

  const labor = requireMoney(rawInput.labor, "labor");
  const locationFee = requireMoney(rawInput.locationFee, "locationFee");
  const bag = requireMoney(rawInput.bag, "bag");
  const snack = requireMoney(rawInput.snack, "snack");
  const other = requireMoney(rawInput.other, "other");
  const actualCashSubmitted = requireMoney(rawInput.actualCashSubmitted, "actualCashSubmitted");
  const otherNote = requireOtherNote(rawInput.otherNote);

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(
      {
        source_id: sourceId,
        market_label_normalized: marketLabelNormalized,
        business_date: businessDate,
        labor,
        location_fee: locationFee,
        bag,
        snack,
        other,
        other_note: otherNote,
        actual_cash_submitted: actualCashSubmitted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_id,market_label_normalized,business_date" },
    )
    .select("labor, location_fee, bag, snack, other, other_note, actual_cash_submitted, updated_at")
    .single();

  if (error) {
    throw new WhiteSheetPersistenceError(`white sheet cash entry save failed: ${error.message}`);
  }

  const row = data as CashEntryRow;
  return {
    status: "submitted",
    expenses: toExpenses(row),
    actualCashSubmitted: Number(row.actual_cash_submitted),
    updatedAt: row.updated_at,
  };
}
