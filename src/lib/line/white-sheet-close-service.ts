import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  listKnownProduceMarketLabels,
  loadDigitalWhiteSheetPageModel,
  requireTrustedWhiteSheetSummary,
  saveWhiteSheetCashEntry,
  splitWhiteSheetWarnings,
  WhiteSheetHardStopError,
  WhiteSheetPersistenceError,
} from "@/lib/white-sheet";
import type { WhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import {
  buildWhiteSheetHardStopReplyMessages,
  buildWhiteSheetSummaryMessages,
} from "@/lib/line/white-sheet-summary";

type Supabase = SupabaseClient<Database>;

const GENERIC_SAVE_ERROR =
  "บันทึกปิดยอดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อผู้ดูแลระบบ";

const FINALIZED_REPLY = [
  "ปิดยอดของวันนี้ถูกยืนยันแล้ว (FINALIZED)",
  "ไม่สามารถแก้ไขผ่าน LINE ได้",
  "หากต้องการแก้ไข กรุณาติดต่อผู้ดูแลระบบ",
].join("\n");

export type WhiteSheetCloseOutcome = {
  replyMessages: string[];
  persisted: boolean;
  trusted: boolean;
};

function isFinalizedPersistenceError(error: unknown): boolean {
  return (
    error instanceof WhiteSheetPersistenceError &&
    error.message.includes("finalized")
  );
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
  },
): Promise<WhiteSheetCloseOutcome> {
  const { sourceId, command } = input;
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
    };
  }

  try {
    await saveWhiteSheetCashEntry(supabase, {
      sourceId,
      marketLabelNormalized: command.marketLabelNormalized,
      businessDate: command.businessDate,
      labor: command.labor,
      locationFee: command.locationFee,
      bag: command.bag,
      snack: command.snack,
      other: command.other,
      otherNote: command.otherNote,
      actualCashSubmitted: command.actualCashSubmitted,
    });
  } catch (error) {
    if (isFinalizedPersistenceError(error)) {
      log.info("white sheet close rejected — finalized");
      return {
        replyMessages: [FINALIZED_REPLY],
        persisted: false,
        trusted: false,
      };
    }

    log.error("white sheet close persistence failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      replyMessages: [GENERIC_SAVE_ERROR],
      persisted: false,
      trusted: false,
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
    };
  }

  try {
    const summary = requireTrustedWhiteSheetSummary(pageModel);
    return {
      replyMessages: buildWhiteSheetSummaryMessages(summary),
      persisted: true,
      trusted: true,
    };
  } catch (error) {
    if (error instanceof WhiteSheetHardStopError) {
      const { hardStopWarnings } = splitWhiteSheetWarnings(pageModel.summary.warnings);
      return {
        replyMessages: buildWhiteSheetHardStopReplyMessages(hardStopWarnings),
        persisted: true,
        trusted: false,
      };
    }
    throw error;
  }
}
