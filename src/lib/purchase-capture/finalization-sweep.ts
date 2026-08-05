/**
 * P2B Purchase Capture Slice B — cron eligibility + finalization sweep.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
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
}

export async function sweepPurchaseCaptureFinalization(
  supabase: Supabase,
  push?: PurchaseCapturePushMessage,
  limit = DEFAULT_SWEEP_LIMIT,
): Promise<PurchaseCaptureSweepResult> {
  const result = await finalizeDuePurchaseCaptureSessions(supabase, push, limit);
  logger.info("Purchase capture finalization sweep completed", { ...result });
  return result;
}
