import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { WhiteSheetExpenses } from "./types";

type Supabase = SupabaseClient<Database>;
type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

const TABLE = "digital_white_sheet_cash_entries" as const;
const OTHER_NOTE_MAX_LENGTH = 1000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Stable classification for callers that need to branch on *why* a
 * persistence call failed without string-matching `error.message`.
 * - validation: bad caller input (identity/money/note), never reached the DB.
 * - finalized: the row is FINALIZED and permanently blocks normal upsert.
 * - stale_conflict: an optimistic-concurrency write lost to a concurrent
 *   canonical update (see saveWhiteSheetCashEntry's `expectedUpdatedAt`).
 * - infra: DB/query error, safe to retry.
 */
export type WhiteSheetPersistenceErrorCode =
  | "validation"
  | "finalized"
  | "stale_conflict"
  | "infra";

export class WhiteSheetPersistenceError extends Error {
  readonly code: WhiteSheetPersistenceErrorCode;

  constructor(message: string, code: WhiteSheetPersistenceErrorCode = "infra") {
    super(message);
    this.name = "WhiteSheetPersistenceError";
    this.code = code;
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
      updatedAt: string;
    }
  | {
      status: "finalized";
      expenses: WhiteSheetExpenses;
      actualCashSubmitted: number;
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
    throw new WhiteSheetPersistenceError(`${field} must not be empty`, "validation");
  }
  return normalized;
}

function requireBusinessDate(value: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE_PATTERN.test(trimmed)) {
    throw new WhiteSheetPersistenceError("businessDate must be an ISO date (YYYY-MM-DD)", "validation");
  }
  // Reject calendar-invalid dates like 2026-02-30 that still match the pattern.
  const [year, month, day] = trimmed.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!roundTrips) {
    throw new WhiteSheetPersistenceError(`businessDate is not a valid calendar date: ${trimmed}`, "validation");
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
      "validation",
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
      "validation",
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
  if (row.finalized_at) {
    return {
      status: "finalized",
      expenses: toExpenses(row),
      actualCashSubmitted: Number(row.actual_cash_submitted),
      updatedAt: row.updated_at,
      finalizedAt: row.finalized_at,
      finalizedBy: row.finalized_by as string,
    };
  }
  return {
    status: "submitted",
    expenses: toExpenses(row),
    actualCashSubmitted: Number(row.actual_cash_submitted),
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

  const { data, error } = await supabase
    .from(TABLE)
    .select(
      "labor, location_fee, bag, snack, other, other_note, actual_cash_submitted, updated_at, finalized_at, finalized_by",
    )
    .eq("source_id", sourceId)
    .eq("market_label_normalized", marketLabelNormalized)
    .eq("business_date", businessDate)
    .maybeSingle();

  if (error) {
    throw new WhiteSheetPersistenceError(`white sheet cash entry query failed: ${error.message}`, "infra");
  }
  if (!data) return { status: "not_submitted" };

  return toEntryState(data as CashEntryRow);
}

/**
 * Validates and upserts one White Sheet cash/expense entry, keyed on
 * (source_id, market_label_normalized, business_date). Last-write-wins for a
 * SUBMITTED entry by default — no audit history for ordinary corrections in
 * Local MVP (see task scope: deferred). BR-06: rejects the write outright if
 * the existing entry is FINALIZED — normal operator submission can never
 * alter finalized financial inputs; only an explicit privileged reopen can.
 *
 * `opts.expectedUpdatedAt`, when supplied, turns the update into an
 * optimistic-concurrency write: the UPDATE only matches a row whose
 * `updated_at` is still exactly that value. If the canonical entry changed
 * between the caller's read and this write (e.g. Backoffice edited it in
 * between), the write matches nothing and this throws a `stale_conflict`
 * error instead of silently overwriting — the caller reloads and retries.
 * Existing callers that omit it keep the prior non-conflict-checked
 * behavior unchanged.
 */
export async function saveWhiteSheetCashEntry(
  supabase: Supabase,
  rawInput: WhiteSheetCashEntryInput,
  opts?: { expectedUpdatedAt?: string },
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

  const { data: existing, error: existingError } = await supabase
    .from(TABLE)
    .select("id, finalized_at")
    .eq("source_id", sourceId)
    .eq("market_label_normalized", marketLabelNormalized)
    .eq("business_date", businessDate)
    .maybeSingle();

  if (existingError) {
    throw new WhiteSheetPersistenceError(
      `white sheet cash entry query failed: ${existingError.message}`,
      "infra",
    );
  }

  const SELECT_COLUMNS =
    "labor, location_fee, bag, snack, other, other_note, actual_cash_submitted, updated_at, finalized_at, finalized_by";
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
    // succeed — one of them loses. When expectedUpdatedAt is supplied, the
    // UPDATE additionally only matches the exact row version the caller read.
    const base = supabase.from(TABLE).update(writeValues).eq("id", existing.id).is("finalized_at", null);
    const query =
      opts?.expectedUpdatedAt !== undefined ? base.eq("updated_at", opts.expectedUpdatedAt) : base;
    const { data, error } = await query.select(SELECT_COLUMNS).maybeSingle();

    if (error) {
      throw new WhiteSheetPersistenceError(`white sheet cash entry save failed: ${error.message}`, "infra");
    }
    if (!data) {
      // Disambiguate why the guarded UPDATE matched nothing: finalized (BR-06
      // hard lock) vs. a concurrent canonical update since expectedUpdatedAt.
      const { data: current } = await supabase
        .from(TABLE)
        .select("finalized_at")
        .eq("id", existing.id)
        .maybeSingle();
      if (current?.finalized_at) {
        throw new WhiteSheetPersistenceError(
          "this White Sheet entry is finalized and cannot be changed through normal submission — an admin must reopen it first",
          "finalized",
        );
      }
      if (opts?.expectedUpdatedAt !== undefined) {
        throw new WhiteSheetPersistenceError(
          "this White Sheet entry was changed since it was last loaded — reload and retry",
          "stale_conflict",
        );
      }
      throw new WhiteSheetPersistenceError(
        "this White Sheet entry is finalized and cannot be changed through normal submission — an admin must reopen it first",
        "finalized",
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
      ...writeValues,
    })
    .select(SELECT_COLUMNS)
    .single();

  if (error) {
    throw new WhiteSheetPersistenceError(`white sheet cash entry save failed: ${error.message}`, "infra");
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
  const actorId = requireIdentityField(actor, "actor");

  const { data, error } = await supabase.rpc("finalize_white_sheet_cash_entry", {
    p_source_id: sourceId,
    p_market_label_normalized: marketLabelNormalized,
    p_business_date: businessDate,
    p_actor: actorId,
  });

  if (error) {
    throw new WhiteSheetPersistenceError(`finalize failed: ${error.message}`, "infra");
  }
  const row = (Array.isArray(data) ? data[0] : data) as CashEntryRow | null;
  if (!row) {
    throw new WhiteSheetPersistenceError(
      "no SUBMITTED White Sheet entry found for this identity, or it is already finalized",
      "validation",
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
  const actorId = requireIdentityField(actor, "actor");
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new WhiteSheetPersistenceError("reason is required to reopen a finalized entry", "validation");
  }

  const { data, error } = await supabase.rpc("reopen_white_sheet_cash_entry", {
    p_source_id: sourceId,
    p_market_label_normalized: marketLabelNormalized,
    p_business_date: businessDate,
    p_actor: actorId,
    p_reason: trimmedReason,
  });

  if (error) {
    throw new WhiteSheetPersistenceError(`reopen failed: ${error.message}`, "infra");
  }
  const row = (Array.isArray(data) ? data[0] : data) as CashEntryRow | null;
  if (!row) {
    throw new WhiteSheetPersistenceError(
      "no FINALIZED White Sheet entry found for this identity",
      "validation",
    );
  }

  return toEntryState(row);
}
