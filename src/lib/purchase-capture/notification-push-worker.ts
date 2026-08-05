/**
 * Shared Push API outbox worker (plan §18.4, §18.7).
 *
 * The only code path that calls pushLineMessage() for purchase_capture_notifications.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { pushLineMessage, type PushResult } from "@/lib/line/reply";
import {
  PurchaseCaptureNotificationService,
  type PurchaseCaptureNotificationKind,
} from "./notification-service";

type Supabase = SupabaseClient<Database>;

export type PurchaseCapturePushMessage = (
  to: string,
  text: string,
  retryKey?: string,
) => Promise<PushResult>;

export type DeliverPurchaseCaptureNotificationResult = {
  deliveredParts: number;
  failedParts: number;
  stoppedReason: "complete" | "nothing_eligible" | "push_failed" | "claim_error";
};

export async function deliverPurchaseCaptureNotificationParts(
  supabase: Supabase,
  params: {
    sessionId: string;
    recipientId: string;
    notificationKind: PurchaseCaptureNotificationKind;
    notificationVersion: string;
    maxParts?: number;
  },
  push: PurchaseCapturePushMessage = pushLineMessage,
): Promise<DeliverPurchaseCaptureNotificationResult> {
  const service = new PurchaseCaptureNotificationService(supabase);
  const limit = params.maxParts ?? Number.POSITIVE_INFINITY;
  let deliveredParts = 0;
  let failedParts = 0;

  for (let index = 0; index < limit; index += 1) {
    let claim;
    try {
      claim = await service.claimNextPart({
        sessionId: params.sessionId,
        notificationKind: params.notificationKind,
        notificationVersion: params.notificationVersion,
      });
    } catch {
      return {
        deliveredParts,
        failedParts,
        stoppedReason: "claim_error",
      };
    }

    if (!claim?.claimToken) {
      return {
        deliveredParts,
        failedParts,
        stoppedReason: deliveredParts > 0 || failedParts > 0 ? "complete" : "nothing_eligible",
      };
    }

    try {
      const result = await push(params.recipientId, claim.payloadText, claim.retryKey);
      if (result.status === "delivered" || result.status === "already_accepted") {
        await service.markDelivered({
          notificationPartId: claim.id,
          claimToken: claim.claimToken,
        });
        deliveredParts += 1;
        continue;
      }
      await service.recordAttempt({
        notificationPartId: claim.id,
        claimToken: claim.claimToken,
        error: "unexpected_push_result",
      });
      failedParts += 1;
      return { deliveredParts, failedParts, stoppedReason: "push_failed" };
    } catch (error) {
      await service.recordAttempt({
        notificationPartId: claim.id,
        claimToken: claim.claimToken,
        error: error instanceof Error ? error.message : String(error),
      });
      failedParts += 1;
      return { deliveredParts, failedParts, stoppedReason: "push_failed" };
    }
  }

  return { deliveredParts, failedParts, stoppedReason: "complete" };
}

export async function recoverUndeliveredPreviewNotifications(
  supabase: Supabase,
  params: {
    sessionId: string;
    recipientId: string;
    draftRevision: string;
  },
  push: PurchaseCapturePushMessage = pushLineMessage,
): Promise<DeliverPurchaseCaptureNotificationResult> {
  return deliverPurchaseCaptureNotificationParts(
    supabase,
    {
      sessionId: params.sessionId,
      recipientId: params.recipientId,
      notificationKind: "preview_ready",
      notificationVersion: params.draftRevision,
    },
    push,
  );
}
