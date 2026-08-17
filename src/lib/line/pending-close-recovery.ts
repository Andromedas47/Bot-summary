/**
 * P1-B recovery sweep: a refused close must not become a permanent limbo.
 *
 * The plain-text close gate refuses by downgrading `markClose` to false, which
 * leaves the generation in capture so the operator can correct the document in
 * place. That window is intentional. What was missing is its END: nothing
 * recorded that a valid close had arrived, nothing scheduled a retry, and
 * nothing bounded the wait, so a generation whose review was never confirmed —
 * or whose refusal reply never reached anyone — stayed `pending` forever with
 * close_requested_at, close_deadline_at and next_attempt_at all NULL.
 *
 * `mark_plain_text_close_refused` stamps the refusal at the webhook. This sweep
 * closes the loop: once the grace period has elapsed with no close scheduled and
 * no further operator activity on the row, the generation reaches the terminal
 * `failed_closed` state with an explicit reason, and the accountability round it
 * holds is retired only if provably empty.
 *
 * No LINE message is sent. The operator already received the actionable refusal
 * at the moment it happened; a second notice half an hour later would say
 * nothing new.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getRuntimeEnvironment } from "@/lib/runtime-environment";
import { logger } from "@/lib/logger";

type Supabase = SupabaseClient<Database>;

export interface PendingCloseRecoveryRun {
  recovered: number;
  roundsCancelled: number;
}

/**
 * The correction window an operator gets after a refused close.
 *
 * Matched to the existing pending-session inactivity timeout so a stranded
 * close and a stranded capture expire on the same clock. The sweep also
 * requires the row to be untouched for the whole window, so an operator who is
 * still sending corrections keeps extending their own deadline.
 */
export const CLOSE_RECOVERY_GRACE = "30 minutes";

export async function recoverStrandedPendingCloses(
  supabase: Supabase,
  limit = 25,
): Promise<PendingCloseRecoveryRun> {
  const { data, error } = await supabase.rpc("recover_stranded_plain_text_closes", {
    p_limit: limit,
    p_runtime_environment: getRuntimeEnvironment(),
    p_grace: CLOSE_RECOVERY_GRACE,
  });

  if (error) throw new Error(`stranded close recovery failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    session_key: string;
    session_generation: string;
    source_id: string;
    accountability_round_id: string | null;
    round_outcome: string;
    close_refused_at: string;
  }>;

  for (const row of rows) {
    logger.info("produce.close.recovered", {
      sessionKey: row.session_key,
      sessionGeneration: row.session_generation,
      sourceId: row.source_id,
      accountabilityRoundId: row.accountability_round_id,
      roundOutcome: row.round_outcome,
      closeRefusedAt: row.close_refused_at,
      outcome: "failed_closed",
      reason: "close_refused_unresolved",
    });
  }

  return {
    recovered: rows.length,
    roundsCancelled: rows.filter((row) => row.round_outcome === "cancelled").length,
  };
}
