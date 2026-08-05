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

import { isPlainObject, parseConfirmationPayload } from "@/lib/purchase-receipts/validate";

import {

  parsePurchaseCaptureDocument,

  primaryAssemblyFailReason,

  type PurchaseCaptureParseContext,

} from "./parser-adapter";

import {

  deliverPurchaseCaptureNotificationParts,

  type PurchaseCapturePushMessage,

} from "./notification-push-worker";

import type { PurchaseCaptureNotificationKind } from "./notification-service";

import { renderPurchaseCapturePreviewPayloadTexts } from "./preview";

import {

  PurchaseCaptureCloseQuietWindowError,

  PurchaseCaptureSessionService,

  PurchaseCaptureStaleIngestHashError,

  PurchaseCaptureStaleIngestRevisionError,

  type PurchaseCaptureSessionRow,

} from "./session-service";



type Supabase = SupabaseClient<Database>;



const DEFAULT_SWEEP_LIMIT = 25;

const MAX_STALE_RETRIES = 3;



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



type NotificationWorkItem = {

  sessionId: string;

  recipientId: string;

  notificationKind: PurchaseCaptureNotificationKind;

  notificationVersion: string;

};



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



async function loadPreviewPayloadTextsFromReceipt(

  supabase: Supabase,

  receiptId: string,

): Promise<string[]> {

  const { data, error } = await supabase.rpc("purchase_receipt_build_confirmation_payload", {

    p_receipt_id: receiptId,

  });

  if (error) throw new Error(`confirmation payload load failed: ${error.message}`);

  if (!isPlainObject(data)) {

    throw new Error("confirmation payload missing");

  }

  const payload = parseConfirmationPayload(data);

  return renderPurchaseCapturePreviewPayloadTexts(payload);

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



    if (candidate.status === "awaiting_confirmation" && session.draft_revision && session.receipt_id) {

      await deliverPurchaseCaptureNotificationParts(supabase, {

        sessionId: session.id,

        recipientId: session.source_id,

        notificationKind: "preview_ready",

        notificationVersion: session.draft_revision.toString(),

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

        const previewPayloadTexts = await loadPreviewPayloadTextsFromReceipt(supabase, saved.receiptId);



        const finalized = await sessionService.finalizeSession({

          sessionId: candidate.sessionId,

          expectedGeneration: candidate.sessionGeneration,

          ...ownership,

          expectedIngestRevision: candidate.ingestRevision,

          expectedIngestHash: candidate.ingestSetHash,

          assemblyStatus: "success",

          receiptId: saved.receiptId,

          draftRevision: saved.draftRevision,

          previewPayloadTexts,

        });



        await deliverPurchaseCaptureNotificationParts(supabase, {

          sessionId: candidate.sessionId,

          recipientId: session.source_id,

          notificationKind: "preview_ready",

          notificationVersion: finalized.draftRevision ?? saved.draftRevision,

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

        ...ownership,

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



function notificationWorkKey(item: NotificationWorkItem): string {

  return `${item.sessionId}:${item.notificationKind}:${item.notificationVersion}`;

}



export async function listUndeliveredNotificationWork(
  supabase: Supabase,
  limit: number,
): Promise<NotificationWorkItem[]> {
  const now = new Date().toISOString();
  const { data: notifications, error } = await supabase
    .from("purchase_capture_notifications")
    .select("session_id, notification_kind, notification_version, delivery_status, claim_expires_at")
    .neq("delivery_status", "delivered")
    .neq("delivery_status", "superseded")
    .order("created_at", { ascending: true })
    .limit(limit * 4);

  if (error) throw new Error(`undelivered notification lookup failed: ${error.message}`);

  const sessionIds = [...new Set((notifications ?? []).map((row) => row.session_id))];
  if (sessionIds.length === 0) return [];

  const { data: sessions, error: sessionError } = await supabase
    .from("purchase_capture_sessions")
    .select("id, source_id, status")
    .in("id", sessionIds)
    .eq("status", "awaiting_confirmation");

  if (sessionError) {
    throw new Error(`awaiting_confirmation session lookup failed: ${sessionError.message}`);
  }

  const sessionById = new Map((sessions ?? []).map((session) => [session.id, session]));
  const work = new Map<string, NotificationWorkItem>();

  for (const row of notifications ?? []) {
    const session = sessionById.get(row.session_id);
    if (!session) continue;

    const status = row.delivery_status;
    if (status === "sending") {
      const expires = row.claim_expires_at;
      if (expires != null && expires > now) continue;
    } else if (status !== "pending" && status !== "failed") {
      continue;
    }

    const item: NotificationWorkItem = {
      sessionId: row.session_id,
      recipientId: session.source_id,
      notificationKind: row.notification_kind as PurchaseCaptureNotificationKind,
      notificationVersion: row.notification_version,
    };

    work.set(notificationWorkKey(item), item);
    if (work.size >= limit) break;
  }

  return [...work.values()];
}



export async function finalizeDuePurchaseCaptureSessions(

  supabase: Supabase,

  push: PurchaseCapturePushMessage = pushLineMessage,

  limit = DEFAULT_SWEEP_LIMIT,

): Promise<PurchaseCaptureFinalizerRun> {

  const [closing, notificationWork] = await Promise.all([

    listDueClosingSessions(supabase, limit),

    listUndeliveredNotificationWork(supabase, limit),

  ]);



  const run: PurchaseCaptureFinalizerRun = {

    due: closing.length + notificationWork.length,

    awaitingConfirmation: 0,

    failedClosed: 0,

    pending: 0,

    skipped: 0,

    errors: 0,

  };



  for (const session of closing) {

    try {

      const result = await finalizePurchaseCaptureSession(

        supabase,

        {

          sessionId: session.id,

          expectedGeneration: session.session_generation,

        },

        push,

      );



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



  for (const work of notificationWork) {

    try {

      await deliverPurchaseCaptureNotificationParts(supabase, work, push);

      run.awaitingConfirmation += 1;

    } catch (error) {

      run.errors += 1;

      logger.error("Purchase capture outbox recovery failed", {

        sessionId: work.sessionId,

        notificationVersion: work.notificationVersion,

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

  const { renderPurchaseCapturePreviewPayloadTextsFromDraft } = await import("./preview");

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
