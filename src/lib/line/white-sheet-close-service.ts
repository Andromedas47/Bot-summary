import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  listKnownProduceMarketLabels,
  loadDigitalWhiteSheetPageModel,
  loadWhiteSheetCashEntry,
  requireTrustedWhiteSheetSummary,
  saveWhiteSheetCashEntry,
  splitWhiteSheetWarnings,
  WhiteSheetHardStopError,
  WhiteSheetPersistenceError,
  type WhiteSheetCashEntryInput,
  type WhiteSheetCashEntryState,
} from "@/lib/white-sheet";
import type { WhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import {
  buildWhiteSheetHardStopReplyMessages,
  buildWhiteSheetSummaryMessages,
} from "@/lib/line/white-sheet-summary";

type Supabase = SupabaseClient<Database>;

const GENERIC_SAVE_ERROR =
  "บันทึกปิดยอดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อผู้ดูแลระบบ";

/** Exported so the Manual White Sheet session closer can detect the permanently-terminal case. */
export const FINALIZED_REPLY = [
  "ปิดยอดของวันนี้ถูกยืนยันแล้ว (FINALIZED)",
  "ไม่สามารถแก้ไขผ่าน LINE ได้",
  "หากต้องการแก้ไข กรุณาติดต่อผู้ดูแลระบบ",
].join("\n");

/**
 * Typed classification of a close attempt, for callers that need to branch on
 * *why* without string-matching a LINE reply message.
 * - success: persisted (trusted summary or a hard-stop reply, both persisted).
 * - finalized: rejected — the canonical entry is FINALIZED, permanently terminal.
 * - validation_failure: rejected — bad input (e.g. unknown market). Not persisted.
 * - retryable_failure: rejected — infra/load/save error. Not persisted, safe to retry.
 */
export type WhiteSheetCloseOutcomeReason =
  | "success"
  | "finalized"
  | "validation_failure"
  | "retryable_failure"
  | "stale_conflict";

export type WhiteSheetCloseOutcome = {
  replyMessages: string[];
  persisted: boolean;
  trusted: boolean;
  reason: WhiteSheetCloseOutcomeReason;
};

/** Operator-facing text unchanged from before the typed-reason refactor. */
const CASH_REQUIRED_REPLY = 'ต้องระบุเงินสดที่ส่งจริงก่อนจบใบขาวมือ เช่น\nเงินสด 4850';

const STALE_CONFLICT_REPLY = [
  "ข้อมูลใบขาวมือถูกแก้ไขที่อื่นระหว่างที่คุณกรอกอยู่",
  "กรุณาเปิดใบขาวมือใหม่เพื่อดูค่าล่าสุด แล้วลองปิดอีกครั้ง",
].join("\n");

/** Thrown by mergeWhiteSheetCloseInput when เงินสด cannot be resolved from either the command or the latest canonical entry. */
class WhiteSheetCloseCashRequiredError extends Error {}

function isFinalizedPersistenceError(error: unknown): boolean {
  return error instanceof WhiteSheetPersistenceError && error.code === "finalized";
}

function isStaleConflictError(error: unknown): boolean {
  return error instanceof WhiteSheetPersistenceError && error.code === "stale_conflict";
}

/**
 * Merges parsed LINE closing fields with any existing SUBMITTED entry.
 *
 * - First submission (not_submitted): omitted expenses initialize as 0.
 * - Resubmission (submitted): omitted expenses preserve persisted values;
 *   explicit values (including 0) replace. Explicit ค่าอื่น replaces both
 *   amount and note (ค่าอื่น 0 with no note clears a stale otherNote).
 * - เงินสด is always required and always replaces actualCashSubmitted.
 */
export function mergeWhiteSheetCloseInput(
  sourceId: string,
  command: WhiteSheetCloseCommand,
  existing: WhiteSheetCashEntryState,
): WhiteSheetCashEntryInput {
  const identity = {
    sourceId,
    marketLabelNormalized: command.marketLabelNormalized,
    businessDate: command.businessDate,
  };

  if (existing.status === "not_submitted") {
    // Truly nothing to fall back to — เงินสด must come from this command.
    if (command.actualCashSubmitted === undefined) {
      throw new WhiteSheetCloseCashRequiredError();
    }
    const other = command.other;
    return {
      ...identity,
      labor: command.labor ?? 0,
      locationFee: command.locationFee ?? 0,
      bag: command.bag ?? 0,
      snack: command.snack ?? 0,
      other: other?.amount ?? 0,
      otherNote: other?.note ?? null,
      actualCashSubmitted: command.actualCashSubmitted,
    };
  }

  const prior = existing.expenses;
  const other =
    command.other !== undefined
      ? {
          amount: command.other.amount,
          // Explicit ค่าอื่น 0 with no note clears a stale note; any supplied
          // note (including with amount 0) replaces the persisted note.
          note: command.other.note,
        }
      : {
          amount: prior.other,
          note: prior.otherNote ?? null,
        };

  // Omitted เงินสด on a resubmit is satisfied by the latest canonical cash
  // (e.g. an unedited reopen of a SUBMITTED session) — never by defaulting
  // to zero, and command.actualCashSubmitted (when present) always wins.
  const actualCashSubmitted = command.actualCashSubmitted ?? existing.actualCashSubmitted;

  return {
    ...identity,
    labor: command.labor ?? prior.labor,
    locationFee: command.locationFee ?? prior.locationFee,
    bag: command.bag ?? prior.bag,
    snack: command.snack ?? prior.snack,
    other: other.amount,
    otherNote: other.note,
    actualCashSubmitted,
  };
}

/**
 * Persist operator closing expenses/cash from a validated LINE command,
 * then reload the canonical White Sheet and format the LINE reply.
 *
 * Arithmetic always comes from the canonical loader/composer — never from
 * the LINE parser.
 */
export async function processWhiteSheetCloseCommand(
  supabase: Supabase,
  input: {
    sourceId: string;
    command: WhiteSheetCloseCommand;
    /**
     * When true, the save is optimistic-concurrency guarded against the
     * canonical entry's `updated_at` at the moment it was reloaded just
     * below — a canonical change racing this close (e.g. a Backoffice edit)
     * is detected as a typed stale conflict instead of silently overwritten.
     * Used by the Manual White Sheet LINE session close path; the one-
     * message LINE close command and Backoffice keep last-write-wins.
     */
    optimisticConcurrency?: boolean;
  },
): Promise<WhiteSheetCloseOutcome> {
  const { sourceId, command, optimisticConcurrency } = input;
  const log = logger.child({
    sourceId,
    market: command.marketLabelNormalized,
    businessDate: command.businessDate,
  });

  const knownMarkets = await listKnownProduceMarketLabels(
    supabase,
    sourceId,
    command.businessDate,
  );

  if (!knownMarkets.includes(command.marketLabelNormalized)) {
    const hint =
      knownMarkets.length > 0
        ? `ตลาดที่มีข้อมูลวันนี้:\n${knownMarkets.map((m) => `- ${m}`).join("\n")}`
        : "ยังไม่พบรายการเบิก/คืนของวันนี้สำหรับแหล่งนี้";
    return {
      replyMessages: [
        [
          `ไม่พบตลาด "${command.marketLabel}" ในข้อมูลวันนี้`,
          "กรุณาใช้ชื่อตลาดให้ตรงกับรายการเบิก/คืน (ไม่มีการเดาชื่อ)",
          hint,
        ].join("\n"),
      ],
      persisted: false,
      trusted: false,
      reason: "validation_failure",
    };
  }

  let existing: WhiteSheetCashEntryState;
  try {
    existing = await loadWhiteSheetCashEntry(supabase, {
      sourceId,
      marketLabelNormalized: command.marketLabelNormalized,
      businessDate: command.businessDate,
    });
  } catch (error) {
    log.error("white sheet close existing-entry load failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      replyMessages: [GENERIC_SAVE_ERROR],
      persisted: false,
      trusted: false,
      reason: "retryable_failure",
    };
  }

  // Reject FINALIZED before any merge/write so omitted-field merge cannot
  // appear to mutate a locked row.
  if (existing.status === "finalized") {
    log.info("white sheet close rejected — finalized");
    return {
      replyMessages: [FINALIZED_REPLY],
      persisted: false,
      trusted: false,
      reason: "finalized",
    };
  }

  let merged;
  try {
    merged = mergeWhiteSheetCloseInput(sourceId, command, existing);
  } catch (error) {
    if (error instanceof WhiteSheetCloseCashRequiredError) {
      return {
        replyMessages: [CASH_REQUIRED_REPLY],
        persisted: false,
        trusted: false,
        reason: "validation_failure",
      };
    }
    throw error;
  }

  try {
    await saveWhiteSheetCashEntry(
      supabase,
      merged,
      optimisticConcurrency && existing.status !== "not_submitted"
        ? { expectedUpdatedAt: existing.updatedAt }
        : undefined,
    );
  } catch (error) {
    if (isFinalizedPersistenceError(error)) {
      log.info("white sheet close rejected — finalized");
      return {
        replyMessages: [FINALIZED_REPLY],
        persisted: false,
        trusted: false,
        reason: "finalized",
      };
    }

    if (isStaleConflictError(error)) {
      log.info("white sheet close rejected — stale conflict");
      return {
        replyMessages: [STALE_CONFLICT_REPLY],
        persisted: false,
        trusted: false,
        reason: "stale_conflict",
      };
    }

    log.error("white sheet close persistence failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      replyMessages: [GENERIC_SAVE_ERROR],
      persisted: false,
      trusted: false,
      reason: "retryable_failure",
    };
  }

  let pageModel;
  try {
    pageModel = await loadDigitalWhiteSheetPageModel(supabase, {
      sourceId,
      marketKey: command.marketLabelNormalized,
      marketLabel: command.marketLabelNormalized,
      businessDate: command.businessDate,
    });
  } catch (error) {
    log.error("white sheet close canonical reload failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      replyMessages: [
        [
          "บันทึกข้อมูลปิดยอดแล้ว ✅",
          "แต่โหลดสรุปยอดไม่สำเร็จ กรุณาเปิดหน้าเว็บตรวจสอบ หรือติดต่อผู้ดูแลระบบ",
        ].join("\n"),
      ],
      persisted: true,
      trusted: false,
      reason: "success",
    };
  }

  try {
    const summary = requireTrustedWhiteSheetSummary(pageModel);
    return {
      replyMessages: buildWhiteSheetSummaryMessages(summary),
      persisted: true,
      trusted: true,
      reason: "success",
    };
  } catch (error) {
    if (error instanceof WhiteSheetHardStopError) {
      const { hardStopWarnings } = splitWhiteSheetWarnings(pageModel.summary.warnings);
      return {
        replyMessages: buildWhiteSheetHardStopReplyMessages(hardStopWarnings),
        persisted: true,
        trusted: false,
        reason: "success",
      };
    }
    throw error;
  }
}
