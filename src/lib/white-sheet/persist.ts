import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { WhiteSheetExpenses } from "./types";

type Supabase = SupabaseClient<Database>;
type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

const TABLE = "digital_white_sheet_cash_entries" as const;
const OTHER_NOTE_MAX_LENGTH = 1000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  /** Exact economic cycle. Undefined preserves pre-P2E callers; null is legacy-unbound only. */
  accountabilityRoundId?: string | null;
}

/**
 * BR-06: lifecycle is a separate concept from financial result status
 * (matched/shortage/overage — computed in calculate.ts). NOT_SUBMITTED has
 * no row. SUBMITTED and FINALIZED both have real operator-entered data;
 * FINALIZED additionally records who finalized it and when, and blocks the
 * normal operator upsert path (see saveWhiteSheetCashEntry).
 */
export type WhiteSheetCashEntryState =
  | { status: "not_submitted" }
  | {
      status: "submitted";
      expenses: WhiteSheetExpenses;
      actualCashSubmitted: number;
      /**
       * Task 4 (Daily Financial Settlement) inputs. NULL (or the field being
       * absent entirely, for existing call sites constructed before Task 4)
       * means not yet entered — never substitute 0. See
       * src/lib/settlement/daily-financial-settlement.ts, which reports
       * INCOMPLETE rather than a false "ปิดตรง" when either is missing.
       * Optional rather than required so the many pre-existing White Sheet
       * tests that build this state by hand keep compiling unchanged;
       * loadWhiteSheetCashEntry (the only real producer) always sets both.
       */
      whiteSheetSales?: number | null;
      ownerCash?: number | null;
      updatedAt: string;
    }
  | {
      status: "finalized";
      expenses: WhiteSheetExpenses;
      actualCashSubmitted: number;
      whiteSheetSales?: number | null;
      ownerCash?: number | null;
      updatedAt: string;
      finalizedAt: string;
      finalizedBy: string;
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

function requireAccountabilityRoundId(value: string | null | undefined) {
  if (value == null) return value;
  if (!UUID_PATTERN.test(value)) {
    throw new WhiteSheetPersistenceError("accountabilityRoundId must be a UUID");
  }
  return value;
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

function toEntryState(row: CashEntryRow): WhiteSheetCashEntryState {
  const whiteSheetSales = row.white_sheet_sales === null ? null : Number(row.white_sheet_sales);
  const ownerCash = row.owner_cash === null ? null : Number(row.owner_cash);
  if (row.finalized_at) {
    return {
      status: "finalized",
      expenses: toExpenses(row),
      actualCashSubmitted: Number(row.actual_cash_submitted),
      whiteSheetSales,
      ownerCash,
      updatedAt: row.updated_at,
      finalizedAt: row.finalized_at,
      finalizedBy: row.finalized_by as string,
    };
  }
  return {
    status: "submitted",
    expenses: toExpenses(row),
    actualCashSubmitted: Number(row.actual_cash_submitted),
    whiteSheetSales,
    ownerCash,
    updatedAt: row.updated_at,
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
  const accountabilityRoundId = requireAccountabilityRoundId(rawIdentity.accountabilityRoundId);

  let query = supabase
    .from(TABLE)
    .select(
      "labor, location_fee, bag, snack, other, other_note, actual_cash_submitted, white_sheet_sales, owner_cash, updated_at, finalized_at, finalized_by",
    )
    .eq("source_id", sourceId)
    .eq("market_label_normalized", marketLabelNormalized)
    .eq("business_date", businessDate);
  if (accountabilityRoundId !== undefined) {
    query = accountabilityRoundId === null
      ? query.is("accountability_round_id", null)
      : query.eq("accountability_round_id", accountabilityRoundId);
  }
  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new WhiteSheetPersistenceError(`white sheet cash entry query failed: ${error.message}`);
  }
  if (!data) return { status: "not_submitted" };

  return toEntryState(data as CashEntryRow);
}

/**
 * Validates and upserts one White Sheet cash/expense entry, keyed on
 * (source_id, market_label_normalized, business_date). Last-write-wins for a
 * SUBMITTED entry — no audit history for ordinary corrections in Local MVP
 * (see task scope: deferred). BR-06: rejects the write outright if the
 * existing entry is FINALIZED — normal operator submission can never alter
 * finalized financial inputs; only an explicit privileged reopen can.
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
  const accountabilityRoundId = requireAccountabilityRoundId(rawInput.accountabilityRoundId);

  const labor = requireMoney(rawInput.labor, "labor");
  const locationFee = requireMoney(rawInput.locationFee, "locationFee");
  const bag = requireMoney(rawInput.bag, "bag");
  const snack = requireMoney(rawInput.snack, "snack");
  const other = requireMoney(rawInput.other, "other");
  const actualCashSubmitted = requireMoney(rawInput.actualCashSubmitted, "actualCashSubmitted");
  const otherNote = requireOtherNote(rawInput.otherNote);

  let existingQuery = supabase
    .from(TABLE)
    .select("id, finalized_at")
    .eq("source_id", sourceId)
    .eq("market_label_normalized", marketLabelNormalized)
    .eq("business_date", businessDate);
  if (accountabilityRoundId !== undefined) {
    existingQuery = accountabilityRoundId === null
      ? existingQuery.is("accountability_round_id", null)
      : existingQuery.eq("accountability_round_id", accountabilityRoundId);
  }
  const { data: existing, error: existingError } = await existingQuery.maybeSingle();

  if (existingError) {
    throw new WhiteSheetPersistenceError(`white sheet cash entry query failed: ${existingError.message}`);
  }

  const SELECT_COLUMNS =
    "labor, location_fee, bag, snack, other, other_note, actual_cash_submitted, white_sheet_sales, owner_cash, updated_at, finalized_at, finalized_by";
  const writeValues = {
    labor,
    location_fee: locationFee,
    bag,
    snack,
    other,
    other_note: otherNote,
    actual_cash_submitted: actualCashSubmitted,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    // Atomic guard: the UPDATE only matches while finalized_at is still NULL
    // at write time, so a finalize racing with a resubmission cannot both
    // succeed — one of them loses.
    const { data, error } = await supabase
      .from(TABLE)
      .update(writeValues)
      .eq("id", existing.id)
      .is("finalized_at", null)
      .select(SELECT_COLUMNS)
      .maybeSingle();

    if (error) {
      throw new WhiteSheetPersistenceError(`white sheet cash entry save failed: ${error.message}`);
    }
    if (!data) {
      throw new WhiteSheetPersistenceError(
        "this White Sheet entry is finalized and cannot be changed through normal submission — an admin must reopen it first",
      );
    }
    return toEntryState(data as CashEntryRow);
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      source_id: sourceId,
      market_label_normalized: marketLabelNormalized,
      business_date: businessDate,
      accountability_round_id: accountabilityRoundId ?? null,
      ...writeValues,
    })
    .select(SELECT_COLUMNS)
    .single();

  if (error) {
    throw new WhiteSheetPersistenceError(`white sheet cash entry save failed: ${error.message}`);
  }
  return toEntryState(data as CashEntryRow);
}

/**
 * BR-06: admin-only transition SUBMITTED -> FINALIZED. Callers must call
 * requireAdminActor() first (see src/lib/auth/admin.ts) and pass its actor
 * id. Requires a SUBMITTED entry to already exist — there is nothing to
 * finalize for NOT_SUBMITTED. Atomic via finalize_white_sheet_cash_entry(...):
 * guarded UPDATE + lifecycle audit INSERT in one database transaction.
 */
export async function finalizeWhiteSheetCashEntry(
  supabase: Supabase,
  rawIdentity: WhiteSheetCashEntryIdentity,
  actor: string,
): Promise<WhiteSheetCashEntryState> {
  const sourceId = requireIdentityField(rawIdentity.sourceId, "sourceId");
  const marketLabelNormalized = requireIdentityField(
    rawIdentity.marketLabelNormalized,
    "marketLabelNormalized",
  );
  const businessDate = requireBusinessDate(rawIdentity.businessDate);
  const accountabilityRoundId = requireAccountabilityRoundId(rawIdentity.accountabilityRoundId);
  const actorId = requireIdentityField(actor, "actor");

  const { data, error } = await supabase.rpc("finalize_white_sheet_cash_entry", {
    p_source_id: sourceId,
    p_market_label_normalized: marketLabelNormalized,
    p_business_date: businessDate,
    p_accountability_round_id: accountabilityRoundId ?? null,
    p_actor: actorId,
  });

  if (error) {
    throw new WhiteSheetPersistenceError(`finalize failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as CashEntryRow | null;
  if (!row) {
    throw new WhiteSheetPersistenceError(
      "no SUBMITTED White Sheet entry found for this identity, or it is already finalized",
    );
  }

  return toEntryState(row);
}

/**
 * BR-06/BR-05: explicit privileged reopen — the only way a FINALIZED entry
 * ever becomes editable again. Never a silent overwrite: requires a
 * non-empty reason and records an audit event. Callers must call
 * requireAdminActor() first. Atomic via reopen_white_sheet_cash_entry(...):
 * guarded UPDATE + lifecycle audit INSERT in one database transaction.
 */
export async function reopenWhiteSheetCashEntry(
  supabase: Supabase,
  rawIdentity: WhiteSheetCashEntryIdentity,
  actor: string,
  reason: string,
): Promise<WhiteSheetCashEntryState> {
  const sourceId = requireIdentityField(rawIdentity.sourceId, "sourceId");
  const marketLabelNormalized = requireIdentityField(
    rawIdentity.marketLabelNormalized,
    "marketLabelNormalized",
  );
  const businessDate = requireBusinessDate(rawIdentity.businessDate);
  const accountabilityRoundId = requireAccountabilityRoundId(rawIdentity.accountabilityRoundId);
  const actorId = requireIdentityField(actor, "actor");
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new WhiteSheetPersistenceError("reason is required to reopen a finalized entry");
  }

  const { data, error } = await supabase.rpc("reopen_white_sheet_cash_entry", {
    p_source_id: sourceId,
    p_market_label_normalized: marketLabelNormalized,
    p_business_date: businessDate,
    p_accountability_round_id: accountabilityRoundId ?? null,
    p_actor: actorId,
    p_reason: trimmedReason,
  });

  if (error) {
    throw new WhiteSheetPersistenceError(`reopen failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as CashEntryRow | null;
  if (!row) {
    throw new WhiteSheetPersistenceError("no FINALIZED White Sheet entry found for this identity");
  }

  return toEntryState(row);
}
