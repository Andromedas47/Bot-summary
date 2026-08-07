/**
 * P2C Slice C3 — LINE command/webhook routing for Purchase Capture
 * (plan §8.4 one-message open+close, §11.3, §12, §13 state table).
 *
 * Cross-feature safety contract: Purchase Capture may claim an incoming LINE
 * text message ONLY when the text itself carries purchase-reserved grammar
 * (a first non-blank line starting with one of เริ่มซื้อ / ซื้อรายการ /
 * สรุปค่าใช้จ่ายซื้อ / ปิดซื้อ) or is one of the three exact commands below.
 * It must NEVER claim arbitrary text merely because a purchase session
 * happens to be open — that is exactly how Produce, Physical Inventory,
 * Manual Slip, Settlement, or White Sheet messages would get stolen.
 * Everything else returns `null` ("not mine") so webhook-service.ts keeps
 * routing to those features unchanged.
 *
 * All durable multi-part content (preview, posted_success) goes through the
 * existing outbox + deliverPurchaseCaptureNotificationParts Push worker ONLY.
 * `replyTexts` returned from this module are short ephemeral acknowledgements
 * only — this file never calls pushLineMessage directly; it takes `push` as
 * an injected parameter and forwards it to the delegated flows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import {
  classifyPurchaseFirstLine,
  startsWithPurchaseReservedPrefix,
} from "@/lib/purchases/classify";
import { isPurchaseCaptureWebhookEnabled } from "./config";
import {
  PurchaseCaptureInvalidStateError,
  PurchaseCaptureSessionService,
  PurchaseCaptureStaleRevisionError,
  type PurchaseCaptureIngestKind,
  type PurchaseCaptureSessionRow,
} from "./session-service";
import {
  confirmPurchaseCaptureFromLine,
  type PurchaseCaptureConfirmFailureCode,
} from "./confirm-flow";
import { replacePurchaseCaptureDraftFromIngests } from "./finalizer";
import {
  deliverPurchaseCaptureNotificationParts,
  type PurchaseCapturePushMessage,
} from "./notification-push-worker";

type Supabase = SupabaseClient<Database>;

export const PURCHASE_CAPTURE_CONFIRM_COMMAND = "ยืนยันซื้อ";
export const PURCHASE_CAPTURE_RECHECK_COMMAND = "ตรวจใบซื้อใหม่";
export const PURCHASE_CAPTURE_CANCEL_COMMAND  = "ยกเลิกซื้อ";

export type PurchaseCaptureWebhookCommand = "confirm" | "recheck" | "cancel";

const GENERIC_FAILURE_REPLY = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";

/** Exact normalized match ONLY. NFC-normalize + trim; no prefix/substring/fuzzy matching. */
export function classifyPurchaseCaptureCommand(
  text: string,
): PurchaseCaptureWebhookCommand | null {
  const normalized = text.normalize("NFC").trim();
  if (normalized === PURCHASE_CAPTURE_CONFIRM_COMMAND) return "confirm";
  if (normalized === PURCHASE_CAPTURE_RECHECK_COMMAND) return "recheck";
  if (normalized === PURCHASE_CAPTURE_CANCEL_COMMAND) return "cancel";
  return null;
}

function splitNonBlankLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.normalize("NFC").trim())
    .filter((line) => line.length > 0);
}

/** True when the text's first non-blank line is a recognized purchase block opener. */
export function containsPurchaseBlock(text: string): boolean {
  const [firstNonBlank] = splitNonBlankLines(text);
  if (!firstNonBlank) return false;
  return startsWithPurchaseReservedPrefix(firstNonBlank);
}

function mapIngestKind(firstNonBlankLine: string): PurchaseCaptureIngestKind {
  const classification = classifyPurchaseFirstLine(firstNonBlankLine);
  if (classification === "HEADER") return "header";
  if (classification === "ITEM") return "item";
  if (classification === "COSTS") return "costs";
  if (classification === "CLOSE") return "close";
  return "other";
}

function messageContainsCloseBlock(nonBlankLines: readonly string[]): boolean {
  return nonBlankLines.some((line) => classifyPurchaseFirstLine(line) === "CLOSE");
}

export type PurchaseCaptureWebhookOutcome = {
  handled: true;
  parsed: boolean;
  action: string;
  replyTexts: string[];
  sessionId?: string;
};

function outcome(params: {
  action: string;
  replyTexts: string[];
  sessionId?: string;
  parsed: boolean;
}): PurchaseCaptureWebhookOutcome {
  return {
    handled: true,
    parsed: params.parsed,
    action: params.action,
    replyTexts: params.replyTexts,
    sessionId: params.sessionId,
  };
}

/** Thai wording for a confirm-flow refusal code. Never mentions cost/money. */
function wordRefusal(code: PurchaseCaptureConfirmFailureCode): string {
  switch (code) {
    case "blocking_blocker_present":
      return "มีรายการที่ต้องแก้ไขก่อนยืนยัน กรุณาตรวจสอบสรุปล่าสุด";
    case "empty_receipt":
      return "ใบซื้อนี้ไม่มีรายการสินค้า ไม่สามารถยืนยันได้";
    case "stale_revision":
      return "ข้อมูลมีการเปลี่ยนแปลง กรุณาตรวจสอบใหม่ก่อนยืนยัน";
    default:
      return "ไม่สามารถยืนยันใบซื้อได้ กรุณาลองใหม่อีกครั้ง";
  }
}

type Logger = ReturnType<typeof logger.child>;

function logFailure(
  log: Logger,
  action: string,
  code: string,
  sessionId: string | undefined,
  error: unknown,
) {
  log.error("purchase_capture_webhook_failure", {
    sessionId,
    action,
    code,
    error: error instanceof Error ? error.message : String(error),
  });
}

type Ownership = {
  expectedSourceType: "user" | "group" | "room";
  expectedSourceId: string;
  expectedSenderLineUserId: string;
};

async function handleContent(
  sessionService: PurchaseCaptureSessionService,
  session: PurchaseCaptureSessionRow | null,
  params: {
    sourceType: "user" | "group" | "room";
    sourceId: string;
    senderLineUserId: string;
    lineEventId: string;
    lineTimestampMs: number;
    lineMessageId?: string | null;
    rawMessageId?: string | null;
    text: string;
  },
  ownership: Ownership,
  log: Logger,
): Promise<PurchaseCaptureWebhookOutcome | null> {
  const lines = splitNonBlankLines(params.text);
  const firstLine = lines[0];

  if (!session) {
    const classification = classifyPurchaseFirstLine(firstLine);
    if (classification !== "HEADER") {
      // ITEM/COSTS/CLOSE/INVALID with no session — not ours to answer.
      return null;
    }
    try {
      const opened = await sessionService.openSession({
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        senderLineUserId: params.senderLineUserId,
        openedLineEventId: params.lineEventId,
        lineTimestampMs: params.lineTimestampMs,
        rawText: params.text,
        lineMessageId: params.lineMessageId ?? null,
        rawMessageId: params.rawMessageId ?? null,
      });

      if (messageContainsCloseBlock(lines)) {
        await sessionService.closeOpenEvent({
          sessionId: opened.session.id,
          expectedGeneration: opened.session.session_generation,
          openedLineEventId: params.lineEventId,
          ...ownership,
        });
        return outcome({
          action: "opened_and_closed",
          replyTexts: [],
          sessionId: opened.session.id,
          parsed: true,
        });
      }

      return outcome({
        action: "opened",
        replyTexts: [],
        sessionId: opened.session.id,
        parsed: true,
      });
    } catch (error) {
      logFailure(log, "open", "infra_error", undefined, error);
      return outcome({ action: "open_failed", replyTexts: [GENERIC_FAILURE_REPLY], parsed: false });
    }
  }

  if (session.status === "awaiting_confirmation" || session.status === "confirming") {
    return outcome({
      action: "content_after_close",
      replyTexts: ["ปิดใบซื้อแล้ว กรุณายืนยันหรือยกเลิกใบซื้อนี้ก่อนส่งข้อความใหม่"],
      sessionId: session.id,
      parsed: true,
    });
  }

  // session.status is "open" | "closing"
  const hasClose = messageContainsCloseBlock(lines);
  const kind: PurchaseCaptureIngestKind = hasClose ? "close" : mapIngestKind(firstLine);

  try {
    await sessionService.registerIngest({
      sessionId: session.id,
      expectedGeneration: session.session_generation,
      ...ownership,
      lineEventId: params.lineEventId,
      lineTimestampMs: params.lineTimestampMs,
      lineMessageId: params.lineMessageId ?? null,
      rawMessageId: params.rawMessageId ?? null,
      kind,
      rawText: params.text,
    });
    return outcome({
      action: kind === "close" ? "closed" : "admitted",
      replyTexts: [],
      sessionId: session.id,
      parsed: true,
    });
  } catch (error) {
    logFailure(log, "admit", "infra_error", session.id, error);
    return outcome({
      action: "admit_failed",
      replyTexts: [GENERIC_FAILURE_REPLY],
      sessionId: session.id,
      parsed: false,
    });
  }
}

async function handleConfirm(
  supabase: Supabase,
  session: PurchaseCaptureSessionRow | null,
  latest: PurchaseCaptureSessionRow | null,
  ownership: Ownership,
  push: PurchaseCapturePushMessage,
  log: Logger,
): Promise<PurchaseCaptureWebhookOutcome> {
  if (session) {
    if (session.status === "awaiting_confirmation") {
      try {
        const result = await confirmPurchaseCaptureFromLine(
          supabase,
          { sessionId: session.id, ...ownership },
          push,
        );
        if (result.outcome === "posted") {
          return outcome({ action: "confirmed", replyTexts: [], sessionId: session.id, parsed: true });
        }
        return outcome({
          action: "confirm_refused",
          replyTexts: [wordRefusal(result.code)],
          sessionId: session.id,
          parsed: true,
        });
      } catch (error) {
        logFailure(log, "confirm", "infra_error", session.id, error);
        return outcome({
          action: "confirm_failed",
          replyTexts: [GENERIC_FAILURE_REPLY],
          sessionId: session.id,
          parsed: false,
        });
      }
    }
    if (session.status === "confirming") {
      return outcome({
        action: "confirm_in_progress",
        replyTexts: ["กำลังดำเนินการยืนยันอยู่ กรุณารอสักครู่"],
        sessionId: session.id,
        parsed: true,
      });
    }
    // "open" | "closing"
    return outcome({
      action: "confirm_refused",
      replyTexts: ["ยังไม่ได้ปิดใบซื้อ"],
      sessionId: session.id,
      parsed: true,
    });
  }

  // No open session — latest is guaranteed non-null by the caller's guard.
  const latestSession = latest as PurchaseCaptureSessionRow;
  if (latestSession.status === "posted") {
    try {
      const result = await confirmPurchaseCaptureFromLine(
        supabase,
        { sessionId: latestSession.id, ...ownership },
        push,
      );
      if (result.outcome === "posted") {
        return outcome({
          action: "confirm_replayed",
          replyTexts: [],
          sessionId: latestSession.id,
          parsed: true,
        });
      }
      return outcome({
        action: "confirm_refused",
        replyTexts: [wordRefusal(result.code)],
        sessionId: latestSession.id,
        parsed: true,
      });
    } catch (error) {
      logFailure(log, "confirm_replay", "infra_error", latestSession.id, error);
      return outcome({
        action: "confirm_failed",
        replyTexts: [GENERIC_FAILURE_REPLY],
        sessionId: latestSession.id,
        parsed: false,
      });
    }
  }

  if (latestSession.status === "cancelled" || latestSession.status === "failed_closed") {
    return outcome({
      action: "confirm_refused",
      replyTexts: ["ใบซื้อนี้ถูกยกเลิก/ปิดไปแล้ว"],
      sessionId: latestSession.id,
      parsed: true,
    });
  }

  // Defensive fallback — findOpenSession would already have returned this row.
  return outcome({
    action: "confirm_refused",
    replyTexts: ["ยังไม่ได้ปิดใบซื้อ"],
    sessionId: latestSession.id,
    parsed: true,
  });
}

async function handleRecheck(
  supabase: Supabase,
  session: PurchaseCaptureSessionRow | null,
  latest: PurchaseCaptureSessionRow | null,
  sourceId: string,
  push: PurchaseCapturePushMessage,
  log: Logger,
): Promise<PurchaseCaptureWebhookOutcome> {
  if (
    session
    && session.status === "awaiting_confirmation"
    && session.receipt_id
    && session.draft_revision != null
  ) {
    try {
      const replaced = await replacePurchaseCaptureDraftFromIngests(supabase, {
        session,
        expectedDraftRevision: String(session.draft_revision),
      });
      await deliverPurchaseCaptureNotificationParts(
        supabase,
        {
          sessionId: session.id,
          recipientId: sourceId,
          notificationKind: "preview_ready",
          notificationVersion: replaced.draftRevision,
        },
        push,
      );
      return outcome({
        action: "rechecked",
        replyTexts: ["ตรวจสอบใหม่แล้ว กำลังส่งสรุป"],
        sessionId: session.id,
        parsed: true,
      });
    } catch (error) {
      if (
        error instanceof PurchaseCaptureInvalidStateError
        || error instanceof PurchaseCaptureStaleRevisionError
      ) {
        return outcome({
          action: "recheck_refused",
          replyTexts: ["กรุณาดูสรุปล่าสุด"],
          sessionId: session.id,
          parsed: true,
        });
      }
      logFailure(log, "recheck", "infra_error", session.id, error);
      return outcome({
        action: "recheck_failed",
        replyTexts: [GENERIC_FAILURE_REPLY],
        sessionId: session.id,
        parsed: false,
      });
    }
  }

  const reference = session ?? latest;
  return outcome({
    action: "recheck_refused",
    replyTexts: ["ยังไม่มีสรุปใบซื้อที่ตรวจสอบใหม่ได้ในตอนนี้"],
    sessionId: reference?.id,
    parsed: true,
  });
}

async function handleCancel(
  session: PurchaseCaptureSessionRow | null,
  latest: PurchaseCaptureSessionRow | null,
  ownership: Ownership,
  sessionService: PurchaseCaptureSessionService,
  log: Logger,
): Promise<PurchaseCaptureWebhookOutcome> {
  if (session) {
    if (
      session.status === "open"
      || session.status === "closing"
      || session.status === "awaiting_confirmation"
    ) {
      try {
        await sessionService.cancelSession({
          sessionId: session.id,
          expectedGeneration: session.session_generation,
          ...ownership,
        });
        return outcome({
          action: "cancelled",
          replyTexts: ["ยกเลิกใบซื้อแล้ว"],
          sessionId: session.id,
          parsed: true,
        });
      } catch (error) {
        logFailure(log, "cancel", "infra_error", session.id, error);
        return outcome({
          action: "cancel_failed",
          replyTexts: [GENERIC_FAILURE_REPLY],
          sessionId: session.id,
          parsed: false,
        });
      }
    }
    // "confirming"
    return outcome({
      action: "cancel_refused",
      replyTexts: ["ยืนยันไปแล้ว ไม่สามารถยกเลิกได้"],
      sessionId: session.id,
      parsed: true,
    });
  }

  const latestSession = latest as PurchaseCaptureSessionRow;
  if (latestSession.status === "cancelled") {
    return outcome({
      action: "cancelled",
      replyTexts: ["ยกเลิกใบซื้อแล้ว"],
      sessionId: latestSession.id,
      parsed: true,
    });
  }
  if (latestSession.status === "posted") {
    return outcome({
      action: "cancel_refused",
      replyTexts: ["บันทึกเข้าสต๊อกแล้ว ไม่สามารถยกเลิกได้"],
      sessionId: latestSession.id,
      parsed: true,
    });
  }
  // "failed_closed" or any other terminal-ish state we did not open-gate on.
  return outcome({
    action: "cancel_refused",
    replyTexts: ["ใบซื้อนี้ปิดไปแล้ว ไม่สามารถยกเลิกได้"],
    sessionId: latestSession.id,
    parsed: true,
  });
}

export async function tryHandlePurchaseCaptureMessage(
  supabase: Supabase,
  params: {
    sourceType: "user" | "group" | "room";
    sourceId: string;
    senderLineUserId: string | null;
    lineEventId: string;
    lineTimestampMs: number;
    lineMessageId?: string | null;
    rawMessageId?: string | null;
    text: string;
    enabled?: boolean;
  },
  push: PurchaseCapturePushMessage = pushLineMessage,
): Promise<PurchaseCaptureWebhookOutcome | null> {
  const enabled = params.enabled ?? isPurchaseCaptureWebhookEnabled();
  if (!enabled) return null;

  const senderLineUserId = (params.senderLineUserId ?? "").trim();
  if (!senderLineUserId) return null;

  const command = classifyPurchaseCaptureCommand(params.text);
  const isBlock = containsPurchaseBlock(params.text);
  if (command === null && !isBlock) return null;

  const log = logger.child({ feature: "purchase_capture_webhook" });
  const sessionService = new PurchaseCaptureSessionService(supabase);
  const ownership: Ownership = {
    expectedSourceType: params.sourceType,
    expectedSourceId: params.sourceId,
    expectedSenderLineUserId: senderLineUserId,
  };

  let session: PurchaseCaptureSessionRow | null;
  try {
    session = await sessionService.findOpenSession(params.sourceId, senderLineUserId);
  } catch (error) {
    logFailure(log, "lookup", "infra_error", undefined, error);
    return outcome({ action: "lookup_failed", replyTexts: [GENERIC_FAILURE_REPLY], parsed: false });
  }

  if (command === null) {
    // isBlock is guaranteed true here by the claim gate above.
    return handleContent(
      sessionService,
      session,
      {
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        senderLineUserId,
        lineEventId: params.lineEventId,
        lineTimestampMs: params.lineTimestampMs,
        lineMessageId: params.lineMessageId,
        rawMessageId: params.rawMessageId,
        text: params.text,
      },
      ownership,
      log,
    );
  }

  // Exact command match. Additional guard: no session anywhere at all -> not ours.
  let latest: PurchaseCaptureSessionRow | null = session;
  if (!session) {
    try {
      latest = await sessionService.findLatestSession(params.sourceId, senderLineUserId);
    } catch (error) {
      logFailure(log, "lookup_latest", "infra_error", undefined, error);
      return outcome({ action: "lookup_failed", replyTexts: [GENERIC_FAILURE_REPLY], parsed: false });
    }
    if (!latest) return null;
  }

  if (command === "confirm") {
    return handleConfirm(supabase, session, latest, ownership, push, log);
  }
  if (command === "recheck") {
    return handleRecheck(supabase, session, latest, params.sourceId, push, log);
  }
  // command === "cancel"
  return handleCancel(session, latest, ownership, sessionService, log);
}
