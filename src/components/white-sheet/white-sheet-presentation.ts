import type { WhiteSheetStatus } from "@/lib/white-sheet";
import { splitWhiteSheetWarnings } from "@/lib/white-sheet/warnings";
import type { WhiteSheetExpenseInput } from "./types";

export { splitWhiteSheetWarnings };

export function formatWhiteSheetMoney(amount: number): string {
  return amount.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const WHITE_SHEET_STATUS_LABELS: Record<WhiteSheetStatus, string> = {
  shortage: "เงินขาด",
  matched: "ยอดตรง",
  overage: "เงินเกิน",
};

export function getWhiteSheetStatusVariant(
  status: WhiteSheetStatus,
): "error" | "success" | "warning" {
  switch (status) {
    case "shortage":
      return "error";
    case "matched":
      return "success";
    case "overage":
      return "warning";
  }
}

export function formatWhiteSheetDifferenceLine(
  status: WhiteSheetStatus,
  difference: number,
): string {
  const label = WHITE_SHEET_STATUS_LABELS[status];
  const amount = formatWhiteSheetMoney(Math.abs(difference));
  return `${label} ${amount} บาท`;
}

export type WhiteSheetExpenseField =
  | "labor"
  | "locationFee"
  | "bag"
  | "snack"
  | "other"
  | "actualCashSubmitted";

export type WhiteSheetExpenseValidationErrors = Partial<
  Record<WhiteSheetExpenseField | "otherNote", string>
>;

export function validateWhiteSheetExpensesInput(
  input: WhiteSheetExpenseInput,
): { valid: true } | { valid: false; errors: WhiteSheetExpenseValidationErrors } {
  const errors: WhiteSheetExpenseValidationErrors = {};

  const numericFields: Array<{ key: WhiteSheetExpenseField; label: string }> = [
    { key: "labor", label: "ค่าแรง" },
    { key: "locationFee", label: "ค่าที่" },
    { key: "bag", label: "ค่าถุง" },
    { key: "snack", label: "ค่าขนม" },
    { key: "other", label: "ค่าใช้จ่ายอื่น" },
    { key: "actualCashSubmitted", label: "เงินสดส่งจริง" },
  ];

  for (const { key, label } of numericFields) {
    const value = input[key];
    if (!Number.isFinite(value) || value < 0) {
      errors[key] = `${label}ต้องเป็นตัวเลข 0 ขึ้นไป`;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}

export function parseWhiteSheetMoneyInput(raw: string): number {
  if (raw.trim() === "") return 0;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}
