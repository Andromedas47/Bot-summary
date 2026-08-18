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
 * The RPC does not exist on this database yet — an app-before-migration deploy.
 *
 * Distinct copy on purpose. "กรุณาลองใหม่อีกครั้ง" would send the operator into
 * a retry loop that CANNOT succeed until the migration lands, which may be
 * minutes or a deploy away. The honest instruction is the opposite one: the
 * feature is unavailable, so carry on with the draft (or supersede it with a
 * fresh header) and tell the team. Still fail-closed — nothing was cancelled
 * and this reply never claims otherwise.
 */
export const CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REPLY = [
  "⛔ ยังใช้คำสั่งยกเลิกรายการไม่ได้",
  "",
  "ระบบยังไม่เปิดใช้งานคำสั่งนี้ รายการที่กำลังกรอกยังอยู่ครบ",
  "กรอกรายการต่อได้ตามปกติ หรือแจ้งทีมผู้ดูแลระบบ",
].join("\n");

/** The `reason` this module returns when the RPC is absent. */
export const CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REASON = "rpc_unavailable";

/**
 * PostgreSQL 42883 is "function does not exist"; PostgREST answers PGRST202
 * when no function matches the posted arguments. Same narrow pair as
 * `isMissingFunctionError` in src/lib/line/pending-close-recovery.ts — every
 * other RPC error keeps the generic busy refusal, because a real refusal
 * (close_in_progress, draft_changed) IS worth retrying.
 */
function isMissingFunctionError(error: { code?: string | null }): boolean {
  return error.code === "42883" || error.code === "PGRST202";
}

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
 * Deliberately NOT re-read by any reporting consumer.
 *
 * `finalization_status = 'failed_closed'` with reason `user_cancelled` is the
 * terminal shape this feature writes, and it is tempting to treat such a row as
 * "resolved" in the Sales loader and in classifyRoundReturns. It is not.
 * Cancelling a return DOCUMENT is not evidence the goods were sold: a round
 * holding a persisted เบิก and an abandoned ชั่งคืน still has produce that is
 * unaccounted for, and skipping the row would turn `blocked` into `none` — the
 * legitimate sold-out reading — which is precisely the Production incident
 * `round-return-status.ts` was written for. Those consumers stay fail-closed:
 * a cancelled draft joins `superseded` and `close_refused_unresolved`. Once the
 * operator retypes and the real return finalizes, `hasPersistedReturn` clears
 * the round anyway.
 */

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
  /** Authoritative LINE timestamp of the cancel event. */
  lineTimestampMs: number;
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
      p_line_timestamp_ms: input.lineTimestampMs,
      p_source_id: input.sourceId,
      p_line_event_id: input.lineEventId,
      p_runtime_environment: input.runtimeEnvironment,
    });
    if (error) {
      if (isMissingFunctionError(error)) {
        return { cancelled: false, reason: CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REASON };
      }
      return { cancelled: false, reason: error.message || "rpc_error" };
    }
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
