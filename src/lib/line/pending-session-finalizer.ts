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
  sumWeighItemsSatang,
  type AdditionalSessionDayContext,
} from "@/lib/line/reply";
import { baseTransactionType } from "@/lib/summary/transactions";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import {
  computeItemHash,
  computeSessionHash,
} from "@/lib/line/session-dedup-service";
import {
  canonicalWithdrawalItemLines,
  weighSessionCompatibilityFingerprints,
} from "@/lib/produce/business-fingerprint";
import { supersedeReplacedPendingGenerations } from "@/lib/produce/pending-supersession";
import { loadHistoricalWithdrawalCandidates } from "@/lib/produce/historical-withdrawal-candidates";
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
import { runProduceFinalizeGate } from "@/lib/produce/entry-validation-gate";
import { bindPlainTextRound } from "@/lib/produce/plain-text-round-binding";
import {
  buildBlockingValidationReply,
  buildUnconfirmedReviewReply,
} from "@/lib/produce/entry-validation-message";
import { getRuntimeEnvironment } from "@/lib/runtime-environment";

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
 * Structured-only: verifies the admitted event set was fully and consistently
 * ingested, then returns the session's own accumulated_text — the SAME
 * document เมนู, จบรายการ and ยืนยันจบรายการ already validated before this call
 * (GuidedSessionCaptureService.readSnapshot). Finalization no longer replays
 * raw ledger text as the parsed document: a stale ingest row — for example a
 * typed control command recorded before the webhook-level interception
 * existed, or before it fires for a given trigger — can never reach the
 * parser through this path, and an administrator's out-of-band repair of
 * accumulated_text takes effect on the very next finalize attempt instead of
 * being silently overridden by replaying the untouched ledger.
 *
 * check_pending_close_ready proves admission_count = ingest_count, which is NOT
 * the same as proving the two ledgers describe the same events: admission {A,B}
 * with ingest {A,C} has equal counts but describes different sets. The
 * admission/ingest comparison below is kept as a pure integrity gate — it
 * still fails closed on any asymmetry, duplicate id, blank ingest text, or
 * admission/ingest timestamp disagreement, exactly the concurrency races 0049
 * built it to catch — it just no longer supplies the parsed text itself.
 *
 * Throws rather than degrading: the caller records the message as a
 * reconstruction error, leaves finalText at the structured row's empty
 * accumulated_text, and the session fails validation instead of persisting
 * over an unresolved admission/ingest asymmetry.
 */
export function buildAdmittedStructuredText(
  admissionRows: Array<{ line_event_id: string; line_timestamp_ms: number }>,
  ingestRows: Array<{ line_event_id: string; line_timestamp_ms: number; raw_text: string }>,
  accumulatedText: string,
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

  return accumulatedText;
}

// Day context for the addition reply: cumulative total for the exact
// business date + staff + market + declared base transaction type (all
// session kinds, each item exactly once), plus whether a main batch exists.
async function loadAdditionalDayContext(
  supabase: Supabase,
  parsed: WeighSession,
): Promise<AdditionalSessionDayContext> {
  // Exact milli-satang sum, rounded once at the end — see
  // sumWeighItemsSatang in src/lib/line/reply.ts.
  const batchTotal = sumWeighItemsSatang(parsed.items) / 100;

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

// A Production worker may finalize a legacy row (no ownership stamp, predates
// 0061) to preserve current Production behavior with zero backfill, but never
// a row explicitly stamped for another environment. A Preview/development
// worker must match exactly — NULL is never treated as "mine". This check is
// deliberately re-run here, not just in the sweep's SELECT, so a wrongly
// scoped or racing caller can never finalize a foreign-environment row.
function ownsSnapshotEnvironment(snapshot: PendingSession): boolean {
  const current = getRuntimeEnvironment();
  const owner = snapshot.runtime_environment ?? null;
  // Production alone gets the legacy-NULL compatibility exception (rows that
  // predate 0061). Every other environment, including development, requires
  // an exact match — NULL is never "mine". A test that needs a row to be
  // claimable must stamp it, not rely on development silently owning
  // everything; that would no longer be genuine isolation.
  if (current === "production") return owner === "production" || owner === null;
  return owner === current;
}

export async function finalizePendingGeneration(
  supabase: Supabase,
  snapshot: PendingSession,
  push: PushMessage = defaultPush,
): Promise<TryFinalizeResult> {
  if (!ownsSnapshotEnvironment(snapshot)) {
    return { status: "skipped", reason: "wrong_environment" };
  }
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
      // immutable close boundary are trusted to have arrived intact — count
      // parity from the close barrier is not treated as set identity. Once
      // that integrity gate passes, the parsed document is accumulated_text
      // itself — the same field readSnapshot already validated at every
      // review/close/confirm step — not a replay of the raw ledger text.
      const admissionRows = await service.loadAdmissionRows(
        snapshot.session_key,
        snapshot.session_generation,
        closeTimestamp,
      );
      finalText = buildAdmittedStructuredText(
        admissionRows,
        ingestRows,
        snapshot.accumulated_text,
      );
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

  // P4A completion: a plain-text session carries no typed open command, so this
  // is where it joins its accountability round — the last point before the gate
  // where the parsed seller, market and business date exist. Structured rows
  // were already bound by open_accountability_round_produce_session and are
  // left exactly as they are.
  let accountabilityRoundId = snapshot.accountability_round_id ?? null;
  let entryGateDetail: string | null = null;
  if (validationErrors.length === 0 && !seed) {
    const binding = await bindPlainTextRound(
      supabase,
      {
        sessionKey:        snapshot.session_key,
        sessionGeneration: snapshot.session_generation,
        sourceId:          snapshot.source_id,
        lineUserId:        snapshot.line_user_id,
      },
      parsed,
    );
    if (binding.status === "refused") {
      if (binding.reason === "ambiguous") {
        log.warn("produce.round.ambiguous_plain_withdrawal", {
          businessDate: parsed.date,
          sellerLabel: parsed.staff_name,
          marketLabel: parsed.session_title,
        });
      }
      validationErrors.push(`accountability round not resolved: ${binding.reason}`);
      entryGateDetail = binding.detail;
    } else {
      accountabilityRoundId =
        binding.status === "bound" ? binding.accountabilityRoundId : null;
      if (binding.status === "bound" && binding.reusedExistingRound) {
        log.info("produce.round.reused_for_plain_withdrawal", {
          accountabilityRoundId: binding.accountabilityRoundId,
          businessDate: parsed.date,
          sellerLabel: parsed.staff_name,
          marketLabel: parsed.session_title,
        });
      }
    }
  }

  // P4A: the last revalidation, against live master data. A round that was
  // clean at confirm time can stop being clean — a withdrawal voided, an
  // additional batch landing — and an approval never outranks impossible data.
  // Only reached when the parse itself is sound; a document that already failed
  // validation is reported as such rather than as an unmatched product list.
  if (validationErrors.length === 0) {
    const gate = await runEntryGateForFinalization(
      supabase,
      snapshot,
      accountabilityRoundId,
      parsed,
    );
    validationErrors.push(...gate.errors);
    entryGateDetail = gate.detail;
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
    accountability_round_id: accountabilityRoundId,
    // The containment guard's comparison key. Non-null only for a plain base
    // withdrawal, so `เบิกเพิ่ม` and every return are neither guarded nor
    // stored as candidates. Riding inside the existing payload keeps the RPC
    // signature unchanged, so neither deploy order can break.
    canonical_withdrawal_item_lines: canonicalWithdrawalItemLines(parsed),
    // Sessions recorded before that column existed carry NULL forever, so the
    // guard cannot see them from SQL alone. Their canonical lines are computed
    // here with the SAME canonicalizer and re-validated by the RPC under the
    // containment lock — proposals, not verdicts. See
    // historical-withdrawal-candidates.ts.
    historical_withdrawal_candidates: await loadHistoricalWithdrawalCandidates(supabase, {
      sessionDate: parsed.date,
      staffName: parsed.staff_name,
      marketLabel: parsed.session_title,
      canonicalLines: canonicalWithdrawalItemLines(parsed),
    }),
  };
  // Named fields, not a spread of the parsed item. A WeighSessionItem also
  // carries lookup-only evidence that must never reach a produce row —
  // legacy_subunit_price_per_unit, the price the retired subunit rescaling
  // would have stored (see types.ts). Sending the whole object put a second,
  // contradictory price on the wire; today's RPC extracts named keys and drops
  // it, but nothing in SQL enforces that, and the field it would resurrect is
  // the exact bug this path was corrected for.
  const itemPayload = parsed.items.map((item) => ({
    item_number: item.item_number,
    product_name: item.product_name,
    price_per_unit: item.price_per_unit,
    quantity: item.quantity,
    unit: item.unit,
    section: item.section,
    transaction_type: item.transaction_type,
    pricing_mode: item.pricing_mode,
    basis_quantity: item.basis_quantity,
    basis_unit: item.basis_unit,
    basis_price: item.basis_price,
    item_hash: computeItemHash(parsed, item),
  }));

  // The document's own identity is the current-generation hash. The
  // compatibility set is what the SAME document was hashed as by the previous
  // generation, under the market's other reviewed spellings; the RPC reserves
  // it atomically so neither a historical row nor a concurrent old-build
  // submission can be missed. See business-fingerprint.ts for V0/V1/V2.
  const businessFingerprint = computeSessionHash(parsed);
  const compatibilityFingerprints = weighSessionCompatibilityFingerprints(parsed);
  const result = await service.tryFinalizeGeneration(
    snapshot.session_key,
    snapshot.session_generation,
    snapshot.line_user_id,
    snapshot.ingest_revision,
    businessFingerprint,
    finalText,
    sessionPayload,
    itemPayload,
    compatibilityFingerprints,
  );

  if (result.status === "duplicate") {
    await reportBusinessDuplicate(supabase, {
      log,
      snapshot,
      parsed,
      fingerprint: businessFingerprint,
      reason: result.reason ?? "content_fingerprint",
      existingSessionId: result.session_id ?? null,
      rawMessageId,
    });
  }

  if (result.status === "failed_closed" && result.reason === "withdrawal_containment") {
    log.warn("produce.duplicate.containment_blocked", {
      businessDate: parsed.date,
      sellerLabel: parsed.staff_name,
      marketLabel: parsed.session_title,
      candidateItemCount: parsed.items.length,
      existingProduceSessionId: result.session_id ?? null,
    });
  }

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
          : result.reason === "withdrawal_containment"
            ? buildWithdrawalContainmentMessage()
            // P4A supplies its own operator-facing text when the gate is what
            // refused; anything else keeps the parse-level reply.
            : (entryGateDetail ?? buildWeighSessionValidationReply(parsed));
  } else if (result.status === "finalized" && !result.notification_id) {
    // Rolling-deploy fallback: the pre-0034 RPC cannot create an outbox row.
    // Once 0034 is installed, notification_id is always returned and success
    // delivery is handled exclusively by the durable worker.
    log.warn("produce notification outbox unavailable; using direct push fallback");
    message = notificationPayload;
  } else if (result.status === "duplicate") {
    message = buildBusinessDuplicateMessage();
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

    // P1-A: an attempt this document provably replaced stops being an open
    // question. Best-effort like the two calls around it — the produce write has
    // already committed and nothing here may turn a good finalization into an
    // error. Proof lives in pending-supersession.ts; this call never decides.
    try {
      if (result.session_id) {
        await supersedeReplacedPendingGenerations(supabase, {
          produceSessionId: result.session_id,
          sessionKey: snapshot.session_key,
          sessionGeneration: snapshot.session_generation,
          sourceId: snapshot.source_id,
          parsed,
          accountabilityRoundId,
        });
      }
    } catch (error) {
      log.error("pending supersession sweep failed after produce finalization", {
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

/**
 * What the operator sees when an exact business duplicate is refused.
 *
 * It states the outcome and stops. It never asks them to resend — the data IS
 * recorded, under the submission that arrived first, and a resend would only
 * be refused again.
 */
export function buildBusinessDuplicateMessage(): string {
  return ["⚠️ พบรายการนี้ถูกบันทึกไว้แล้ว", "ระบบไม่บันทึกซ้ำ"].join("\n");
}

/**
 * What the operator sees when a resent withdrawal overlaps one already recorded.
 *
 * Unlike an exact duplicate this one DOES ask for an action, because part of the
 * document may be genuinely new. It names the only safe way to send that part —
 * the explicit append contract — and never guesses the delta on their behalf.
 * No UUID and no fingerprint is exposed.
 */
export function buildWithdrawalContainmentMessage(): string {
  return [
    "⛔ รายการเบิกชุดนี้มีรายการซ้ำกับชุดที่บันทึกไว้แล้ว",
    "ระบบยังไม่ได้บันทึกรายการนี้",
    "หากมีของเพิ่ม กรุณาส่งเฉพาะรายการที่เพิ่มใหม่ด้วย \"เบิกเพิ่ม\"",
    "หากรายการเดิมผิด กรุณาแจ้งผู้ดูแลให้แก้ไขก่อน",
  ].join("\n");
}

/**
 * Everything a duplicate refusal has to leave behind.
 *
 * 1. Structured evidence — the business identity and the fingerprint that
 *    matched, plus the attempted session/source/user as audit metadata. No
 *    secrets and no raw document text.
 * 2. The empty accountability round the attempt minted is cancelled. The RPC
 *    refuses unless the round provably holds nothing, so a round with real
 *    business data can never be retired by this path.
 * 3. The close raw message is marked processed. The produce IS recorded — under
 *    the first submission — so leaving this message unprocessed would make the
 *    Sales reconciliation report it as produce that never landed.
 *
 * All three are best-effort: the authoritative refusal has already committed,
 * and nothing here may turn a clean duplicate into a finalizer error.
 */
async function reportBusinessDuplicate(
  supabase: Supabase,
  context: {
    log: ReturnType<typeof logger.child>;
    snapshot: PendingSession;
    parsed: WeighSession;
    fingerprint: string;
    reason: string;
    existingSessionId: string | null;
    rawMessageId: string | null;
  },
): Promise<void> {
  const { log, snapshot, parsed, fingerprint } = context;

  let existingSessionIds: string[] = context.existingSessionId
    ? [context.existingSessionId]
    : [];
  if (existingSessionIds.length === 0 && parsed.date) {
    try {
      const { data } = await supabase
        .from("produce_sessions")
        .select("id")
        .eq("session_date", parsed.date)
        .eq("staff_name", parsed.staff_name)
        .eq("session_title", parsed.session_title ?? "")
        .is("voided_at", null)
        .limit(10);
      existingSessionIds = (data ?? []).map((row) => row.id as string);
    } catch {
      // Evidence enrichment only. A failed lookup must not change the outcome.
    }
  }

  log.warn("produce business duplicate blocked", {
    reason: context.reason,
    businessDate: parsed.date,
    sellerLabel: parsed.staff_name,
    marketLabel: parsed.session_title,
    transactionType: parsed.declared_transaction_type
      ?? [...new Set(parsed.items.map((item) => item.transaction_type))].sort().join(","),
    businessFingerprint: fingerprint,
    existingProduceSessionIds: existingSessionIds,
    attemptedSessionKey: snapshot.session_key,
    attemptedSessionGeneration: snapshot.session_generation,
    attemptedSourceId: snapshot.source_id,
    attemptedLineUserId: snapshot.line_user_id,
    attemptedAccountabilityRoundId: snapshot.accountability_round_id ?? null,
  });

  try {
    const { data, error } = await supabase.rpc("cancel_duplicate_plain_text_round", {
      p_session_key: snapshot.session_key,
      p_session_generation: snapshot.session_generation,
    });
    if (error) throw new Error(error.message);
    const outcome = (data as { outcome?: string } | null)?.outcome ?? "unknown";
    if (outcome !== "no_round") {
      log.info("duplicate accountability round lifecycle", {
        outcome,
        accountabilityRoundId:
          (data as { accountability_round_id?: string } | null)?.accountability_round_id ?? null,
      });
    }
  } catch (error) {
    log.error("duplicate accountability round cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (context.rawMessageId) {
    try {
      await supabase
        .from("raw_messages")
        .update({ is_processed: true, processed_at: new Date().toISOString() })
        .eq("id", context.rawMessageId);
    } catch (error) {
      log.error("duplicate raw message processed flag failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * P4A entry gate, as the deferred finalizer runs it: read-only, fail-closed,
 * and it never presents or confirms anything. A price review that was never
 * acknowledged, an impossible quantity, an unknown unit — all of them make the
 * session fail closed here rather than persist and surface in the morning.
 */
async function runEntryGateForFinalization(
  supabase: Supabase,
  snapshot: PendingSession,
  accountabilityRoundId: string | null,
  parsed: WeighSession,
): Promise<{ errors: string[]; detail: string | null }> {
  let gate: Awaited<ReturnType<typeof runProduceFinalizeGate>>;
  try {
    gate = await runProduceFinalizeGate(
      supabase,
      {
        sessionKey: snapshot.session_key,
        sessionGeneration: snapshot.session_generation,
        accountabilityRoundId,
        businessDate: null,
        marketLabel: null,
        staffLabel: null,
        lineUserId: snapshot.line_user_id,
      },
      parsed,
    );
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : "entry validation failed"],
      detail: null,
    };
  }

  if (gate.decision === "blocked") {
    return {
      errors: gate.result.blocking.map((exception) => exception.kind),
      detail: buildBlockingValidationReply(gate.result),
    };
  }
  if (gate.decision === "review_presented") {
    return {
      errors: ["entry validation review was never confirmed"],
      detail: buildUnconfirmedReviewReply(gate.result),
    };
  }
  return { errors: [], detail: null };
}

export async function finalizeDuePendingGenerations(
  supabase: Supabase,
  push: PushMessage = defaultPush,
  limit = 25,
): Promise<PendingFinalizerRun> {
  // pending_sessions is part of the production baseline described by migration
  // 0031 but is not represented in the hand-maintained Database type yet.
  //
  // 0061: Preview and Production share this database with no other isolation,
  // so the sweep must never select a row owned by a different environment —
  // this is what actually stopped a Production worker from claiming and
  // finalizing a Preview-created session with the wrong parser code. NULL
  // (pre-0061 legacy rows) counts as Production's own; a Preview/development
  // sweep never matches NULL. finalizePendingGeneration re-checks ownership
  // independently, so this filter is a query-efficiency guard, not the only
  // enforcement point.
  const currentEnvironment = getRuntimeEnvironment();
  let query = (supabase as SupabaseClient)
    .from("pending_sessions")
    .select("*")
    .eq("terminalized", false)
    .not("next_attempt_at", "is", null)
    .lte("next_attempt_at", new Date().toISOString());
  query = currentEnvironment === "production"
    ? query.or("runtime_environment.eq.production,runtime_environment.is.null")
    : query.eq("runtime_environment", currentEnvironment);
  const { data, error } = await query
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
