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
 * `pending_sessions.finalization_status` is the authority. This module is the
 * one place that decides what counts as success, by allowlist:
 *
 *   finalized   produce session written
 *   duplicate   the same generation was already written — rows exist
 *
 * Everything else is either still running or a failure. An unrecognised status
 * is never treated as success: on a terminalized row it fails closed, and on a
 * live row it reads as still pending.
 */

import type { PendingSession } from "@/lib/line/pending-session-service";

/** Statuses that prove produce rows exist. Nothing else may be added lightly. */
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
