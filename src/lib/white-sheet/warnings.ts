/**
 * Shared warning classification for the White Sheet calculation output.
 * Single source of truth for both the Dashboard presentation layer
 * (src/components/white-sheet/white-sheet-presentation.ts) and any
 * server-side boundary that must refuse to trust/send a result (LINE push,
 * finalization) — see requireTrustedWhiteSheetSummary in ./compose.
 *
 * The multiple-completed-main-session warning (see load.ts
 * multipleSessionWarnings) is a HARD STOP: the required base has no
 * void/supersede marker, so duplicate business data may already be
 * double-counted. Duplicate sessions are never auto-resolved; this only
 * classifies the warning so every consumer treats it the same way.
 */
const HARD_STOP_WARNING_PREFIX = "Multiple completed main produce sessions";

export const UNATTRIBUTED_VERIFIED_TRANSFER_WARNING =
  "พบสลิปที่ยืนยันแล้วแต่ไม่สามารถระบุตลาดให้ตรงกับรายการของวันนี้ได้ กรุณาตรวจสอบก่อนใช้ยอดสรุป";

export function isHardStopWarning(warning: string): boolean {
  return warning.startsWith(HARD_STOP_WARNING_PREFIX)
    || warning.startsWith(UNATTRIBUTED_VERIFIED_TRANSFER_WARNING);
}

export function hasHardStopWarning(warnings: readonly string[]): boolean {
  return warnings.some(isHardStopWarning);
}

export function splitWhiteSheetWarnings(warnings: readonly string[]): {
  hardStopWarnings: string[];
  otherWarnings: string[];
} {
  const hardStopWarnings: string[] = [];
  const otherWarnings: string[] = [];
  for (const warning of warnings) {
    (isHardStopWarning(warning) ? hardStopWarnings : otherWarnings).push(warning);
  }
  return { hardStopWarnings, otherWarnings };
}

export function unattributedVerifiedTransferWarning(
  count: number,
  amount: number,
): string {
  const formattedAmount = amount.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${UNATTRIBUTED_VERIFIED_TRANSFER_WARNING} (${count} รายการ, ${formattedAmount} บาท)`;
}
