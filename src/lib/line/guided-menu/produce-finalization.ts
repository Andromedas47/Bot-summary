/**
 * Whether the produce rows of a guided round actually exist.
 *
 * Releasing the 0050 hold (`confirm_produce_structured_finalization`) is a
 * CONTROL event: it proves the transport barrier was satisfied, not that
 * `try_finalize_pending_generation` went on to write produce rows. The deferred
 * finalizer can still terminalize the round as `failed_closed` — a validation
 * failure, missing items, an unconfirmed close — in which case nothing was
 * saved and the operator must not be sent on to the White Sheet.
 *
 * `pending_sessions.finalization_status` is the NECESSARY condition, and this
 * module is the one place that decides what counts as success:
 *
 *   finalized   the finalizer reports a produce session was written
 *   duplicate   the finalizer collapsed this attempt onto an existing session
 *
 * Neither status is SUFFICIENT on its own. 0050 reaches `duplicate` by two
 * different routes: an `ingest_idempotency_key` replay of this very generation
 * (rows exist under our identity) and a content-hash match against an earlier
 * generation (rows exist, but not necessarily for the generation the operator is
 * standing in). A content-hash duplicate is not proof that THIS round was saved.
 *
 * So success additionally requires an authoritative `produce_sessions` row whose
 * `ingest_idempotency_key` equals `<session_key>:<session_generation>` —
 * derived by `produceIngestIdempotencyKey`, the same helper the finalizer writes
 * with. Nothing is inferred from a content hash.
 *
 * Everything else is either still running or a failure. An unrecognised status
 * is never treated as success: on a terminalized row it fails closed, and on a
 * live row it reads as still pending.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PendingSession } from "@/lib/line/pending-session-service";
import { produceIngestIdempotencyKey } from "@/lib/line/produce-session-commands";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/**
 * Statuses that MAY prove produce rows exist. Each still has to be backed by a
 * current-generation produce_sessions row — see resolveGuidedProduceFinalization.
 */
export const SUCCESSFUL_PRODUCE_FINALIZATION_STATUSES = [
  "finalized",
  "duplicate",
] as const;

export type GuidedProduceFinalization =
  /** Hold released, deferred finalizer has not reported yet. */
  | "pending"
  /** Produce rows exist. */
  | "succeeded"
  /** Terminal, and not a successful status — nothing was saved. */
  | "failed";

/** True once the operator has released the hold, or the row already ended. */
export function guidedProduceHandedToFinalizer(
  row: Pick<PendingSession, "finalize_confirmed_at" | "terminalized">,
): boolean {
  return row.finalize_confirmed_at != null || row.terminalized === true;
}

/**
 * Status-only classification. A "succeeded" here is a CANDIDATE, not a proof:
 * only resolveGuidedProduceFinalization may conclude that rows exist.
 */
export function classifyGuidedProduceFinalization(
  row: Pick<PendingSession, "finalization_status" | "terminalized">,
): GuidedProduceFinalization {
  const status = row.finalization_status ?? null;
  if (
    status !== null &&
    (SUCCESSFUL_PRODUCE_FINALIZATION_STATUSES as readonly string[]).includes(
      status,
    )
  ) {
    return "succeeded";
  }
  if (status === "failed_closed") return "failed";
  // pending / processing / an unknown status (e.g. a future
  // `validation_failed`): still running while the row is live, but a
  // terminalized row that did not reach a successful status never will.
  return row.terminalized === true ? "failed" : "pending";
}

/** The pending-session fields the proof needs; every guided caller has them. */
export type GuidedProduceIdentityRow = Pick<
  PendingSession,
  "finalization_status" | "terminalized" | "session_key" | "session_generation"
>;

/**
 * Does the round the operator is standing in actually have produce rows?
 *
 * Two conditions, both required:
 *   1. `finalization_status` is on the allowlist above;
 *   2. a `produce_sessions` row exists whose `ingest_idempotency_key` is exactly
 *      this session_key + session_generation.
 *
 * Condition 2 is what makes a content-hash `duplicate` — rows written for a
 * DIFFERENT generation — read as unsaved. A status that says success with no
 * matching row is treated the same way a missing status is: still running while
 * the pending row is live, failed once it terminalizes. Callers never see
 * "succeeded" without the row, so the White Sheet, slips and settlement stay
 * closed until the proof exists.
 *
 * A lookup error is `pending`, never success: unanswerable is not proof.
 */
export async function resolveGuidedProduceFinalization(
  supabase: AnyClient,
  row: GuidedProduceIdentityRow,
): Promise<GuidedProduceFinalization> {
  const status = classifyGuidedProduceFinalization(row);
  if (status !== "succeeded") return status;

  const ingestKey = produceIngestIdempotencyKey(
    row.session_key,
    row.session_generation,
  );
  if (!ingestKey) return row.terminalized === true ? "failed" : "pending";

  let found: boolean;
  try {
    const result = await supabase
      .from("produce_sessions")
      .select("id")
      .eq("ingest_idempotency_key", ingestKey)
      .limit(1)
      .maybeSingle();
    if (result.error) return "pending";
    found = result.data != null;
  } catch {
    return "pending";
  }
  if (found) return "succeeded";
  // The finalizer reported success but not for this generation's identity: a
  // content-hash duplicate, or rows that never landed under our key.
  return row.terminalized === true ? "failed" : "pending";
}
