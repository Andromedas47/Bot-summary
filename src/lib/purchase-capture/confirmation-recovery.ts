/**
 * P2C Slice C4 — purchase-capture confirmation recovery.
 *
 * Two independent background sweeps, both read-only-discovery-then-delegate:
 *
 *  1. {@link recoverStuckConfirmingSessions} finds sessions stuck in
 *     'confirming' past a quiet window (crashed between the confirm step and
 *     complete_purchase_capture_posting, plan §12.1) and resumes them via
 *     {@link resumePurchaseCaptureConfirmation} — never via the fresh-path
 *     entry point, so `begin_purchase_capture_confirmation` is never reachable
 *     from here.
 *  2. {@link recoverPostedSuccessDeliveries} finds `posted` sessions holding
 *     undelivered `posted_success` outbox parts (crashed after step 8 landed
 *     but before step 9's push completed) and drains them.
 *
 * Neither function reimplements the confirm/post/complete sequence — that
 * sequence lives entirely in confirm-flow.ts, which this module only calls.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { resumePurchaseCaptureConfirmation } from "./confirm-flow";
import { listUndeliveredNotificationWork } from "./finalizer";
import {
  deliverPurchaseCaptureNotificationParts,
  type PurchaseCapturePushMessage,
} from "./notification-push-worker";
import type { PurchaseCaptureSessionRow } from "./session-service";

type Supabase = SupabaseClient<Database>;

const DEFAULT_RECOVERY_LIMIT = 25;

/** Plan §12.1: sessions stuck 'confirming' past this window are recovery-eligible. */
export const PURCHASE_CAPTURE_CONFIRMING_QUIET_MS = 60_000;

export interface PurchaseCaptureConfirmationRecoveryResult {
  due: number;
  resumed: number;
  refused: number;
  errors: number;
}

async function listStuckConfirmingSessions(
  supabase: Supabase,
  limit: number,
  quietMs: number,
): Promise<PurchaseCaptureSessionRow[]> {
  const cutoff = new Date(Date.now() - quietMs).toISOString();
  const { data, error } = await supabase
    .from("purchase_capture_sessions")
    .select("*")
    .eq("status", "confirming")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`stuck confirming session lookup failed: ${error.message}`);
  return data ?? [];
}

/**
 * Resumes sessions stuck in 'confirming' past `quietMs` (default: plan §12.1's
 * one minute). Read-only discovery, then delegates each session to
 * `resumePurchaseCaptureConfirmation`, which refuses to re-run
 * `begin_purchase_capture_confirmation` (it only resumes 'confirming' or
 * replays 'posted') — so that authoritative gate is never reachable from a
 * background sweep.
 *
 * Ownership note: a background sweep has no inbound LINE event to derive
 * "who is asking" from, so — here, and ONLY here — the session row itself is
 * treated as the ownership source (its own source_type/source_id/
 * sender_line_user_id are passed back as the "expected" values). This is safe
 * because `resumePurchaseCaptureConfirmation`'s underlying RPCs re-verify
 * ownership against the row under lock regardless of what the caller claims;
 * this sweep is not the ownership authority, it merely reflects the row back.
 */
export async function recoverStuckConfirmingSessions(
  supabase: Supabase,
  push: PurchaseCapturePushMessage = pushLineMessage,
  limit = DEFAULT_RECOVERY_LIMIT,
  quietMs = PURCHASE_CAPTURE_CONFIRMING_QUIET_MS,
): Promise<PurchaseCaptureConfirmationRecoveryResult> {
  const sessions = await listStuckConfirmingSessions(supabase, limit, quietMs);

  const result: PurchaseCaptureConfirmationRecoveryResult = {
    due: sessions.length,
    resumed: 0,
    refused: 0,
    errors: 0,
  };

  for (const session of sessions) {
    try {
      const outcome = await resumePurchaseCaptureConfirmation(
        supabase,
        {
          sessionId: session.id,
          expectedSourceType: session.source_type,
          expectedSourceId: session.source_id,
          expectedSenderLineUserId: session.sender_line_user_id,
        },
        push,
      );

      const logFields: Record<string, unknown> = {
        sessionId: outcome.sessionId,
        receiptId: outcome.outcome === "posted" ? outcome.receiptId : undefined,
        draftRevision: outcome.outcome === "posted" ? outcome.draftRevision : undefined,
        movementId: outcome.outcome === "posted" ? outcome.movementId : undefined,
        replayed: outcome.outcome === "posted" ? outcome.replayed : undefined,
        recoveryStage: outcome.recoveryStage,
        notificationKind: "posted_success",
      };

      if (outcome.outcome === "posted") {
        result.resumed += 1;
        logger.info("purchase_capture_confirmation_recovery_resumed", logFields);
      } else {
        result.refused += 1;
        logger.warn("purchase_capture_confirmation_recovery_refused", {
          ...logFields,
          code: outcome.code,
        });
      }
    } catch (error) {
      result.errors += 1;
      logger.error("purchase_capture_confirmation_recovery_failed", {
        sessionId: session.id,
        recoveryStage: "confirming",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Drains undelivered `posted_success` outbox parts for sessions that already
 * reached 'posted' (crashed after complete_purchase_capture_posting's
 * transaction committed but before step 9's push finished, plan §12.1).
 *
 * Reuses {@link listUndeliveredNotificationWork} from ./finalizer, scoped to
 * the posted_success kind — that lookup already returns work items for
 * 'posted' sessions, so a second query is unnecessary here. Scoping at the
 * query helper (rather than filtering afterwards) matters: this stage owns
 * posted_success exclusively, and an unscoped call would let a preview_ready
 * backlog exhaust the shared limit before any posted_success part is seen.
 * Partial delivery (some parts
 * already delivered, some not) is handled entirely by
 * `deliverPurchaseCaptureNotificationParts`'s own claim-then-push loop, which
 * only claims the still-undelivered parts — no part-index bookkeeping is
 * added here.
 */
export async function recoverPostedSuccessDeliveries(
  supabase: Supabase,
  push: PurchaseCapturePushMessage = pushLineMessage,
  limit = DEFAULT_RECOVERY_LIMIT,
): Promise<{ due: number; delivered: number; errors: number }> {
  const work = await listUndeliveredNotificationWork(supabase, limit, ["posted_success"]);

  const result = { due: work.length, delivered: 0, errors: 0 };

  for (const item of work) {
    try {
      await deliverPurchaseCaptureNotificationParts(supabase, item, push);
      result.delivered += 1;
    } catch (error) {
      result.errors += 1;
      logger.error("purchase_capture_posted_success_recovery_failed", {
        sessionId: item.sessionId,
        notificationVersion: item.notificationVersion,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
