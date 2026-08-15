import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { replyLineMessage } from "@/lib/line/reply";
import { PendingSessionService } from "@/lib/line/pending-session-service";

export const NEW_HEADER_REQUIRED_REPLY =
  "ไม่พบรายการที่เปิดอยู่ กรุณาพิมพ์หัวรายการใหม่ก่อนส่งรายการ";

export interface DeferredProduceSweepResult {
  claimed: number;
  replied: number;
  replyErrors: number;
}

type Reply = (replyToken: string, text: string) => Promise<void>;

/**
 * Resolve the bounded reorder window before the close finalizer runs.
 * Rejected rows remain unprocessed and durable for Daily Close evidence.
 */
export async function processExpiredPendingProduceEvents(
  supabase: SupabaseClient<Database>,
  reply: Reply = replyLineMessage,
  limit = 25,
): Promise<DeferredProduceSweepResult> {
  const events = await new PendingSessionService(supabase)
    .claimExpiredDeferredProduceEvents(limit);
  const result: DeferredProduceSweepResult = {
    claimed: events.length,
    replied: 0,
    replyErrors: 0,
  };

  for (const event of events) {
    logger.warn("deferred Produce item rejected after reorder window", {
      action: event.status,
      reason: event.defer_reason,
      sourceId: event.source_id,
      lineUserId: event.line_user_id,
      lineEventId: event.line_event_id,
      lineTimestampMs: event.line_timestamp_ms,
      sessionKey: event.session_key,
      sessionGeneration: event.session_generation,
      openerEventId: event.opener_line_event_id,
      openerTimestampMs: event.opener_line_timestamp_ms,
      closeEventId: event.close_line_event_id,
      closeTimestampMs: event.close_line_timestamp_ms,
      ageMs: Date.parse(event.resolved_at) - Date.parse(event.received_at),
      rawText: event.raw_text,
    });
    if (!event.reply_token) continue;
    try {
      await reply(event.reply_token, NEW_HEADER_REQUIRED_REPLY);
      result.replied += 1;
    } catch (error) {
      result.replyErrors += 1;
      logger.error("deferred Produce orphan reply failed", {
        lineEventId: event.line_event_id,
        sessionKey: event.session_key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
