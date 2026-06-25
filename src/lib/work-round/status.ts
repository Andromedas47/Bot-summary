/**
 * Work Round status machine (V2 — P1).
 *
 * Deterministic transitions. Each event maps a current status to a next status.
 * `nextStatus` returns null when the event does not apply to the current status
 * (a no-op), so callers can apply events idempotently.
 *
 * Status → driving event:
 *   open                 ← round created / produce session attached
 *   produce_complete     ← produce_closed (explicit "produce done" signal)
 *   awaiting_settlement  ← settlement_opened (ส่งเงิน resolved to this round)
 *   awaiting_slips       ← settlement_confirmed (ยืนยันส่งเงิน)
 *   variance_found       ← reconciled_variance (declared transfer ≠ slip evidence)
 *   ready_for_review     ← reconciled_match
 *   approved             ← approved (reviewer)
 *   needs_correction     ← needs_correction (reviewer)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkRoundStatus } from "./types";
import { logger } from "@/lib/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export type WorkRoundEvent =
  | "produce_attached"
  | "produce_closed"
  | "settlement_opened"
  | "settlement_confirmed"
  | "reconciled_match"
  | "reconciled_variance"
  | "approved"
  | "needs_correction";

// Allowed source statuses for each event → resulting status.
// An event from any status not listed is a no-op (returns null).
const TRANSITIONS: Record<WorkRoundEvent, { from: WorkRoundStatus[]; to: WorkRoundStatus }> = {
  // Produce activity keeps the round open (never reverts an approved round).
  produce_attached: {
    from: ["open", "produce_complete", "awaiting_settlement", "awaiting_slips", "variance_found", "ready_for_review", "needs_correction"],
    to:   "open",
  },
  produce_closed: {
    from: ["open"],
    to:   "produce_complete",
  },
  settlement_opened: {
    from: ["open", "produce_complete", "awaiting_settlement", "needs_correction"],
    to:   "awaiting_settlement",
  },
  settlement_confirmed: {
    from: ["awaiting_settlement", "awaiting_slips", "needs_correction"],
    to:   "awaiting_slips",
  },
  reconciled_match: {
    from: ["awaiting_slips", "variance_found"],
    to:   "ready_for_review",
  },
  reconciled_variance: {
    from: ["awaiting_slips", "ready_for_review", "variance_found"],
    to:   "variance_found",
  },
  approved: {
    from: ["ready_for_review", "variance_found"],
    to:   "approved",
  },
  needs_correction: {
    // Reviewer can flag any non-approved round for correction.
    from: ["open", "produce_complete", "awaiting_settlement", "awaiting_slips", "variance_found", "ready_for_review"],
    to:   "needs_correction",
  },
};

/** Pure transition. Returns the next status, or null if the event is a no-op. */
export function nextStatus(current: WorkRoundStatus, event: WorkRoundEvent): WorkRoundStatus | null {
  const rule = TRANSITIONS[event];
  if (!rule) return null;
  if (!rule.from.includes(current)) return null;
  if (rule.to === current) return null;
  return rule.to;
}

export class WorkRoundStatusService {
  constructor(private readonly supabase: AnyClient) {}

  /**
   * Applies an event to a Work Round. Loads current status, computes the next,
   * and updates if it changed. Tolerant: never throws into the webhook path —
   * a missing table or absent round is logged and ignored.
   * Returns the resulting status, or null if no change.
   */
  async applyEvent(workRoundId: string, event: WorkRoundEvent): Promise<WorkRoundStatus | null> {
    const log = logger.child({ fn: "WorkRoundStatusService.applyEvent", workRoundId, event });
    try {
      const { data: round } = await this.supabase
        .from("work_rounds")
        .select("status")
        .eq("id", workRoundId)
        .maybeSingle();

      if (!round) return null;

      const current = round.status as WorkRoundStatus;
      const next    = nextStatus(current, event);
      if (!next) return null;

      const { error } = await this.supabase
        .from("work_rounds")
        .update({ status: next, updated_at: new Date().toISOString() })
        .eq("id", workRoundId);

      if (error) {
        log.warn("status update failed", { error: error.message });
        return null;
      }
      log.info("work round status changed", { from: current, to: next });
      return next;
    } catch (err) {
      log.warn("applyEvent skipped", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}
