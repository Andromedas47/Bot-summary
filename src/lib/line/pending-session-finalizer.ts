import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { DailySummaryService } from "@/lib/line/daily-summary-service";
import {
  PendingSessionService,
  type PendingSession,
  type TryFinalizeResult,
} from "@/lib/line/pending-session-service";
import {
  buildAdditionalSessionSummary,
  buildWeighSessionSummary,
  pushLineMessage,
  weighItemTotal,
  type AdditionalSessionDayContext,
} from "@/lib/line/reply";
import { baseTransactionType } from "@/lib/summary/transactions";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import {
  computeItemHash,
  computeSessionHash,
} from "@/lib/line/session-dedup-service";
import { buildSeedFromStructuredMetadata } from "@/lib/parsers/weigh-session/seed";
import {
  produceIngestIdempotencyKey,
  type StructuredPendingSession,
} from "@/lib/line/produce-session-commands";
import {
  bangkokTimeFromTimestamp,
  buildWeighSessionValidationReply,
  getWeighSessionFinalizationErrors,
  parseWeighSession,
} from "@/lib/parsers/weigh-session/parser";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { logger } from "@/lib/logger";
import { seedCentralPricesFromPersistedWithdrawals } from "@/lib/white-sheet/seed-from-withdrawal";

type Supabase = SupabaseClient<Database>;
type PushMessage = (to: string, text: string) => Promise<unknown>;

export interface PendingFinalizerRun {
  due: number;
  finalized: number;
  duplicate: number;
  pending: number;
  /** 0050: structured sessions waiting for operator review confirmation. */
  awaitingConfirmation: number;
  failedClosed: number;
  staleSnapshot: number;
  skipped: number;
  errors: number;
}

export function buildReviewNotConfirmedMessage(): string {
  return "หมดเวลารอการยืนยัน จึงไม่บันทึกรายการ";
}

export function buildUnconfirmedStructuredCloseMessage(): string {
  return "รายการโครงสร้างปิดโดยไม่ยืนยัน จึงไม่บันทึก";
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

/**
 * Structured-only: the admitted item text, joined in ledger order.
 *
 * check_pending_close_ready proves admission_count = ingest_count, which is NOT
 * the same as proving the two ledgers describe the same events: admission {A,B}
 * with ingest {A,C} has equal counts, and joining every ingest row would parse C
 * — an event that was never admitted — while silently dropping admitted B.
 * Structured finalization therefore compares the exact generation-scoped
 * line_event_id sets and fails closed on any asymmetry, duplicate id, blank
 * ingest text, or admission/ingest timestamp disagreement.
 *
 * Throws rather than degrading: the caller records the message as a
 * reconstruction error, leaves finalText at the structured row's empty
 * accumulated_text, and the session fails validation instead of persisting
 * unadmitted items.
 */
export function buildAdmittedStructuredText(
  admissionRows: Array<{ line_event_id: string; line_timestamp_ms: number }>,
  ingestRows: Array<{ line_event_id: string; line_timestamp_ms: number; raw_text: string }>,
): string {
  const admitted = new Map<string, number>();
  for (const row of admissionRows) {
    if (admitted.has(row.line_event_id)) {
      throw new Error(`duplicate admission event ${row.line_event_id} in structured generation`);
    }
    admitted.set(row.line_event_id, row.line_timestamp_ms);
  }

  const seenIngest = new Set<string>();
  for (const row of ingestRows) {
    if (seenIngest.has(row.line_event_id)) {
      throw new Error(`duplicate ingest event ${row.line_event_id} in structured generation`);
    }
    seenIngest.add(row.line_event_id);

    if (!admitted.has(row.line_event_id)) {
      throw new Error(`ingest event ${row.line_event_id} was never admitted`);
    }
    if (admitted.get(row.line_event_id) !== row.line_timestamp_ms) {
      throw new Error(`admission/ingest timestamp conflict for event ${row.line_event_id}`);
    }
    if (row.raw_text == null || row.raw_text.trim() === "") {
      throw new Error(`admitted event ${row.line_event_id} has no ingest text`);
    }
  }

  for (const lineEventId of admitted.keys()) {
    if (!seenIngest.has(lineEventId)) {
      throw new Error(`admitted event ${lineEventId} has no matching ingest row`);
    }
  }

  return ingestRows.map((row) => row.raw_text).join("\n");
}

// Day context for the addition reply: cumulative total for the exact
// business date + staff + market + declared base transaction type (all
// session kinds, each item exactly once), plus whether a main batch exists.
async function loadAdditionalDayContext(
  supabase: Supabase,
  parsed: WeighSession,
): Promise<AdditionalSessionDayContext> {
  const batchTotal = parsed.items.reduce((sum, item) => sum + weighItemTotal(item), 0);

  const { data, error } = await supabase
    .from("produce_transactions")
    .select("transaction_type, total_amount, session_kind")
    .eq("transaction_date", parsed.date ?? "")
    .eq("staff_name", parsed.staff_name)
    .eq("market_name", parsed.session_title ?? "");

  if (error) throw new Error(`additional day context lookup failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    transaction_type: string;
    total_amount: number | null;
    session_kind?: string | null;
  }>;

  const existingTotal = rows
    .filter((row) =>
      baseTransactionType(row.transaction_type) === parsed.declared_transaction_type)
    .reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);

  return {
    cumulativeTotal: existingTotal + batchTotal,
    hasMatchingMain: rows.some((row) => (row.session_kind ?? "main") === "main"),
  };
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
  // The authoritative ingest identity, derived in one place (0036).
  const correlationId =
    produceIngestIdempotencyKey(snapshot.session_key, snapshot.session_generation) ??
    `${snapshot.session_key}:${snapshot.session_generation}`;
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
  // Structured path selection is driven only by database-enforced metadata:
  // buildSeedFromStructuredMetadata returns a seed exclusively for a complete,
  // contract-version-compatible row (the pending_sessions_structured_* CHECK
  // constraints guarantee completeness). Anything else — every legacy row, any
  // future contract version — falls through to the legacy path unchanged.
  const seed = buildSeedFromStructuredMetadata(snapshot as StructuredPendingSession);

  let finalText = snapshot.accumulated_text;
  const reconstructionErrors: string[] = [];
  try {
    const ingestRows = await service.loadIngestRows(
      snapshot.session_key,
      snapshot.session_generation,
      closeTimestamp,
    );
    if (seed) {
      // A structured session has no text header to find and none to invent.
      // Only the rows present in BOTH generation-scoped ledgers through the
      // immutable close boundary are parsed — count parity from the close
      // barrier is not treated as set identity. No ledger-header authority is
      // consulted and no header is synthesized.
      const admissionRows = await service.loadAdmissionRows(
        snapshot.session_key,
        snapshot.session_generation,
        closeTimestamp,
      );
      finalText = buildAdmittedStructuredText(admissionRows, ingestRows);
    } else if (hasHeaderInLedger(snapshot, ingestRows)) {
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
  // Seeded parse for structured rows; identical call shape as before for legacy
  // rows, where seed is null and the default parameter applies.
  const parsed = parseWeighSession(finalText, bangkokBusinessDateNow(), fallbackTime, seed);
  const isAdditional = parsed.session_kind === "additional";
  const validationErrors = [
    ...reconstructionErrors,
    ...getWeighSessionFinalizationErrors(parsed),
  ];

  // With an expected count, an additional batch must number its items exactly
  // 1..N (the RPC checks for missing numbers; out-of-range ones are caught here,
  // duplicates by getWeighSessionFinalizationErrors).
  if (isAdditional && snapshot.expected_item_count != null) {
    for (const item of parsed.items) {
      if (item.item_number < 1 || item.item_number > snapshot.expected_item_count) {
        validationErrors.push(
          `item #${item.item_number} is outside the expected range 1..${snapshot.expected_item_count}`,
        );
      }
    }
  }

  const rawMessageId = await findCloseRawMessageId(supabase, snapshot);
  if (!rawMessageId) validationErrors.push("close raw message was not found");

  // Success notification is snapshotted before the authoritative RPC. For an
  // addition it reports batch and cumulative day totals and never claims the
  // original session was modified.
  const notificationPayload = isAdditional && validationErrors.length === 0
    ? buildAdditionalSessionSummary(parsed, await loadAdditionalDayContext(supabase, parsed))
    : buildWeighSessionSummary(parsed);

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
    notification_payload: notificationPayload,
    notification_source_id: snapshot.source_id,
    correlation_id: correlationId,
    // Session-level provenance (0036): immutable ingest/generation identity is
    // the authoritative idempotency key — same-generation retries collapse to
    // one session while intentional identical additions persist separately.
    session_kind: parsed.session_kind,
    declared_transaction_type: parsed.declared_transaction_type,
    ingest_idempotency_key: correlationId,
    ingest_source: "line_webhook",
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
      : result.reason === "review_not_confirmed"
        ? buildReviewNotConfirmedMessage()
        : result.reason === "unconfirmed_structured_close"
          ? buildUnconfirmedStructuredCloseMessage()
          : buildWeighSessionValidationReply(parsed);
  } else if (result.status === "finalized" && !result.notification_id) {
    // Rolling-deploy fallback: the pre-0034 RPC cannot create an outbox row.
    // Once 0034 is installed, notification_id is always returned and success
    // delivery is handled exclusively by the durable worker.
    log.warn("produce notification outbox unavailable; using direct push fallback");
    message = notificationPayload;
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
    // BR-01: seed central prices only after the authoritative RPC persisted
    // the withdrawal. Returns/damaged returns are skipped inside the helper.
    // Best-effort like daily summary — the produce write already committed.
    try {
      if (parsed.date) {
        await seedCentralPricesFromPersistedWithdrawals(supabase, {
          businessDate: parsed.date,
          items: parsed.items,
        });
      }
    } catch (error) {
      log.error("central price seeding failed after produce finalization", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

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
    awaitingConfirmation: 0,
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
      else if (result.status === "pending" && result.reason === "awaiting_confirmation") {
        run.awaitingConfirmation += 1;
      } else if (result.status === "pending") run.pending += 1;
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
