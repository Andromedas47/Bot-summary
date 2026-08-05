/**
 * P2B purchase capture finalizer (Slice B).
 *
 * Discovers eligible closing sessions, parses deterministically, persists drafts,
 * finalizes sessions, and delivers preview notifications via the shared outbox worker.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { PurchaseReceiptService } from "@/lib/purchase-receipts/receipt-service";
import {
  parsePurchaseCaptureDocument,
  primaryAssemblyFailReason,
  type PurchaseCaptureParseContext,
} from "./parser-adapter";
import { renderPurchaseCapturePreviewPayloadTextsFromDraft } from "./preview";
import { recoverUndeliveredPreviewNotifications, type PurchaseCapturePushMessage } from "./notification-push-worker";
import {
  PURCHASE_CAPTURE_CLOSE_DEADLINE_MS,
  PurchaseCaptureCloseQuietWindowError,
  PurchaseCaptureSessionService,
  PurchaseCaptureStaleIngestHashError,
  PurchaseCaptureStaleIngestRevisionError,
  type PurchaseCaptureSessionRow,
} from "./session-service";

type Supabase = SupabaseClient<Database>;

const DEFAULT_SWEEP_LIMIT = 25;
const MAX_STALE_RETRIES = 3;
const RECENT_PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type PurchaseCaptureFinalizerResult =
  | { status: "awaiting_confirmation"; sessionId: string; idempotent: boolean }
  | { status: "failed_closed"; sessionId: string; idempotent: boolean }
  | { status: "pending"; sessionId: string; reason: string }
  | { status: "skipped"; sessionId: string; reason: string };

export interface PurchaseCaptureFinalizerRun {
  due: number;
  awaitingConfirmation: number;
  failedClosed: number;
  pending: number;
  skipped: number;
  errors: number;
}

function ownershipFromSession(session: PurchaseCaptureSessionRow) {
  return {
    expectedSourceType: session.source_type,
    expectedSourceId: session.source_id,
    expectedSenderLineUserId: session.sender_line_user_id,
  };
}

function parseContextFromSession(session: PurchaseCaptureSessionRow): PurchaseCaptureParseContext {
  return {
    sourceType: session.source_type,
    sourceId: session.source_id,
    senderLineUserId: session.sender_line_user_id,
    openedLineEventId: session.opened_line_event_id,
  };
}

export async function finalizePurchaseCaptureSession(
  supabase: Supabase,
  params: { sessionId: string; expectedGeneration: string },
  push: PurchaseCapturePushMessage = pushLineMessage,
): Promise<PurchaseCaptureFinalizerResult> {
  const sessionService = new PurchaseCaptureSessionService(supabase);
  const receiptService = new PurchaseReceiptService(supabase);

  for (let attempt = 1; attempt <= MAX_STALE_RETRIES; attempt += 1) {
    const session = await sessionService.getSession(params.sessionId);
    if (!session) {
      return { status: "skipped", sessionId: params.sessionId, reason: "session_not_found" };
    }

    const ownership = ownershipFromSession(session);
    const candidate = await sessionService.getFinalizeCandidate({
      sessionId: params.sessionId,
      expectedGeneration: params.expectedGeneration,
      ...ownership,
    });

    if (candidate.status === "awaiting_confirmation" && session.draft_revision) {
      await recoverUndeliveredPreviewNotifications(supabase, {
        sessionId: session.id,
        recipientId: session.source_id,
        draftRevision: session.draft_revision.toString(),
      }, push);
      return { status: "awaiting_confirmation", sessionId: session.id, idempotent: true };
    }

    if (candidate.status === "failed_closed") {
      return { status: "failed_closed", sessionId: candidate.sessionId, idempotent: true };
    }

    if (candidate.status !== "closing" || !candidate.eligibleForFinalize) {
      return {
        status: "pending",
        sessionId: candidate.sessionId,
        reason: candidate.status !== "closing" ? "not_closing" : "not_eligible",
      };
    }

    const parsed = await parsePurchaseCaptureDocument(
      supabase,
      candidate.ingests,
      parseContextFromSession(session),
    );

    try {
      if (parsed.assembly.status === "COMPLETE" && parsed.draft) {
        const saved = await receiptService.saveDraft(parsed.draft);
        const previewPayloadTexts = renderPurchaseCapturePreviewPayloadTextsFromDraft(parsed.draft);

        const finalized = await sessionService.finalizeSession({
          sessionId: candidate.sessionId,
          expectedGeneration: candidate.sessionGeneration,
          expectedIngestRevision: candidate.ingestRevision,
          expectedIngestHash: candidate.ingestSetHash,
          assemblyStatus: "success",
          receiptId: saved.receiptId,
          draftRevision: saved.draftRevision,
          previewPayloadTexts,
        });

        await recoverUndeliveredPreviewNotifications(supabase, {
          sessionId: candidate.sessionId,
          recipientId: session.source_id,
          draftRevision: finalized.draftRevision ?? saved.draftRevision,
        }, push);

        return {
          status: "awaiting_confirmation",
          sessionId: candidate.sessionId,
          idempotent: finalized.idempotent,
        };
      }

      const failReason = primaryAssemblyFailReason(parsed.assembly);
      const finalized = await sessionService.finalizeSession({
        sessionId: candidate.sessionId,
        expectedGeneration: candidate.sessionGeneration,
        expectedIngestRevision: candidate.ingestRevision,
        expectedIngestHash: candidate.ingestSetHash,
        assemblyStatus: "failed",
        failReason,
      });

      return {
        status: "failed_closed",
        sessionId: candidate.sessionId,
        idempotent: finalized.idempotent,
      };
    } catch (error) {
      if (
        error instanceof PurchaseCaptureStaleIngestRevisionError
        || error instanceof PurchaseCaptureStaleIngestHashError
      ) {
        if (attempt < MAX_STALE_RETRIES) continue;
        return {
          status: "pending",
          sessionId: candidate.sessionId,
          reason: "stale_candidate_retry_exhausted",
        };
      }
      if (error instanceof PurchaseCaptureCloseQuietWindowError) {
        return {
          status: "pending",
          sessionId: candidate.sessionId,
          reason: "close_quiet_window",
        };
      }
      throw error;
    }
  }

  return {
    status: "pending",
    sessionId: params.sessionId,
    reason: "bounded_retry_exhausted",
  };
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

async function listRecentAwaitingConfirmationSessions(
  supabase: Supabase,
  limit: number,
): Promise<PurchaseCaptureSessionRow[]> {
  const since = new Date(Date.now() - RECENT_PREVIEW_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("purchase_capture_sessions")
    .select("*")
    .eq("status", "awaiting_confirmation")
    .gte("updated_at", since)
    .not("draft_revision", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`awaiting purchase capture lookup failed: ${error.message}`);
  return data ?? [];
}

export async function finalizeDuePurchaseCaptureSessions(
  supabase: Supabase,
  push: PurchaseCapturePushMessage = pushLineMessage,
  limit = DEFAULT_SWEEP_LIMIT,
): Promise<PurchaseCaptureFinalizerRun> {
  const [closing, awaiting] = await Promise.all([
    listDueClosingSessions(supabase, limit),
    listRecentAwaitingConfirmationSessions(supabase, limit),
  ]);

  const sessions = new Map<string, PurchaseCaptureSessionRow>();
  for (const session of [...closing, ...awaiting]) sessions.set(session.id, session);

  const run: PurchaseCaptureFinalizerRun = {
    due: sessions.size,
    awaitingConfirmation: 0,
    failedClosed: 0,
    pending: 0,
    skipped: 0,
    errors: 0,
  };

  for (const session of sessions.values()) {
    try {
      const result = session.status === "closing"
        ? await finalizePurchaseCaptureSession(
          supabase,
          {
            sessionId: session.id,
            expectedGeneration: session.session_generation,
          },
          push,
        )
        : (await recoverUndeliveredPreviewNotifications(
          supabase,
          {
            sessionId: session.id,
            recipientId: session.source_id,
            draftRevision: session.draft_revision?.toString() ?? "",
          },
          push,
        ), {
          status: "awaiting_confirmation",
          sessionId: session.id,
          idempotent: true,
        } as const);

      if (result.status === "awaiting_confirmation") run.awaitingConfirmation += 1;
      else if (result.status === "failed_closed") run.failedClosed += 1;
      else if (result.status === "pending") run.pending += 1;
      else run.skipped += 1;
    } catch (error) {
      run.errors += 1;
      logger.error("Purchase capture finalizer failed", {
        sessionId: session.id,
        sessionGeneration: session.session_generation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return run;
}

export async function replacePurchaseCaptureDraftFromIngests(
  supabase: Supabase,
  params: {
    session: PurchaseCaptureSessionRow;
    expectedDraftRevision: string;
  },
): Promise<{ draftRevision: string; previewPayloadTexts: string[] }> {
  const sessionService = new PurchaseCaptureSessionService(supabase);
  const candidate = await sessionService.getFinalizeCandidate({
    sessionId: params.session.id,
    expectedGeneration: params.session.session_generation,
    expectedSourceType: params.session.source_type,
    expectedSourceId: params.session.source_id,
    expectedSenderLineUserId: params.session.sender_line_user_id,
  });

  const parsed = await parsePurchaseCaptureDocument(
    supabase,
    candidate.ingests,
    parseContextFromSession(params.session),
  );
  if (!parsed.draft) throw new Error("recheck requires a complete assembly");

  const { toRpcDraftPayload } = await import("./draft-payload");
  const draftPayload = toRpcDraftPayload(parsed.draft);
  const previewPayloadTexts = renderPurchaseCapturePreviewPayloadTextsFromDraft(parsed.draft);

  if (!params.session.receipt_id) {
    throw new Error("recheck requires an existing receipt_id");
  }

  const replaced = await sessionService.replaceDraft({
    sessionId: params.session.id,
    expectedGeneration: params.session.session_generation,
    expectedReceiptId: params.session.receipt_id,
    expectedDraftRevision: params.expectedDraftRevision,
    sourceType: params.session.source_type,
    sourceId: params.session.source_id,
    senderLineUserId: params.session.sender_line_user_id,
    draftPayload,
    previewPayloadTexts,
  });

  return {
    draftRevision: replaced.draftRevision,
    previewPayloadTexts,
  };
}
