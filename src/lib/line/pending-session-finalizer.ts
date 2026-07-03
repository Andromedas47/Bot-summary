import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { DailySummaryService } from "@/lib/line/daily-summary-service";
import {
  PendingSessionService,
  type PendingSession,
  type TryFinalizeResult,
} from "@/lib/line/pending-session-service";
import { buildWeighSessionSummary, pushLineMessage } from "@/lib/line/reply";
import {
  computeItemHash,
  computeSessionHash,
} from "@/lib/line/session-dedup-service";
import {
  bangkokTimeFromTimestamp,
  buildWeighSessionValidationReply,
  getWeighSessionFinalizationErrors,
  parseWeighSession,
} from "@/lib/parsers/weigh-session/parser";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { logger } from "@/lib/logger";

type Supabase = SupabaseClient<Database>;
type PushMessage = (to: string, text: string) => Promise<unknown>;

export interface PendingFinalizerRun {
  due: number;
  finalized: number;
  duplicate: number;
  pending: number;
  failedClosed: number;
  staleSnapshot: number;
  skipped: number;
  errors: number;
}

const defaultPush: PushMessage = (to, text) => pushLineMessage(to, text);

export function formatMissingItemNumbers(missing: number[]): string {
  return missing.join(", ");
}

export function findMissingItemNumbers(
  expectedCount: number,
  observedItemNumbers: number[],
): number[] {
  const observed = new Set(observedItemNumbers);
  return Array.from(
    { length: Math.max(0, expectedCount) },
    (_, index) => index + 1,
  ).filter((itemNumber) => !observed.has(itemNumber));
}

export function buildMissingItemsMessage(
  missing: number[],
  failedClosed = false,
): string {
  const numbers = formatMissingItemNumbers(missing);
  return failedClosed
    ? `หมดเวลารอและรายการยังไม่ครบ ขาดหมายเลข ${numbers} จึงไม่บันทึกรายการ`
    : `ยังปิดรายการไม่ได้ ขาดหมายเลข ${numbers} ระบบจะรอรายการที่ส่งค้างอยู่`;
}

function hasHeaderInLedger(session: PendingSession, rows: Array<{ raw_text: string }>): boolean {
  const normalizeHeader = (line: string) => line
    .replace(/^\d{1,2}[:.]\d{2}\s+\S+\s+/, "")
    .trim()
    .replace(/\s+/g, " ");
  const expectedHeader = session.accumulated_text
    .split("\n")
    .find((line) => line.trim() !== "");
  if (!expectedHeader) return false;

  return rows.some((row) =>
    row.raw_text.split("\n").some((line) => {
      const normalized = normalizeHeader(line);
      return normalized === normalizeHeader(expectedHeader)
        && !RE.SESSION_END.test(normalized)
        && RE.SESSION_START.test(normalized);
    }));
}

async function findCloseRawMessageId(
  supabase: Supabase,
  session: PendingSession,
): Promise<string | null> {
  if (!session.close_line_event_id) return null;
  const { data, error } = await supabase
    .from("raw_messages")
    .select("id")
    .eq("line_event_id", session.close_line_event_id)
    .maybeSingle();
  if (error) throw new Error(`close raw message lookup failed: ${error.message}`);
  return data?.id ?? null;
}

export async function finalizePendingGeneration(
  supabase: Supabase,
  snapshot: PendingSession,
  push: PushMessage = defaultPush,
): Promise<TryFinalizeResult> {
  const finalizationStartedAt = new Date().toISOString();
  const correlationId = `${snapshot.session_key}:${snapshot.session_generation}`;
  const log = logger.child({
    correlationId,
    sessionKey: snapshot.session_key,
    sessionGeneration: snapshot.session_generation,
    ingestRevision: snapshot.ingest_revision,
  });
  const service = new PendingSessionService(supabase);
  const closeTimestamp = snapshot.close_event_timestamp_ms;

  if (closeTimestamp === null || snapshot.close_session_generation === null) {
    return { status: "skipped", reason: "not_closing" };
  }

  log.info("produce finalization started", {
    closeRequestedAt: snapshot.close_requested_at,
    closeEventTimestampMs: closeTimestamp,
    nextAttemptAt: snapshot.next_attempt_at,
    closeDeadlineAt: snapshot.close_deadline_at,
    finalizationStartedAt,
  });
  let finalText = snapshot.accumulated_text;
  const reconstructionErrors: string[] = [];
  try {
    const ingestRows = await service.loadIngestRows(
      snapshot.session_key,
      snapshot.session_generation,
      closeTimestamp,
    );
    if (hasHeaderInLedger(snapshot, ingestRows)) {
      finalText = ingestRows.map((row) => row.raw_text).join("\n");
    } else {
      finalText = await service.rebuildForFinalization(snapshot, closeTimestamp);
    }
  } catch (error) {
    reconstructionErrors.push(
      error instanceof Error ? error.message : "session reconstruction failed",
    );
  }

  const fallbackTime = bangkokTimeFromTimestamp(
    new Date(snapshot.created_at).getTime(),
  );
  const parsed = parseWeighSession(finalText, bangkokBusinessDateNow(), fallbackTime);
  const validationErrors = [
    ...reconstructionErrors,
    ...getWeighSessionFinalizationErrors(parsed),
  ];
  const rawMessageId = await findCloseRawMessageId(supabase, snapshot);
  if (!rawMessageId) validationErrors.push("close raw message was not found");

  const transactionTypes = [...new Set(
    parsed.items.map((item) => item.transaction_type),
  )].sort().join(",");
  const sessionPayload: Record<string, unknown> = {
    raw_message_id: rawMessageId,
    staff_name: parsed.staff_name,
    sender_name: parsed.sender_name,
    transaction_time: parsed.transaction_time,
    session_date: parsed.date,
    session_title: parsed.session_title,
    transaction_types: transactionTypes,
    validation_errors: validationErrors,
    finalization_started_at: finalizationStartedAt,
    notification_payload: buildWeighSessionSummary(parsed),
    notification_source_id: snapshot.source_id,
    correlation_id: correlationId,
  };
  const itemPayload = parsed.items.map((item) => ({
    ...item,
    item_hash: computeItemHash(parsed, item),
  }));

  const result = await service.tryFinalizeGeneration(
    snapshot.session_key,
    snapshot.session_generation,
    snapshot.line_user_id,
    snapshot.ingest_revision,
    computeSessionHash(parsed),
    finalText,
    sessionPayload,
    itemPayload,
  );


  log.info("produce finalization completed", {
    status: result.status,
    reason: result.reason ?? null,
    produceSessionId: result.session_id ?? null,
    finalizedAt: new Date().toISOString(),
  });
  let message: string | null = null;
  if (result.status === "pending" && result.reason === "missing_items") {
    message = buildMissingItemsMessage(result.missing ?? []);
  } else if (result.status === "failed_closed") {
    message = result.reason === "missing_items"
      ? buildMissingItemsMessage(result.missing ?? [], true)
      : buildWeighSessionValidationReply(parsed);
  } else if (result.status === "finalized" && !result.notification_id) {
    // Rolling-deploy fallback: the pre-0034 RPC cannot create an outbox row.
    // Once 0034 is installed, notification_id is always returned and success
    // delivery is handled exclusively by the durable worker.
    log.warn("produce notification outbox unavailable; using direct push fallback");
    message = buildWeighSessionSummary(parsed);
  } else if (result.status === "duplicate") {
    message = "รายการนี้เคยบันทึกแล้ว";
  }

  if (message) {
    try {
      await push(snapshot.source_id, message);
    } catch (error) {
      // Validation and duplicate notices are best-effort. Successful-session
      // summaries are handled only by the durable notification outbox.
      log.error("produce finalizer LINE push failed", {
        status: result.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.status === "finalized") {
    try {
      await new DailySummaryService(supabase).recalculate(
        parsed.date ?? bangkokBusinessDateNow(),
        parsed.staff_name,
        parsed.session_title,
      );
    } catch (error) {
      log.error("daily summary recalculation failed after produce finalization", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export async function finalizeDuePendingGenerations(
  supabase: Supabase,
  push: PushMessage = defaultPush,
  limit = 25,
): Promise<PendingFinalizerRun> {
  // pending_sessions is part of the production baseline described by migration
  // 0031 but is not represented in the hand-maintained Database type yet.
  const { data, error } = await (supabase as SupabaseClient)
    .from("pending_sessions")
    .select("*")
    .eq("terminalized", false)
    .not("next_attempt_at", "is", null)
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`due pending session lookup failed: ${error.message}`);
  const due = (data ?? []) as unknown as PendingSession[];
  const run: PendingFinalizerRun = {
    due: due.length,
    finalized: 0,
    duplicate: 0,
    pending: 0,
    failedClosed: 0,
    staleSnapshot: 0,
    skipped: 0,
    errors: 0,
  };

  for (const snapshot of due) {
    try {
      const result = await finalizePendingGeneration(supabase, snapshot, push);
      if (result.status === "finalized") run.finalized += 1;
      else if (result.status === "duplicate") run.duplicate += 1;
      else if (result.status === "pending") run.pending += 1;
      else if (result.status === "failed_closed") run.failedClosed += 1;
      else if (result.status === "stale_snapshot") run.staleSnapshot += 1;
      else run.skipped += 1;
    } catch (finalizeError) {
      run.errors += 1;
      logger.error("due pending produce finalization failed", {
        sessionKey: snapshot.session_key,
        sessionGeneration: snapshot.session_generation,
        error: finalizeError instanceof Error
          ? finalizeError.message
          : String(finalizeError),
      });
    }
  }

  return run;
}
