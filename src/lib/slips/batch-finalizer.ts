import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SlipCheckStatus, SlipBatchRow, SlipType } from "@/types/database";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { tryFinalizeSettlement } from "@/lib/settlement-finalizer";
import {
  computeValidationFlags,
  parseBatchDate,
  type EvidenceFlags,
  type ValidationReason,
} from "./validation-guard";

/**
 * Parses SLIP_ABANDONED_SESSION_MINUTES env-var safely.
 * Returns 60 for any invalid, empty, NaN, zero, or negative value.
 * parseInt("", 10) returns NaN; Math.max(1, NaN) also returns NaN — hence the
 * explicit isFinite guard.
 */
export function parseAbandonedMinutes(value: string | undefined): number {
  if (!value) return 60;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60;
  return Math.max(1, parsed);
}

/**
 * Parses a closing-window seconds env-var (SLIP_CLOSE_QUIET_SECONDS or
 * SLIP_CLOSE_MAX_SECONDS).  Returns `defaultValue` for invalid / missing input.
 */
export function parseCloseSeconds(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(1, parsed);
}

// How long a collecting batch must be idle before the fallback finalizer
// treats it as abandoned.  Env var is in minutes; default 60.
const SLIP_ABANDONED_SESSION_MINUTES = parseAbandonedMinutes(
  process.env.SLIP_ABANDONED_SESSION_MINUTES,
);

// After "จบสลิป" (closing state): wait this long after the last image before
// considering the batch quiet enough to finalize.  Default 10 s gives late-
// arriving LINE webhooks time to deliver.
const CLOSE_QUIET_SECONDS = parseCloseSeconds(
  process.env.SLIP_CLOSE_QUIET_SECONDS,
  10,
);

// Hard upper limit on how long a closing batch can wait before the finalizer
// gives up waiting for PROCESSING checks and sends the summary anyway.
const CLOSE_MAX_SECONDS = parseCloseSeconds(
  process.env.SLIP_CLOSE_MAX_SECONDS,
  120,
);

type Supabase = SupabaseClient<Database>;

// retryKey is the batch UUID passed as X-Line-Retry-Key for idempotent push.
type PushMessage = (to: string, text: string, retryKey?: string) => Promise<void>;

/**
 * Structured outcome from finalizeSlipBatch.
 *
 * delivered=true  persisted=true  — LINE delivered + DB updated; fully finalized.
 * delivered=true  persisted=false — LINE delivered (or already accepted) but the
 *                                   final DB update failed.  summary_sent_at is
 *                                   still null; a subsequent retry with the same
 *                                   batch-id retry key will skip LINE (409) and
 *                                   attempt the DB update again.
 *
 * void (undefined) is returned when the idempotency guard fires (summary_sent_at
 * already set by a previous call); callers that need to distinguish this case
 * should query summary_sent_at before calling.
 */
export type FinalizeResult =
  | { delivered: true; persisted: true }
  | { delivered: true; persisted: false; persistError: string };

interface EvidenceWithCheck {
  id:              string;
  batchIndex:      number | null;
  checkStatus:     SlipCheckStatus | null;
  slipType:        SlipType | null;
  transferAmount:  number | null;
  paidAmount:      number | null;
  grossAmount?:    number | null;
  discountAmount?: number | null;
  transactionTime: string | null;
  failureReason:   string | null;
}

/**
 * Claims and finalizes collecting slip_batches that have been idle for longer
 * than SLIP_ABANDONED_SESSION_MINUTES (default 60 min, env-configurable).
 * This is a safety-net for sessions the user never explicitly closed.
 * "จบสลิป" closes sessions immediately and independently of this timeout.
 *
 * Safe to call from concurrent workers: the collecting→processing transition
 * is a single UPDATE so only one caller can claim each batch.
 */
const defaultPush: PushMessage = async (to, text, retryKey) => {
  await pushLineMessage(to, text, retryKey);
};

export async function finalizeDueSlipBatches(
  supabase: Supabase,
  push: PushMessage = defaultPush,
  abandonedMinutes: number = SLIP_ABANDONED_SESSION_MINUTES,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - abandonedMinutes * 60 * 1000,
  ).toISOString();

  const { data: claimed, error } = await supabase
    .from("slip_batches")
    .update({ status: "processing" })
    .eq("status", "collecting")
    .lte("last_image_at", cutoff)
    .select("id, source_id");

  if (error) {
    logger.error("finalize-slip-batches: claim failed", { reason: error.message });
    return 0;
  }

  const batches = claimed ?? [];
  for (const batch of batches) {
    await finalizeSlipBatch(supabase, batch.id, (text) => push(batch.source_id, text, batch.id));
  }
  return batches.length;
}

// ── Closing-batch atomic claim ────────────────────────────────────────────────

/**
 * Result from a successful atomic claim; null means not yet ready or already
 * claimed by a concurrent worker.
 */
interface ClaimResult {
  id:         string;
  source_id:  string;
  wasTimeout: boolean;
}

/**
 * Injectable claim function used by finalizeClosingSlipBatches.
 * Default implementation delegates to the claim_closing_slip_batch SQL RPC
 * which atomically locks the batch row, re-evaluates readiness while holding
 * the lock, and transitions status closing→processing if conditions are met.
 *
 * Serializes against attach_evidence_to_slip_batch because both operations
 * UPDATE the same slip_batches row (acquiring the same row-level lock).
 */
export type ClaimFn = (
  supabase:     Supabase,
  batchId:      string,
  quietSeconds: number,
  maxSeconds:   number,
) => Promise<ClaimResult | null>;

async function defaultAtomicClaim(
  supabase:     Supabase,
  batchId:      string,
  quietSeconds: number,
  maxSeconds:   number,
): Promise<ClaimResult | null> {
  const { data, error } = await supabase.rpc("claim_closing_slip_batch", {
    p_batch_id:      batchId,
    p_quiet_seconds: quietSeconds,
    p_max_seconds:   maxSeconds,
  });

  if (error) {
    logger.error("claim_closing_slip_batch RPC failed", { batchId, reason: error.message });
    return null;
  }

  const rows = data as Array<{ claimed_id: string; claimed_source_id: string; was_timeout: boolean }> | null;
  if (!rows || rows.length === 0) return null;
  return {
    id:         rows[0].claimed_id,
    source_id:  rows[0].claimed_source_id,
    wasTimeout: rows[0].was_timeout,
  };
}

/**
 * Finds every slip batch in 'closing' status and finalizes those that are ready.
 *
 * Readiness is evaluated inside claim_closing_slip_batch (SQL RPC) while
 * holding a row-level lock on the batch.  This prevents the following race:
 *
 *   • If a late image arrives and updates last_image_at before the claim locks
 *     the row, the RPC reads the fresh last_image_at and returns no rows
 *     (quiet period not yet elapsed) — image attachment wins.
 *   • If the claim locks the row first and transitions status to 'processing',
 *     attach_evidence_to_slip_batch's WHERE status IN ('collecting','closing')
 *     fails and raises an exception — finalizer wins, late image is rejected.
 *
 * Safe to call from concurrent workers: closing→processing transition is
 * inside the RPC and protected by the row-level lock.
 */
type FinalizeFn = (
  supabase:    Supabase,
  batchId:     string,
  sendMessage: (text: string) => Promise<void>,
  options?:    { isTimeoutForced?: boolean },
) => Promise<FinalizeResult | void>;

export async function finalizeClosingSlipBatches(
  supabase:     Supabase,
  push:         PushMessage = defaultPush,
  quietSeconds: number = CLOSE_QUIET_SECONDS,
  maxSeconds:   number = CLOSE_MAX_SECONDS,
  _finalize:    FinalizeFn = finalizeSlipBatch,
  _claim:       ClaimFn = defaultAtomicClaim,
): Promise<number> {
  const { data: closingBatches, error } = await supabase
    .from("slip_batches")
    .select("id, source_id")
    .eq("status", "closing");

  if (error) {
    logger.error("finalizeClosingSlipBatches: fetch failed", { reason: error.message });
    return 0;
  }

  let count = 0;
  for (const batch of closingBatches ?? []) {
    const claimed = await _claim(supabase, batch.id, quietSeconds, maxSeconds);
    if (!claimed) continue;

    await _finalize(
      supabase,
      claimed.id,
      (text) => push(claimed.source_id, text, claimed.id),
      { isTimeoutForced: claimed.wasTimeout },
    );
    count++;
  }

  return count;
}

// ── Single-batch finalization ─────────────────────────────────────────────────

/**
 * Finalizes a single slip batch that has already been claimed (status=processing).
 * Loads evidences, builds a summary, calls sendMessage, then updates the batch status.
 *
 * Used by both the cron finalizer and the abandoned-session path.
 *
 * DELIVERY LIFECYCLE (in order):
 *   1. [done by caller] Atomic claim: closing/collecting → processing
 *   2. Load batch row + evidences
 *   3. Build summary text
 *   4. LINE Push  (X-Line-Retry-Key set by the sendMessage closure in the caller)
 *   5. Persist delivery result: summary_sent_at, final status
 *
 * FAILURE HANDLING:
 *   Pre-send failure (messageSent=false): the batch stays in 'processing' with
 *   summary_sent_at=null.  It is NOT reverted to 'collecting' — reverting would
 *   re-open image collection on a batch the user already closed.  The operator
 *   can manually re-trigger via a protected admin endpoint.  Because the caller
 *   passes the batch ID as X-Line-Retry-Key, a safe re-send will not duplicate.
 *
 *   Post-send DB failure (messageSent=true): the summary was delivered.  We log
 *   the error and return without throwing so the caller does not revert state.
 *   The batch stays in 'processing'; the summary_sent_at idempotency guard in
 *   subsequent runs prevents duplicate sends.
 *
 *   Repeated cron executions: the summary_sent_at guard at the top of this
 *   function causes early-return if the summary was already delivered — no
 *   duplicate sends during normal operation.
 */
export async function finalizeSlipBatch(
  supabase:    Supabase,
  batchId:     string,
  sendMessage: (text: string) => Promise<void>,
  options?:    { isTimeoutForced?: boolean },
): Promise<FinalizeResult | void> {
  const log = logger.child({ batchId });
  const isTimeoutForced = options?.isTimeoutForced ?? false;
  // Tracks whether LINE has already received the message.
  let messageSent = false;

  try {
    const [batchRow, evidences] = await Promise.all([
      loadBatchRow(supabase, batchId),
      loadBatchEvidences(supabase, batchId),
    ]);

    // Idempotency guard: if summary_sent_at is already set, another worker
    // (or a previous retry) already delivered the summary — skip silently.
    if (batchRow?.summary_sent_at) {
      log.warn("finalizeSlipBatch: summary already sent — skipping", {
        summarySetAt: batchRow.summary_sent_at,
      });
      return;
    }

    log.info("finalizing active slip batch", { evidenceCount: evidences.length, isTimeoutForced });

    if (evidences.length === 0) {
      log.warn("finalizeSlipBatch: no evidences — marking failed");
      await sendMessage("ยังไม่มีรูปในชุดสลิปนี้");
      messageSent = true;
      const { error: emptyErr } = await supabase.from("slip_batches").update({
        status:          "failed",
        finalized_at:    new Date().toISOString(),
        summary_sent_at: new Date().toISOString(),
      }).eq("id", batchId);
      if (emptyErr) {
        log.error("finalizeSlipBatch: DB update failed after empty-batch message", {
          reason: emptyErr.message,
        });
        return { delivered: true, persisted: false, persistError: emptyErr.message };
      }
      return { delivered: true, persisted: true };
    }

    const title    = buildSessionTitle(batchRow);
    const slipDate = parseBatchDate(batchRow?.slip_date ?? null);
    const message  = buildBatchSummaryMessage(evidences, {
      title,
      isTimeout: isTimeoutForced,
      slipDate,
    });

    await sendMessage(message);
    messageSent = true;

    // Derive counts from the same validation guard used by the summary.
    const validationFlags = computeValidationFlags(evidences, slipDate);
    const successCount = evidences.filter(
      (e, i) =>
        (e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED") &&
        !validationFlags[i].flagged,
    ).length;
    const failedCount = evidences.length - successCount;
    const now = new Date().toISOString();

    const { error: updateError } = await supabase.from("slip_batches").update({
      status:          successCount === 0 ? "failed" : failedCount > 0 ? "review_needed" : "completed",
      success_count:   successCount,
      failed_count:    failedCount,
      finalized_at:    now,
      summary_sent_at: now,
    }).eq("id", batchId);

    if (updateError) {
      // LINE already delivered the summary but the DB update failed.
      // Return a structured failure so the caller can surface it correctly.
      // The batch stays in processing with summary_sent_at=null so a subsequent
      // recovery call can retry the DB update using the same batch-id retry key
      // (LINE will return 409 already_accepted; no duplicate message is sent).
      log.error("finalizeSlipBatch: DB update failed after LINE success — summary was sent", {
        reason: updateError.message,
      });
      return { delivered: true, persisted: false, persistError: updateError.message };
    }

    log.info("finalizeSlipBatch: batch finalized", {
      evidenceCount: evidences.length,
      successCount,
      failedCount,
      summaryTitle:  title ?? "default",
      isTimeoutForced,
    });

    const businessDate = bangkokBusinessDateFromTimestamp(
      new Date(batchRow?.closing_at ?? batchRow?.last_image_at ?? "").getTime(),
    );
    if (businessDate) {
      tryFinalizeSettlement(supabase, batchRow!.source_id, businessDate).catch(
        (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
      );
    }

    return { delivered: true, persisted: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("finalizeSlipBatch: finalize failed", { reason, messageSent });

    if (!messageSent) {
      // Pre-send failure: do NOT revert to 'collecting'.
      // Reverting would re-open image collection on a closed batch, which must
      // never happen after finalization starts.  The batch stays in 'processing'
      // so it is invisible to the cron (which only handles 'closing' batches).
      // An operator can manually re-trigger delivery via a protected admin endpoint.
      log.error(
        "finalizeSlipBatch: pre-send failure — batch stays in processing, requires manual retry",
        { batchId },
      );
    }
    // Post-send failure (messageSent=true): summary was delivered.
    // The batch stays in 'processing'; the idempotency guard (summary_sent_at)
    // prevents duplicate sends on subsequent cron executions.
    throw err;
  }
}

async function loadBatchRow(supabase: Supabase, batchId: string): Promise<SlipBatchRow | null> {
  const { data } = await supabase
    .from("slip_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  return data ?? null;
}

async function loadBatchEvidences(
  supabase: Supabase,
  batchId: string,
): Promise<EvidenceWithCheck[]> {
  const { data: evidenceData, error: evidenceError } = await supabase
    .from("slip_evidences")
    .select("id, batch_index")
    .eq("batch_id", batchId)
    .order("batch_index", { ascending: true });

  if (evidenceError) throw new Error(`loadBatchEvidences evidence: ${evidenceError.message}`);

  const evidenceRows = evidenceData ?? [];
  if (evidenceRows.length === 0) return [];

  const evidenceIds = evidenceRows.map((e) => e.id);

  const { data: checkData, error: checkError } = await supabase
    .from("slip_checks")
    .select("evidence_id, status, slip_type, gross_amount, discount_amount, transfer_amount, paid_amount, transaction_time, failure_reason")
    .in("evidence_id", evidenceIds);

  if (checkError) throw new Error(`loadBatchEvidences checks: ${checkError.message}`);

  const checkByEvidenceId = new Map<string, typeof checkData extends Array<infer T> ? T : never>();
  for (const check of checkData ?? []) {
    checkByEvidenceId.set(check.evidence_id, check);
  }

  return evidenceRows.map((ev) => {
    const check = checkByEvidenceId.get(ev.id);
    return {
      id:              ev.id,
      batchIndex:      ev.batch_index,
      checkStatus:     (check?.status ?? null) as SlipCheckStatus | null,
      slipType:        (check?.slip_type ?? null) as SlipType | null,
      grossAmount:     check?.gross_amount ?? null,
      discountAmount:  check?.discount_amount ?? null,
      transferAmount:  check?.transfer_amount ?? null,
      paidAmount:      check?.paid_amount ?? null,
      transactionTime: check?.transaction_time ?? null,
      failureReason:   check?.failure_reason ?? null,
    };
  });
}

function buildSessionTitle(batch: SlipBatchRow | null): string | undefined {
  if (!batch) return undefined;
  if (!batch.seller_name && !batch.market_name) return undefined;
  const parts = [batch.seller_name, batch.market_name, batch.slip_date].filter(Boolean);
  return `สรุปชุดสลิปเงินโอน ${parts.join(" — ")}`;
}

// Reasons that represent amount-level problems (not date-only).
// Only these count toward "ยอดที่ถูกระงับ"; date-only exclusions are not suspicious amounts.
const AMOUNT_FLAG_REASONS = new Set<ValidationReason>(["ยอดเงินสูงผิดปกติ", "ข้อมูลไม่ครบ"]);

/**
 * Builds the LINE summary message for a finalized batch.
 *
 * Applies two validation guards before computing the trusted total:
 *
 *   Outlier guard — flags an extracted amount when:
 *     • The batch has ≥ 5 valid extracted amounts, AND
 *     • The amount is ≥ 5,000 THB, AND
 *     • The amount is ≥ 10 × the batch median.
 *
 *   Date guard — flags an extracted item when its transaction date
 *     differs from slipDate by more than 1 calendar day (Bangkok time).
 *
 * Flagged items are moved to manual review and excluded from the trusted total.
 * GPT extraction data is never overwritten; the guard operates on display only.
 *
 * When isTimeout=true (max closing timeout reached), shows a detailed
 * per-category breakdown (completed / failed / manual-review / pending).
 */
export function buildBatchSummaryMessage(
  evidences: EvidenceWithCheck[],
  options?: { title?: string; isTimeout?: boolean; slipDate?: string | null },
): string {
  const total = evidences.length;
  if (total === 0) return "";

  const flags = computeValidationFlags(evidences, parseBatchDate(options?.slipDate ?? null));

  type Enriched = EvidenceWithCheck & { flags: EvidenceFlags };
  const enriched: Enriched[] = evidences.map((e, i) => ({ ...e, flags: flags[i] }));

  const isTerminal = (e: Enriched) =>
    e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED";

  const trusted    = enriched.filter((e) =>  isTerminal(e) && !e.flags.flagged);
  const flagged    = enriched.filter((e) =>  isTerminal(e) &&  e.flags.flagged);
  const failedEvs  = enriched.filter((e) => e.checkStatus === "FAILED");
  const needReview = enriched.filter((e) => e.checkStatus === "NEED_REVIEW");
  const pending    = enriched.filter(
    (e) => e.checkStatus === null || e.checkStatus === "PROCESSING",
  );
  // Flagged completed items are treated as manual review.
  const incomplete = [...failedEvs, ...needReview, ...pending, ...flagged];

  const trustedTotal = trusted.reduce(
    (sum, e) => sum + (e.flags.effectiveAmount ?? 0),
    0,
  );

  // ── Timeout forced: detailed breakdown ──────────────────────────────────────
  if (options?.isTimeout && (pending.length > 0 || failedEvs.length > 0)) {
    const lines: string[] = [
      options.title ?? "สรุปรูปหลักฐานรอบนี้ (หมดเวลา)",
      `รับทั้งหมด: ${total} รูป`,
      `อ่านครบ: ${trusted.length} รูป`,
    ];
    if (failedEvs.length > 0)
      lines.push(`อ่านไม่สำเร็จ: ${failedEvs.length} รูป`);
    if ((needReview.length + flagged.length) > 0)
      lines.push(`รอตรวจมือ: ${needReview.length + flagged.length} รูป`);
    if (pending.length > 0)
      lines.push(`รอประมวลผล: ${pending.length} รูป`);
    if (trustedTotal > 0) {
      lines.push(
        `ยอดรวมที่อ่านได้: ${trustedTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`,
      );
    }
    const amountFlaggedCountTimeout = flagged.filter(
      (e) => e.flags.flagReasons.some((r) => AMOUNT_FLAG_REASONS.has(r as ValidationReason)),
    ).length;
    if (amountFlaggedCountTimeout > 0) {
      lines.push(`ยอดที่ถูกระงับ: ${amountFlaggedCountTimeout} รายการ`);
    }
    appendTrustedEvidenceLines(lines, trusted);
    if (incomplete.length > 0) {
      lines.push("");
      lines.push("รูปที่ยังไม่ครบ:");
      for (const e of incomplete) {
        const idx = e.batchIndex ?? "?";
        lines.push(`#${idx} ${describeIncompleteReason(e)}`);
      }
    }
    return lines.join("\n");
  }

  // ── Normal (non-timeout) rendering ──────────────────────────────────────────
  if (trusted.length === 0 && flagged.length === 0) {
    if (options?.title) {
      return `${options.title}\n\nรับทั้งหมด: ${total} รูป แต่ระบบอ่านข้อมูลไม่ครบ กรุณาให้แอดมินตรวจมือ`;
    }
    return `รับรูปหลักฐานแล้วทั้งหมด ${total} รูป แต่ระบบอ่านข้อมูลไม่ครบ กรุณาให้แอดมินตรวจมือ`;
  }

  const lines: string[] = [
    options?.title ?? "สรุปรูปหลักฐานรอบนี้",
    `รับทั้งหมด: ${total} รูป`,
    `อ่านครบ: ${trusted.length} รูป`,
    `รอตรวจมือ: ${incomplete.length} รูป`,
  ];

  if (trustedTotal > 0) {
    lines.push(
      `ยอดรวมที่อ่านได้: ${trustedTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`,
    );
  }
  const amountFlaggedCount = flagged.filter(
    (e) => e.flags.flagReasons.some((r) => AMOUNT_FLAG_REASONS.has(r as ValidationReason)),
  ).length;
  if (amountFlaggedCount > 0) {
    lines.push(`ยอดที่ถูกระงับ: ${amountFlaggedCount} รายการ`);
  }

  appendTrustedEvidenceLines(lines, trusted);

  if (incomplete.length > 0) {
    lines.push("");
    lines.push("รูปที่ต้องตรวจมือ:");
    for (const e of incomplete) {
      const idx = e.batchIndex ?? "?";
      lines.push(`#${idx} ${describeIncompleteReason(e)}`);
    }
  }

  return lines.join("\n");
}

type EnrichedEvidence = EvidenceWithCheck & { flags: EvidenceFlags };

function appendTrustedEvidenceLines(lines: string[], trusted: EnrichedEvidence[]): void {
  if (trusted.length === 0) return;
  lines.push("");
  lines.push("รูปที่ตรวจผ่าน:");
  for (const e of trusted) {
    const idx    = e.batchIndex ?? "?";
    const amount = e.flags.effectiveAmount;
    if (amount !== null && amount > 0) {
      const formatted = amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
      lines.push(`#${idx} เช็คได้ ${formatted} บาท`);
    } else {
      lines.push(`#${idx} เช็คได้`);
    }
  }
}

function describeIncompleteReason(e: EnrichedEvidence): string {
  if (e.flags.flagged && e.flags.flagReasons.length > 0) {
    return e.flags.flagReasons.join(", ");
  }
  return describeReviewReason(e);
}

function describeReviewReason(e: EvidenceWithCheck): string {
  if (e.checkStatus === "PROCESSING") return "รอผลการตรวจสอบ";
  if (e.checkStatus === null)         return "ยังไม่ได้ตรวจสอบ";
  if (e.checkStatus === "FAILED") {
    if (e.failureReason === "evidence_load_failed")     return "โหลดรูปไม่สำเร็จ";
    if (e.failureReason === "evidence_download_failed") return "ดาวน์โหลดรูปไม่สำเร็จ";
    if (e.failureReason === "extractor_not_configured") return "ระบบอ่านรูปไม่พร้อม";
    return "อ่านข้อมูลไม่ครบ";
  }
  if (e.checkStatus === "NEED_REVIEW") return "ไม่พบข้อมูลครบถ้วน";
  return "ยังไม่ได้ตรวจสอบ";
}
