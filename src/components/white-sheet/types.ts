import type { WhiteSheetExpenses } from "@/lib/white-sheet";

/**
 * Presentation-only input. The calculated output contract lives exclusively
 * in src/lib/white-sheet; this type only combines editable expense fields with
 * the submitted cash value before recalculation.
 */
export type WhiteSheetExpenseInput = WhiteSheetExpenses & {
  actualCashSubmitted: number;
};
