/**
 * P2B Purchase Capture Slice B — cron eligibility + finalization sweep.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  recoverPostedSuccessDeliveries,
  recoverStuckConfirmingSessions,
} from "./confirmation-recovery";
import { finalizeDuePurchaseCaptureSessions } from "./finalizer";
import type { PurchaseCapturePushMessage } from "./notification-push-worker";

type Supabase = SupabaseClient<Database>;

const DEFAULT_SWEEP_LIMIT = 25;

export interface PurchaseCaptureSweepResult {
  due: number;
  awaitingConfirmation: number;
  failedClosed: number;
  pending: number;
  skipped: number;
  errors: number;
  confirmingDue: number;
  confirmingResumed: number;
  confirmingRefused: number;
  postedSuccessDelivered: number;
}

export async function sweepPurchaseCaptureFinalization(
  supabase: Supabase,
  push?: PurchaseCapturePushMessage,
  limit = DEFAULT_SWEEP_LIMIT,
): Promise<PurchaseCaptureSweepResult> {
  // Stage 1: existing Slice A/B closing behaviour — unchanged.
  let errors = 0;
  const stage1 = await finalizeDuePurchaseCaptureSessions(supabase, push, limit);
  errors += stage1.errors;

  // Stage 2: resume sessions stuck 'confirming' past the quiet window. A
  // thrown error here must not lose the stage-1 result, so it is caught and
  // folded into the combined error count instead of propagating.
  let confirmingDue = 0;
  let confirmingResumed = 0;
  let confirmingRefused = 0;
  try {
    const stage2 = await recoverStuckConfirmingSessions(supabase, push, limit);
    confirmingDue = stage2.due;
    confirmingResumed = stage2.resumed;
    confirmingRefused = stage2.refused;
    errors += stage2.errors;
  } catch (error) {
    errors += 1;
    logger.error("Purchase capture confirming-session recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Stage 3: drain undelivered posted_success outbox parts for 'posted'
  // sessions. Same isolation as stage 2 — its own failure must not lose the
  // results already gathered from stages 1-2.
  let postedSuccessDelivered = 0;
  try {
    const stage3 = await recoverPostedSuccessDeliveries(supabase, push, limit);
    postedSuccessDelivered = stage3.delivered;
    errors += stage3.errors;
  } catch (error) {
    errors += 1;
    logger.error("Purchase capture posted_success delivery recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const result: PurchaseCaptureSweepResult = {
    due: stage1.due,
    awaitingConfirmation: stage1.awaitingConfirmation,
    failedClosed: stage1.failedClosed,
    pending: stage1.pending,
    skipped: stage1.skipped,
    errors,
    confirmingDue,
    confirmingResumed,
    confirmingRefused,
    postedSuccessDelivered,
  };

  logger.info("Purchase capture finalization sweep completed", { ...result });
  return result;
}
