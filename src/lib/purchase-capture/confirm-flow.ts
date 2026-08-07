/**
 * P2C Slice C2 — purchase-capture confirmation orchestration.
 *
 * The single place that drives a session through
 * `awaiting_confirmation -> confirming -> posted`:
 *   1. begin_purchase_capture_confirmation (fresh path only — the authoritative
 *      blocking-blocker gate; never re-run on recovery)
 *   2. confirm_purchase_receipt (freezes the P2B document; idempotent replay)
 *   3. post_purchase_receipt_inventory_movement (writes the P2C ledger; idempotent replay)
 *   4. complete_purchase_capture_posting (creates posted_success outbox parts and
 *      transitions confirming -> posted with the movement id, atomically)
 *   5. best-effort inline delivery of the posted_success notification parts
 *
 * Refusals (a business rule declined the confirmation) are RETURNED as
 * `{ outcome: "refused", ... }`. Only genuinely unexpected infrastructure
 * failures propagate as thrown Errors — a caller that only handles the
 * returned union has handled every documented business outcome.
 *
 * Money/stock-critical: read supabase/migrations/20260805160000_purchase_capture_confirm_post.sql
 * before changing any ordering or error-mapping decision here — it is the
 * authority this module wraps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import {
  PurchaseCaptureBlockingBlockerError,
  PurchaseCaptureEmptyReceiptError,
  PurchaseCaptureGenerationConflictError,
  PurchaseCaptureInvalidMovementError,
  PurchaseCaptureInvalidStateError,
  PurchaseCaptureOwnershipMismatchError,
  PurchaseCaptureReceiptBindingMismatchError,
  PurchaseCaptureReceiptNotDraftError,
  PurchaseCaptureSessionService,
  PurchaseCaptureStaleRevisionError,
  type PurchaseCaptureSessionRow,
  type PurchaseCaptureSessionStatus,
} from "./session-service";
import {
  PurchaseReceiptConfirmationConflictError,
  PurchaseReceiptLifecycleError,
  PurchaseReceiptNotFoundError,
  PurchaseReceiptService,
  PurchaseReceiptStaleRevisionError,
} from "@/lib/purchase-receipts/receipt-service";
import {
  InventoryDuplicateSourceError,
  InventoryInvalidLifecycleError,
  InventoryLedgerService,
  InventoryNotFoundError,
  InventorySourceBlockedError,
  InventoryUnresolvedIdentityError,
} from "@/lib/inventory-ledger/ledger-service";
import { renderPurchaseCapturePostedSuccessPayloadTexts } from "./posted-success";
import {
  deliverPurchaseCaptureNotificationParts,
  type PurchaseCapturePushMessage,
} from "./notification-push-worker";
import { PurchaseCaptureNotificationIdentityConflictError } from "./notification-service";

type Supabase = SupabaseClient<Database>;

/** Namespace prefix for the P2B confirmationKey derived from a session's opening LINE event. */
export const PURCHASE_CAPTURE_CONFIRMATION_KEY_PREFIX = "purchase-capture:v1:";

/**
 * Derives the P2B `confirmationKey` from the LINE event that opened the
 * session. Stable and deterministic: the same opening event always yields the
 * same confirmation key, which is what makes confirm_purchase_receipt's
 * idempotent replay work across retries and cron recovery.
 */
export function purchaseCaptureConfirmationKey(openedLineEventId: string): string {
  const trimmed = (openedLineEventId ?? "").trim();
  if (!trimmed) throw new Error("opened_line_event_id required");
  return `${PURCHASE_CAPTURE_CONFIRMATION_KEY_PREFIX}${trimmed}`;
}

/** Canonical actor string recorded on every P2C write this flow performs. */
export function purchaseCaptureActor(senderLineUserId: string): string {
  return `line:${senderLineUserId}`;
}

export type PurchaseCaptureConfirmFailureCode =
  | "ownership_mismatch"
  | "generation_conflict"
  | "invalid_state"
  | "stale_revision"
  | "receipt_not_draft"
  | "receipt_binding_mismatch"
  | "blocking_blocker_present"
  | "empty_receipt"
  | "invalid_movement"
  | "notification_identity_conflict"
  | "session_not_found"
  | "receipt_not_bound";

export type PurchaseCaptureRecoveryStage = "fresh" | "confirming" | "posted_replay";

export type PurchaseCaptureConfirmResult =
  | {
      outcome: "posted";
      sessionId: string;
      receiptId: string;
      draftRevision: string;
      movementId: string;
      replayed: boolean;
      recoveryStage: PurchaseCaptureRecoveryStage;
      deliveredParts: number;
      failedParts: number;
    }
  | {
      outcome: "refused";
      sessionId: string;
      code: PurchaseCaptureConfirmFailureCode;
      message: string;
      recoveryStage: PurchaseCaptureRecoveryStage;
    };

function refusal(
  sessionId: string,
  code: PurchaseCaptureConfirmFailureCode,
  recoveryStage: PurchaseCaptureRecoveryStage,
  message?: string,
): PurchaseCaptureConfirmResult {
  return { outcome: "refused", sessionId, code, message: message ?? code, recoveryStage };
}

function stageFromStatus(status: PurchaseCaptureSessionStatus): PurchaseCaptureRecoveryStage {
  if (status === "confirming") return "confirming";
  if (status === "posted") return "posted_replay";
  return "fresh";
}

/**
 * Maps a thrown error from any step (begin_*, confirm, post, complete_*) to a
 * structured failure code, or `null` when the error is unrecognised and must
 * propagate as a thrown Error (an unexpected infrastructure fault must never
 * masquerade as a documented business refusal).
 */
function mapErrorToFailureCode(error: unknown): PurchaseCaptureConfirmFailureCode | null {
  if (error instanceof PurchaseCaptureOwnershipMismatchError) return "ownership_mismatch";
  if (error instanceof PurchaseCaptureGenerationConflictError) return "generation_conflict";
  if (error instanceof PurchaseCaptureStaleRevisionError) return "stale_revision";
  if (error instanceof PurchaseCaptureReceiptNotDraftError) return "receipt_not_draft";
  if (error instanceof PurchaseCaptureReceiptBindingMismatchError) return "receipt_binding_mismatch";
  if (error instanceof PurchaseCaptureBlockingBlockerError) return "blocking_blocker_present";
  if (error instanceof PurchaseCaptureEmptyReceiptError) return "empty_receipt";
  if (error instanceof PurchaseCaptureInvalidMovementError) return "invalid_movement";
  if (error instanceof PurchaseCaptureInvalidStateError) return "invalid_state";

  if (error instanceof PurchaseReceiptStaleRevisionError) return "stale_revision";
  if (error instanceof PurchaseReceiptConfirmationConflictError) return "invalid_state";
  if (error instanceof PurchaseReceiptLifecycleError) return "receipt_not_draft";
  if (error instanceof PurchaseReceiptNotFoundError) return "receipt_not_bound";

  if (error instanceof InventoryUnresolvedIdentityError) return "blocking_blocker_present";
  if (error instanceof InventorySourceBlockedError) return "blocking_blocker_present";
  if (error instanceof InventoryInvalidLifecycleError) return "invalid_state";
  if (error instanceof InventoryDuplicateSourceError) return "invalid_movement";
  if (error instanceof InventoryNotFoundError) return "receipt_not_bound";

  if (error instanceof PurchaseCaptureNotificationIdentityConflictError) {
    return "notification_identity_conflict";
  }
  // complete_purchase_capture_posting's notification_identity_conflict surfaces through
  // session-service's generic RPC-failure Error (mapRpcError has no dedicated class for
  // it), so it must also be recognised by message text.
  if (error instanceof Error && error.message.includes("notification_identity_conflict")) {
    return "notification_identity_conflict";
  }

  return null;
}

type Logger = ReturnType<typeof logger.child>;

function logRefusal(
  log: Logger,
  sessionId: string,
  code: PurchaseCaptureConfirmFailureCode,
  recoveryStage: PurchaseCaptureRecoveryStage,
  message?: string,
  extra?: Record<string, unknown>,
): PurchaseCaptureConfirmResult {
  log.warn("purchase_capture_confirm_refused", {
    sessionId,
    recoveryStage,
    code,
    ...extra,
  });
  return refusal(sessionId, code, recoveryStage, message);
}

/** Maps a thrown error to a refusal result, or rethrows when it is unrecognised. */
function handleRefusalOrThrow(
  log: Logger,
  error: unknown,
  sessionId: string,
  recoveryStage: PurchaseCaptureRecoveryStage,
  extra?: Record<string, unknown>,
): PurchaseCaptureConfirmResult {
  const code = mapErrorToFailureCode(error);
  if (code == null) throw error;
  const message = error instanceof Error ? error.message : String(error);
  return logRefusal(log, sessionId, code, recoveryStage, message, extra);
}

/**
 * Step 6-7 shared tail: deliver the posted_success notification inline
 * (best-effort — a delivery failure never changes the outcome, since the
 * session is already durably 'posted' and the outbox parts are durable) and
 * log + return the final "posted" result.
 */
async function finishPosted(
  supabase: Supabase,
  push: PurchaseCapturePushMessage,
  log: Logger,
  params: {
    session: PurchaseCaptureSessionRow;
    receiptId: string;
    draftRevision: string;
    movementId: string;
    replayed: boolean;
    recoveryStage: PurchaseCaptureRecoveryStage;
    deliverNotifications: boolean;
  },
): Promise<PurchaseCaptureConfirmResult> {
  const { session, receiptId, draftRevision, movementId, replayed, recoveryStage } = params;

  let deliveredParts = 0;
  let failedParts = 0;

  if (params.deliverNotifications) {
    try {
      const delivery = await deliverPurchaseCaptureNotificationParts(
        supabase,
        {
          sessionId: session.id,
          recipientId: session.source_id,
          notificationKind: "posted_success",
          notificationVersion: movementId,
        },
        push,
      );
      deliveredParts = delivery.deliveredParts;
      failedParts = delivery.failedParts;
    } catch (error) {
      log.warn("purchase_capture_posted_notification_delivery_failed", {
        sessionId: session.id,
        receiptId,
        movementId,
        error: error instanceof Error ? error.message : String(error),
      });
      deliveredParts = 0;
      failedParts = 0;
    }
  }

  log.info("purchase_capture_confirm_posted", {
    sessionId: session.id,
    receiptId,
    draftRevision,
    movementId,
    replayed,
    recoveryStage,
    notificationKind: "posted_success",
    deliveredParts,
    failedParts,
  });

  return {
    outcome: "posted",
    sessionId: session.id,
    receiptId,
    draftRevision,
    movementId,
    replayed,
    recoveryStage,
    deliveredParts,
    failedParts,
  };
}

/** Step 3 ("posted") — replay path. Never calls begin_*, confirm(), or postPurchaseReceipt(). */
async function runPostedReplay(
  supabase: Supabase,
  sessionService: PurchaseCaptureSessionService,
  receiptService: PurchaseReceiptService,
  push: PurchaseCapturePushMessage,
  log: Logger,
  session: PurchaseCaptureSessionRow,
  deliverNotifications: boolean,
): Promise<PurchaseCaptureConfirmResult> {
  const stage: PurchaseCaptureRecoveryStage = "posted_replay";
  const receiptId = session.receipt_id as string;
  const movementId = session.movement_id as string;
  const actor = purchaseCaptureActor(session.sender_line_user_id);
  const draftRevision = session.draft_revision == null ? "" : String(session.draft_revision);

  let confirmation;
  try {
    confirmation = await receiptService.getConfirmation(receiptId);
  } catch (error) {
    return handleRefusalOrThrow(log, error, session.id, stage, { receiptId });
  }

  const texts = renderPurchaseCapturePostedSuccessPayloadTexts({
    payload: confirmation.confirmation.payload,
    movementId,
  });

  let completed;
  try {
    completed = await sessionService.completePosting({
      sessionId: session.id,
      expectedGeneration: session.session_generation,
      movementId,
      postedSuccessPayloadTexts: texts,
      actor,
    });
  } catch (error) {
    return handleRefusalOrThrow(log, error, session.id, stage, { receiptId, movementId });
  }

  return finishPosted(supabase, push, log, {
    session,
    receiptId,
    draftRevision,
    movementId: completed.movementId,
    replayed: true,
    recoveryStage: stage,
    deliverNotifications,
  });
}

async function runShared(
  supabase: Supabase,
  params: {
    sessionId: string;
    expectedSourceType: "user" | "group" | "room";
    expectedSourceId: string;
    expectedSenderLineUserId: string;
    deliverNotifications?: boolean;
  },
  push: PurchaseCapturePushMessage,
  allowFreshBegin: boolean,
): Promise<PurchaseCaptureConfirmResult> {
  const sessionService = new PurchaseCaptureSessionService(supabase);
  const receiptService = new PurchaseReceiptService(supabase);
  const ledgerService = new InventoryLedgerService(supabase);
  const log = logger.child({ sessionId: params.sessionId });
  const deliverNotifications = params.deliverNotifications !== false;

  const session = await sessionService.getSession(params.sessionId);
  if (!session) {
    return logRefusal(log, params.sessionId, "session_not_found", "fresh");
  }

  if (
    session.source_type !== params.expectedSourceType
    || session.source_id !== params.expectedSourceId
    || session.sender_line_user_id !== params.expectedSenderLineUserId
  ) {
    return logRefusal(log, session.id, "ownership_mismatch", stageFromStatus(session.status));
  }

  if (session.status === "posted") {
    if (!session.movement_id || !session.receipt_id) {
      return logRefusal(log, session.id, "invalid_state", "posted_replay");
    }
    return runPostedReplay(
      supabase,
      sessionService,
      receiptService,
      push,
      log,
      session,
      deliverNotifications,
    );
  }

  let receiptId: string;
  let draftRevision: string | null;
  let generation: string;
  let stage: PurchaseCaptureRecoveryStage;

  if (session.status === "awaiting_confirmation") {
    stage = "fresh";
    if (!allowFreshBegin) {
      return logRefusal(log, session.id, "invalid_state", stage);
    }
    if (!session.receipt_id || session.draft_revision == null) {
      return logRefusal(log, session.id, "receipt_not_bound", stage);
    }

    let begun;
    try {
      begun = await sessionService.beginConfirmation({
        sessionId: session.id,
        expectedGeneration: session.session_generation,
        expectedReceiptId: session.receipt_id,
        expectedDraftRevision: String(session.draft_revision),
        expectedSourceType: params.expectedSourceType,
        expectedSourceId: params.expectedSourceId,
        expectedSenderLineUserId: params.expectedSenderLineUserId,
        actor: purchaseCaptureActor(session.sender_line_user_id),
      });
    } catch (error) {
      return handleRefusalOrThrow(log, error, session.id, stage);
    }

    receiptId = begun.receiptId;
    draftRevision = begun.draftRevision;
    generation = session.session_generation;
  } else if (session.status === "confirming") {
    stage = "confirming";
    if (!session.receipt_id) {
      return logRefusal(log, session.id, "receipt_not_bound", stage);
    }
    receiptId = session.receipt_id;
    draftRevision = session.draft_revision == null ? null : String(session.draft_revision);
    generation = session.session_generation;
  } else {
    // "open" | "closing" | "cancelled" | "failed_closed"
    return logRefusal(log, session.id, "invalid_state", "fresh");
  }

  // Step 4: confirm the frozen P2B document (idempotent on confirmationKey).
  const confirmationKey = purchaseCaptureConfirmationKey(session.opened_line_event_id);
  const actor = purchaseCaptureActor(session.sender_line_user_id);

  let confirmation;
  try {
    confirmation = await receiptService.confirm({
      receiptId,
      confirmationKey,
      expectedDraftRevision: draftRevision,
      actor,
    });
  } catch (error) {
    return handleRefusalOrThrow(log, error, session.id, stage, { receiptId });
  }

  // Step 5: post into the inventory ledger (idempotent on the receipt's frozen content).
  let posting;
  try {
    posting = await ledgerService.postPurchaseReceipt({ receiptId, actor });
  } catch (error) {
    return handleRefusalOrThrow(log, error, session.id, stage, { receiptId });
  }

  // A replayed posting whose movement has since been REVERSED contributes
  // nothing to the current balance, so "posted" here would overstate the
  // stock on hand. Nothing in P2C reverses a movement yet, so this cannot
  // happen today — surface it loudly rather than let a future reversal path
  // silently confirm a net-zero receipt as stocked.
  if (posting.reversedByMovementId != null) {
    log.warn("purchase_capture_posted_movement_already_reversed", {
      sessionId: session.id,
      receiptId,
      movementId: posting.movementId,
      reversedByMovementId: posting.reversedByMovementId,
      recoveryStage: stage,
    });
  }

  const texts = renderPurchaseCapturePostedSuccessPayloadTexts({
    payload: confirmation.confirmation.payload,
    movementId: posting.movementId,
  });

  let completed;
  try {
    completed = await sessionService.completePosting({
      sessionId: session.id,
      expectedGeneration: generation,
      movementId: posting.movementId,
      postedSuccessPayloadTexts: texts,
      actor,
    });
  } catch (error) {
    return handleRefusalOrThrow(log, error, session.id, stage, {
      receiptId,
      movementId: posting.movementId,
    });
  }

  return finishPosted(supabase, push, log, {
    session,
    receiptId,
    draftRevision: draftRevision ?? "",
    movementId: completed.movementId,
    replayed: posting.replayed,
    recoveryStage: stage,
    deliverNotifications,
  });
}

/**
 * Runs (or replays) the purchase-capture confirmation for one session.
 *
 * Safe to call for the fresh confirm path (`awaiting_confirmation`), for cron
 * recovery of a session left `confirming` after a crash, and for replaying a
 * session that is already `posted` — the outcome and posted_success text are
 * byte-identical across all three.
 */
export async function runPurchaseCaptureConfirmation(
  supabase: Supabase,
  params: {
    sessionId: string;
    /** Ownership as observed on THIS request (LINE event), never read from the session row. */
    expectedSourceType: "user" | "group" | "room";
    expectedSourceId: string;
    expectedSenderLineUserId: string;
    /** Deliver posted_success parts inline after complete_*. Default true. */
    deliverNotifications?: boolean;
  },
  push: PurchaseCapturePushMessage = pushLineMessage,
): Promise<PurchaseCaptureConfirmResult> {
  return runShared(supabase, params, push, true);
}

/** Fresh path from the LINE webhook. Identical to {@link runPurchaseCaptureConfirmation}. */
export const confirmPurchaseCaptureFromLine = runPurchaseCaptureConfirmation;

/**
 * Recovery path from cron. MUST refuse `invalid_state` on an
 * `awaiting_confirmation` session rather than calling begin_* — recovery only
 * ever resumes a session that already crossed the confirm gate (`confirming`)
 * or finishes delivering a session that already reached `posted`.
 */
export async function resumePurchaseCaptureConfirmation(
  supabase: Supabase,
  params: {
    sessionId: string;
    expectedSourceType: "user" | "group" | "room";
    expectedSourceId: string;
    expectedSenderLineUserId: string;
    deliverNotifications?: boolean;
  },
  push: PurchaseCapturePushMessage = pushLineMessage,
): Promise<PurchaseCaptureConfirmResult> {
  return runShared(supabase, params, push, false);
}
