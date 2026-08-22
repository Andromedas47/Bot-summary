/**
 * P4A — the produce entry validation gate, wired to the database.
 *
 * Reads the round's finalized produce rows, runs the pure gate against the
 * session being closed, and owns the review/override audit. Every read is
 * fail-closed: a master that could not be loaded raises, because validating a
 * return against an empty master would silently declare everything unknown —
 * or, worse, silently declare everything fine.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import {
  validateProduceEntry,
  type ProduceValidationResult,
  type RoundMasterRow,
} from "./entry-validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/**
 * A round is one market-day of one seller; a few hundred rows at the outside.
 * Hitting this ceiling means the assumption is wrong, and a truncated master
 * is a wrong master, so it raises instead of validating against a slice.
 */
const MASTER_ROW_LIMIT = 2000;

/** Session identity the gate needs. Never a descriptive tuple. */
export interface ProduceValidationSessionRef {
  sessionKey: string;
  /**
   * The pending generation, as the uuid every generation-scoped table in this
   * schema uses. It stays a string end to end and is never mapped, hashed or
   * numbered — the audit row records the real generation or it audits nothing.
   */
  sessionGeneration: string;
  /** NULL is a legacy/unbound session; the round master is then unavailable. */
  accountabilityRoundId: string | null;
  businessDate: string | null;
  marketLabel: string | null;
  /** The seller the round belongs to — not the person typing. */
  staffLabel: string | null;
  /** The LINE data-entry actor. */
  lineUserId: string | null;
}

export interface ProduceGateEvaluation {
  result: ProduceValidationResult;
  /** True when this exact exception set already carries an explicit confirmation. */
  reviewConfirmed: boolean;
}

export class ProduceValidationGateError extends Error {}

export interface RecordedProduceReview {
  /** True when this exception set already carried an explicit confirmation. */
  confirmed: boolean;
  /**
   * The event that first presented this exception set. A later press carrying
   * a different event id is a genuine second press; the same id is a duplicate
   * delivery of the first one and must not be read as an acknowledgement.
   */
  presentedLineEventId: string;
}

/**
 * The round's finalized produce rows.
 *
 * `produce_transactions` already excludes voided sessions (0037), so a
 * replaced session stops contributing to the master the moment it is voided —
 * which is exactly what revalidation before finalization needs.
 */
export async function loadRoundMasterRows(
  supabase: AnyClient,
  accountabilityRoundId: string,
): Promise<RoundMasterRow[]> {
  const { data, error } = await supabase
    .from("produce_transactions")
    .select("product_name, unit, quantity, price_per_unit, transaction_type")
    .eq("accountability_round_id", accountabilityRoundId)
    .limit(MASTER_ROW_LIMIT);

  if (error) {
    throw new ProduceValidationGateError(
      `round withdrawal master could not be read: ${error.message}`,
    );
  }
  const rows = (data ?? []) as RoundMasterRow[];
  if (rows.length >= MASTER_ROW_LIMIT) {
    throw new ProduceValidationGateError(
      "round withdrawal master exceeded the readable row limit",
    );
  }
  return rows;
}

/**
 * Validate a session against its own round, and report whether the resulting
 * review set is already confirmed. Nothing is written here.
 */
export async function evaluateProduceEntryGate(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  parsed: WeighSession,
): Promise<ProduceGateEvaluation> {
  const roundRows = ref.accountabilityRoundId
    ? await loadRoundMasterRows(supabase, ref.accountabilityRoundId)
    : [];

  const result = validateProduceEntry({
    parsed,
    roundRows,
    roundBound: ref.accountabilityRoundId !== null,
  });

  if (result.reviews.length === 0) {
    return { result, reviewConfirmed: false };
  }
  return { result, reviewConfirmed: await isReviewConfirmed(supabase, ref, result.digest) };
}

async function isReviewConfirmed(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  digest: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("produce_entry_validation_reviews")
    .select("confirmed_at")
    .eq("session_key", ref.sessionKey)
    .eq("session_generation", ref.sessionGeneration)
    .eq("validation_digest", digest)
    .maybeSingle();

  if (error) {
    throw new ProduceValidationGateError(
      `validation review lookup failed: ${error.message}`,
    );
  }
  return Boolean(data?.confirmed_at);
}

/**
 * Persist the exception set that is about to be shown to the operator.
 *
 * Idempotent on (session, generation, digest): a duplicate LINE delivery of the
 * same close records nothing new and never resets an existing confirmation.
 */
export async function recordProduceValidationReview(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  result: ProduceValidationResult,
  lineEventId: string,
): Promise<RecordedProduceReview> {
  if (result.reviews.length === 0) {
    throw new ProduceValidationGateError("no validation review to record");
  }
  if (!ref.lineUserId) {
    throw new ProduceValidationGateError(
      "validation review requires the data-entry LINE actor",
    );
  }

  const { data, error } = await supabase.rpc("record_produce_validation_review", {
    p_session_key: ref.sessionKey,
    p_session_generation: ref.sessionGeneration,
    p_accountability_round_id: ref.accountabilityRoundId,
    p_validation_digest: result.digest,
    p_business_date: ref.businessDate,
    p_market_label: ref.marketLabel,
    p_staff_label: ref.staffLabel,
    p_exceptions: result.reviews,
    p_line_user_id: ref.lineUserId,
    p_line_event_id: lineEventId,
  });

  if (error) {
    throw new ProduceValidationGateError(
      `validation review could not be recorded: ${error.message}`,
    );
  }
  const row = (data ?? {}) as {
    confirmed?: boolean;
    presented_line_event_id?: string | null;
    reason?: string;
    recorded?: boolean;
  };
  if (row.reason === "terminalized") {
    throw new ProduceValidationGateError("generation is terminalized");
  }
  return {
    confirmed: Boolean(row.confirmed),
    presentedLineEventId: row.presented_line_event_id ?? lineEventId,
  };
}

export type ProduceCloseGateDecision =
  /** Nothing stands in the way of creating the close boundary. */
  | { decision: "proceed"; result: ProduceValidationResult }
  /** Impossible or unidentifiable data. Never confirmable — it has to be corrected. */
  | { decision: "blocked"; result: ProduceValidationResult }
  /** Confirmable review exceptions await a second, explicit press. */
  | { decision: "review_presented"; result: ProduceValidationResult };

/**
 * The gate as it runs on "จบรายการ".
 *
 * No close boundary exists yet at this point, which is the whole reason the
 * gate lives here: a refusal leaves the round in capture, where a corrected
 * line is still an ordinary item message. Confirmable reviews use two presses
 * of the same button — the first shows the exceptions and records them, the
 * second (a different LINE event, so a duplicate delivery can never stand in
 * for it) acknowledges exactly the exception set that was shown.
 */
export async function runProduceCloseGate(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  parsed: WeighSession,
  lineEventId: string,
): Promise<ProduceCloseGateDecision> {
  const { result, reviewConfirmed } = await evaluateProduceEntryGate(supabase, ref, parsed);
  if (result.status === "blocked") return { decision: "blocked", result };
  if (result.status === "clean" || reviewConfirmed) return { decision: "proceed", result };

  const recorded = await recordProduceValidationReview(supabase, ref, result, lineEventId);
  if (recorded.confirmed) return { decision: "proceed", result };
  if (recorded.presentedLineEventId === lineEventId) {
    return { decision: "review_presented", result };
  }

  const confirmation = await confirmProduceValidationReview(
    supabase,
    ref,
    result.digest,
    lineEventId,
  );
  if (confirmation === "terminalized" || confirmation === "not_found") {
    return { decision: "review_presented", result };
  }
  return { decision: "proceed", result };
}

/**
 * The gate as it runs on every step after the close boundary exists — the
 * confirm press and the deferred finalizer.
 *
 * Read-only and unforgiving: it never presents and never confirms. Master data
 * can change under a closed round (a voided withdrawal, a later additional
 * batch), so the verdict is recomputed from live data every time and an
 * approval that no longer matches the data is simply not an approval.
 */
export async function runProduceFinalizeGate(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  parsed: WeighSession,
): Promise<ProduceCloseGateDecision> {
  const { result, reviewConfirmed } = await evaluateProduceEntryGate(supabase, ref, parsed);
  if (result.status === "blocked") return { decision: "blocked", result };
  if (result.status === "clean" || reviewConfirmed) return { decision: "proceed", result };
  return { decision: "review_presented", result };
}

export type ProduceReviewConfirmation =
  | "confirmed"
  | "already_confirmed"
  | "not_found"
  | "terminalized";

/**
 * Acknowledge the exception set identified by `digest`.
 *
 * `not_found` means the digest on the button no longer describes the session —
 * a stale press, or a straggler that changed the document after the preview.
 * The caller re-presents; it must never treat that as an approval.
 */
export async function confirmProduceValidationReview(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  digest: string,
  lineEventId: string,
): Promise<ProduceReviewConfirmation> {
  if (!ref.lineUserId) {
    throw new ProduceValidationGateError(
      "validation confirmation requires the data-entry LINE actor",
    );
  }
  const { data, error } = await supabase.rpc("confirm_produce_validation_review", {
    p_session_key: ref.sessionKey,
    p_session_generation: ref.sessionGeneration,
    p_validation_digest: digest,
    p_line_user_id: ref.lineUserId,
    p_line_event_id: lineEventId,
  });

  if (error) {
    throw new ProduceValidationGateError(
      `validation confirmation failed: ${error.message}`,
    );
  }
  const status = (data as { status?: string } | null)?.status;
  if (
    status === "confirmed"
    || status === "already_confirmed"
    || status === "not_found"
    || status === "terminalized"
  ) {
    return status;
  }
  throw new ProduceValidationGateError("validation confirmation returned an unknown status");
}
