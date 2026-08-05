/**
 * P2B Purchase Capture Slice A — cron eligibility discovery only.
 *
 * Scope is deliberately narrow (plan §21 Slice A): authenticate (route.ts),
 * discover `closing` sessions past their quiet/deadline boundary, and
 * compute/log finalize eligibility via get_purchase_capture_finalize_candidate.
 * Never parses a document, never creates a purchase_receipts draft, never
 * transitions a session, never sends a LINE message. Slice B/C extend this
 * sweep into the real finalize/posting-recovery sweep.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { PurchaseCaptureSessionService, type PurchaseCaptureSessionRow } from "./session-service";

type Supabase = SupabaseClient<Database>;

const DEFAULT_SWEEP_LIMIT = 25;

export interface PurchaseCaptureEligibilitySweepResult {
  due: number;
  eligible: number;
  pending: number;
  errors: number;
}

async function listDueClosingSessions(
  supabase: Supabase,
  limit: number,
): Promise<PurchaseCaptureSessionRow[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("purchase_capture_sessions")
    .select("*")
    .eq("status", "closing")
    .or(`close_quiet_until.lte.${now},close_deadline_at.lte.${now}`)
    .order("close_quiet_until", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`due purchase capture lookup failed: ${error.message}`);
  return data ?? [];
}

export async function sweepPurchaseCaptureEligibility(
  supabase: Supabase,
  limit = DEFAULT_SWEEP_LIMIT,
): Promise<PurchaseCaptureEligibilitySweepResult> {
  const service = new PurchaseCaptureSessionService(supabase);
  const sessions = await listDueClosingSessions(supabase, limit);

  const result: PurchaseCaptureEligibilitySweepResult = {
    due: sessions.length,
    eligible: 0,
    pending: 0,
    errors: 0,
  };

  for (const session of sessions) {
    try {
      const candidate = await service.getFinalizeCandidate({
        sessionId: session.id,
        expectedGeneration: session.session_generation,
      });
      if (candidate.eligibleForFinalize) {
        result.eligible += 1;
      } else {
        result.pending += 1;
      }
      logger.info("Purchase capture eligibility computed", {
        sessionId: session.id,
        status: candidate.status,
        quietElapsed: candidate.quietElapsed,
        deadlineElapsed: candidate.deadlineElapsed,
        eligibleForFinalize: candidate.eligibleForFinalize,
        ingestCount: candidate.ingests.length,
      });
    } catch (error) {
      result.errors += 1;
      logger.error("Purchase capture eligibility sweep failed", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
