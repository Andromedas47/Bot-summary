/**
 * Cancel the ONE produce draft the operator is currently filling in.
 *
 * The gap this closes
 * -------------------
 * Until now an operator who started the wrong document had no way out. The
 * guided menu's "ออกจากเมนู" dismisses the controls and deliberately leaves the
 * session open (there was no cancel contract to call), and the copy said so:
 * "หากต้องการยกเลิกรายการ กรุณาแจ้งผู้ดูแล". A mistyped header therefore either
 * had to be lived with, superseded by a later correct document, or waited out.
 *
 * What this is NOT
 * ----------------
 * Not a delete. Not a way to undo a finalized produce session, void a
 * transaction, or close an accountability round that holds business data.
 * Nothing is hard-deleted: accumulated_text, raw_messages, the admission and
 * ingest ledgers, every event id and every previously finalized session all
 * survive. The cancelled generation reaches the same auditable terminal shape
 * `superseded` and `close_refused_unresolved` already use —
 * `finalization_status = 'failed_closed'` plus a structured reason — so no new
 * status value enters the CHECK that migration 0034 closed.
 *
 * Application proposes, database decides
 * --------------------------------------
 * The caller passes the snapshot (`updated_at`) and generation of the pending
 * row it already resolved. Every ownership, concurrency and lifecycle question
 * is then answered inside `cancel_active_pending_produce_draft` under the row
 * lock. This module never re-reads the row to "check" first — that read would
 * be a TOCTOU window, not a guard — and it never reports success on a refusal.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeEnvironment } from "@/lib/runtime-environment";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** The one exact operator command. Never a prefix, never a fuzzy match. */
export const CANCEL_ACTIVE_DRAFT_COMMAND = "ยกเลิกรายการ";

/**
 * Exact match only, with the same `.trim()` normalization every other exact
 * control trigger uses (see isExactGuidedCloseTrigger).
 *
 * Deliberately NOT matched, because each already means something else:
 *   ยกเลิก        the guided menu-dismiss ("ออกจากเมนู" typed equivalent)
 *   ยกเลิกซื้อ     purchase capture
 *   ยกเลิกใบขาวมือ white sheet
 */
export function isExactCancelActiveDraftCommand(text: string): boolean {
  return text.trim() === CANCEL_ACTIVE_DRAFT_COMMAND;
}

/** The draft was cancelled (or a redelivery of the same cancel was replayed). */
export const CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY = [
  "✅ ยกเลิกรายการแล้ว",
  "",
  "รายการที่กำลังกรอกถูกยกเลิก",
  "ยังไม่มีข้อมูลจากรายการนี้ถูกบันทึก",
  "",
  "สามารถเริ่มรายการใหม่ได้ทันที",
].join("\n");

/** There was nothing to cancel. Nothing was written to say so. */
export const CANCEL_ACTIVE_DRAFT_NONE_REPLY = [
  "ℹ️ ไม่มีรายการที่กำลังกรอกอยู่",
  "",
  "สามารถเริ่มรายการใหม่ได้เลย",
].join("\n");

/**
 * The database refused: a close or finalization is in flight, the generation
 * rotated, the draft changed under the read, or the row belongs to another
 * source or runtime environment. Never say "cancelled" for any of these.
 */
export const CANCEL_ACTIVE_DRAFT_REFUSED_REPLY = [
  "⛔ ยกเลิกรายการไม่สำเร็จ",
  "",
  "รายการนี้กำลังถูกบันทึกหรือถูกแก้ไขอยู่ กรุณาลองใหม่อีกครั้ง",
].join("\n");

/**
 * Shown ONLY where the draft provably stays active and correction is still
 * possible. One shared constant — this string must never be copied inline.
 */
export const CANCEL_ACTIVE_DRAFT_HINT = [
  "หากต้องการทิ้งรายการนี้และเริ่มใหม่",
  `พิมพ์ "${CANCEL_ACTIVE_DRAFT_COMMAND}"`,
].join("\n");

/** Append the hint after a blank line. */
export function withCancelActiveDraftHint(reply: string): string {
  return `${reply}\n\n${CANCEL_ACTIVE_DRAFT_HINT}`;
}

/**
 * True only for a row this feature terminalized.
 *
 * `failed_closed` alone is NOT enough: it is also how a genuinely lost
 * document, a supersession and an unresolved close refusal terminate, and every
 * one of those IS missing produce. Only the structured reason distinguishes
 * them, so the reason is what is read — defensively, because
 * `finalization_error` is jsonb and can be null, a scalar or an array.
 */
export function isUserCancelledPendingRow(row: {
  finalization_status?: string | null;
  finalization_error?: unknown;
}): boolean {
  if (row.finalization_status !== "failed_closed") return false;
  const error = row.finalization_error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
  return (error as { reason?: unknown }).reason === "user_cancelled";
}

/** Discriminated outcome. `cancelled: false` never becomes a success reply. */
export type CancelActiveDraftResult =
  | { cancelled: true; reason: string; roundOutcome?: string | null }
  | { cancelled: false; reason: string };

export interface CancelActiveDraftInput {
  sessionKey: string;
  /** From the ALREADY-RESOLVED pending row — never re-read to obtain it. */
  sessionGeneration: string;
  /** The same row's `updated_at`. A NULL is refused by the database. */
  expectedUpdatedAt: string | null;
  sourceId: string | null;
  lineEventId: string;
  runtimeEnvironment: RuntimeEnvironment;
}

/**
 * Thin wrapper over the authoritative RPC. It decides nothing.
 *
 * A Supabase RPC RESOLVES with `{ data, error }` rather than throwing on a
 * PostgREST error, so both shapes are handled: an error, a malformed payload
 * and a transport throw all answer `cancelled: false`.
 */
export async function cancelActiveProduceDraft(
  supabase: AnyClient,
  input: CancelActiveDraftInput,
): Promise<CancelActiveDraftResult> {
  try {
    const { data, error } = await supabase.rpc("cancel_active_pending_produce_draft", {
      p_session_key: input.sessionKey,
      p_session_generation: input.sessionGeneration,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_source_id: input.sourceId,
      p_line_event_id: input.lineEventId,
      p_runtime_environment: input.runtimeEnvironment,
    });
    if (error) return { cancelled: false, reason: error.message || "rpc_error" };
    const outcome = (data ?? null) as
      | { cancelled?: unknown; reason?: unknown; round_outcome?: unknown }
      | null;
    if (!outcome || outcome.cancelled !== true) {
      return {
        cancelled: false,
        reason: typeof outcome?.reason === "string" ? outcome.reason : "unknown",
      };
    }
    return {
      cancelled: true,
      reason: typeof outcome.reason === "string" ? outcome.reason : "cancelled",
      roundOutcome: typeof outcome.round_outcome === "string" ? outcome.round_outcome : null,
    };
  } catch (caught) {
    return {
      cancelled: false,
      reason: caught instanceof Error ? caught.message : String(caught),
    };
  }
}
