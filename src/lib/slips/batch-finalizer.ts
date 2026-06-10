import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SlipCheckStatus } from "@/types/database";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import { SLIP_BATCH_QUIET_SECONDS } from "@/lib/slips/batch-service";

type Supabase = SupabaseClient<Database>;
type PushMessage = (to: string, text: string) => Promise<void>;

interface EvidenceWithCheck {
  id: string;
  batchIndex: number | null;
  checkStatus: SlipCheckStatus | null;
  transferAmount: number | null;
  paidAmount: number | null;
  failureReason: string | null;
}

/**
 * Claims and finalizes all slip_batches that have been collecting for at least
 * SLIP_BATCH_QUIET_SECONDS without a new image.  Returns the number of batches
 * that were finalized in this run.
 *
 * Safe to call from concurrent workers: the collecting→processing status
 * transition is done in a single UPDATE so only one caller can claim each batch.
 */
export async function finalizeDueSlipBatches(
  supabase: Supabase,
  push: PushMessage = pushLineMessage,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - SLIP_BATCH_QUIET_SECONDS * 1000,
  ).toISOString();

  // Atomic claim: flip status collecting → processing for all due batches.
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
    await finalizeBatch(supabase, batch.id, batch.source_id, push);
  }
  return batches.length;
}

async function finalizeBatch(
  supabase: Supabase,
  batchId: string,
  sourceId: string,
  push: PushMessage,
): Promise<void> {
  const log = logger.child({ batchId });

  try {
    const evidences = await loadBatchEvidences(supabase, batchId);

    if (evidences.length === 0) {
      log.warn("finalize-slip-batches: batch has no evidences — marking failed");
      await supabase.from("slip_batches").update({ status: "failed" }).eq("id", batchId);
      return;
    }

    const message = buildBatchSummaryMessage(evidences);
    await push(sourceId, message);

    const successCount = evidences.filter(
      (e) => e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED",
    ).length;
    const failedCount = evidences.length - successCount;

    await supabase.from("slip_batches").update({
      status:          successCount === 0 ? "failed" : failedCount > 0 ? "review_needed" : "completed",
      success_count:   successCount,
      failed_count:    failedCount,
      summary_sent_at: new Date().toISOString(),
    }).eq("id", batchId);

    log.info("finalize-slip-batches: batch finalized", {
      imageCount: evidences.length,
      successCount,
      failedCount,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("finalize-slip-batches: finalize failed", { reason });
    await supabase.from("slip_batches").update({ status: "failed" }).eq("id", batchId);
  }
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

export function buildBatchSummaryMessage(evidences: EvidenceWithCheck[]): string {
  const total = evidences.length;
  if (total === 0) return "";

  const successful = evidences.filter(
    (e) => e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED",
  );
  const needsReview = evidences.filter(
    (e) => e.checkStatus !== "EXTRACTED" && e.checkStatus !== "PARTIAL_EXTRACTED",
  );

  if (successful.length === 0) {
    return `รับรูปหลักฐานแล้วทั้งหมด ${total} รูป แต่ระบบอ่านข้อมูลไม่ครบ กรุณาให้แอดมินตรวจมือ`;
  }

  const totalAmount = successful.reduce(
    (sum, e) => sum + (e.transferAmount ?? e.paidAmount ?? 0),
    0,
  );

  const lines: string[] = [
    "สรุปรูปหลักฐานรอบนี้",
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
  // PROCESSING or null — OCR still running at finalization time
  return "ยังไม่ได้ตรวจสอบ";
}
