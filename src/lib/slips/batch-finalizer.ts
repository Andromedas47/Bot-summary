import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SlipCheckStatus, SlipBatchRow } from "@/types/database";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";

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

// How long a collecting batch must be idle before the fallback finalizer
// treats it as abandoned.  Env var is in minutes; default 60.
// "จบสลิป" still closes sessions immediately regardless of this value.
const SLIP_ABANDONED_SESSION_MINUTES = parseAbandonedMinutes(
  process.env.SLIP_ABANDONED_SESSION_MINUTES,
);

type Supabase = SupabaseClient<Database>;
type PushMessage = (to: string, text: string) => Promise<void>;

interface EvidenceWithCheck {
  id:             string;
  batchIndex:     number | null;
  checkStatus:    SlipCheckStatus | null;
  transferAmount: number | null;
  paidAmount:     number | null;
  failureReason:  string | null;
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
export async function finalizeDueSlipBatches(
  supabase: Supabase,
  push: PushMessage = pushLineMessage,
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
    await finalizeSlipBatch(supabase, batch.id, (text) => push(batch.source_id, text));
  }
  return batches.length;
}

/**
 * Finalizes a single slip batch that has already been claimed (status=processing).
 * Loads evidences, builds a summary, calls sendMessage, then updates the batch status.
 *
 * Used by both the cron finalizer and the "จบสลิป" webhook command.
 * The caller controls where the message goes (push vs reply).
 */
export async function finalizeSlipBatch(
  supabase: Supabase,
  batchId:  string,
  sendMessage: (text: string) => Promise<void>,
): Promise<void> {
  const log = logger.child({ batchId });
  // Tracks whether LINE has already received the message.
  // Used in the catch block to decide between reverting (pre-send failure,
  // user can retry "จบสลิป") vs logging-only (post-send failure, summary
  // was delivered so reverting would cause a duplicate).
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

    log.info("finalizing active slip batch", { evidenceCount: evidences.length });

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
      }
      return;
    }

    const title   = buildSessionTitle(batchRow);
    const message = buildBatchSummaryMessage(evidences, { title });

    await sendMessage(message);
    messageSent = true;

    const successCount = evidences.filter(
      (e) => e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED",
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
      // LINE already received the summary — don't throw (would revert to collecting),
      // just log so an operator can patch the row if needed.
      log.error("finalizeSlipBatch: DB update failed after LINE success — summary was sent", {
        reason: updateError.message,
      });
      return;
    }

    log.info("finalizeSlipBatch: batch finalized", {
      evidenceCount: evidences.length,
      successCount,
      failedCount,
      summaryTitle:  title ?? "default",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("finalizeSlipBatch: finalize failed", { reason, messageSent });

    if (!messageSent) {
      // Pre-send failure: revert to collecting so the user can retry "จบสลิป"
      // with a fresh replyToken.
      const { error: revertErr } = await supabase
        .from("slip_batches")
        .update({ status: "collecting" })
        .eq("id", batchId);
      if (revertErr) {
        log.error("finalizeSlipBatch: revert to collecting failed", { reason: revertErr.message });
      }
    }
    // Post-send failure (messageSent=true): don't revert — summary was delivered.
    // The batch stays in 'processing'; operator must manually complete or the
    // next cron call will skip it via the idempotency guard (summary_sent_at set).
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
    .select("evidence_id, status, transfer_amount, paid_amount, failure_reason")
    .in("evidence_id", evidenceIds);

  if (checkError) throw new Error(`loadBatchEvidences checks: ${checkError.message}`);

  const checkByEvidenceId = new Map<string, typeof checkData extends Array<infer T> ? T : never>();
  for (const check of checkData ?? []) {
    checkByEvidenceId.set(check.evidence_id, check);
  }

  return evidenceRows.map((ev) => {
    const check = checkByEvidenceId.get(ev.id);
    return {
      id:             ev.id,
      batchIndex:     ev.batch_index,
      checkStatus:    (check?.status ?? null) as SlipCheckStatus | null,
      transferAmount: check?.transfer_amount ?? null,
      paidAmount:     check?.paid_amount ?? null,
      failureReason:  check?.failure_reason ?? null,
    };
  });
}

function buildSessionTitle(batch: SlipBatchRow | null): string | undefined {
  if (!batch) return undefined;
  if (!batch.seller_name && !batch.market_name) return undefined;
  const parts = [batch.seller_name, batch.market_name, batch.slip_date].filter(Boolean);
  return `สรุปชุดสลิปเงินโอน ${parts.join(" — ")}`;
}

export function buildBatchSummaryMessage(
  evidences: EvidenceWithCheck[],
  options?: { title?: string },
): string {
  const total = evidences.length;
  if (total === 0) return "";

  const successful = evidences.filter(
    (e) => e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED",
  );
  const needsReview = evidences.filter(
    (e) => e.checkStatus !== "EXTRACTED" && e.checkStatus !== "PARTIAL_EXTRACTED",
  );

  if (successful.length === 0) {
    if (options?.title) {
      return `${options.title}\n\nรับทั้งหมด: ${total} รูป แต่ระบบอ่านข้อมูลไม่ครบ กรุณาให้แอดมินตรวจมือ`;
    }
    return `รับรูปหลักฐานแล้วทั้งหมด ${total} รูป แต่ระบบอ่านข้อมูลไม่ครบ กรุณาให้แอดมินตรวจมือ`;
  }

  const totalAmount = successful.reduce(
    (sum, e) => sum + (e.transferAmount ?? e.paidAmount ?? 0),
    0,
  );

  const lines: string[] = [
    options?.title ?? "สรุปรูปหลักฐานรอบนี้",
    `รับทั้งหมด: ${total} รูป`,
    `อ่านครบ: ${successful.length} รูป`,
    `รอตรวจมือ: ${needsReview.length} รูป`,
  ];

  if (totalAmount > 0) {
    lines.push(
      `ยอดรวมที่อ่านได้: ${totalAmount.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`,
    );
  }

  if (needsReview.length > 0) {
    lines.push("");
    lines.push("รูปที่ต้องตรวจมือ:");
    for (const e of needsReview) {
      const idx = e.batchIndex ?? "?";
      lines.push(`#${idx} ${describeReviewReason(e)}`);
    }
  }

  return lines.join("\n");
}

function describeReviewReason(e: EvidenceWithCheck): string {
  if (e.checkStatus === "FAILED") {
    if (e.failureReason === "evidence_load_failed")     return "โหลดรูปไม่สำเร็จ";
    if (e.failureReason === "evidence_download_failed") return "ดาวน์โหลดรูปไม่สำเร็จ";
    if (e.failureReason === "extractor_not_configured") return "ระบบอ่านรูปไม่พร้อม";
    return "อ่านข้อมูลไม่ครบ";
  }
  if (e.checkStatus === "NEED_REVIEW") return "ไม่พบข้อมูลครบถ้วน";
  return "ยังไม่ได้ตรวจสอบ";
}
