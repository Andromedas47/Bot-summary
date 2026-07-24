import type { DigitalWhiteSheetSummary as DigitalWhiteSheetSummaryContract } from "@/lib/white-sheet";
import type { WhiteSheetExpenseInput } from "./types";
import { DigitalWhiteSheetExpensesForm } from "./DigitalWhiteSheetExpensesForm";
import { DigitalWhiteSheetSummary } from "./DigitalWhiteSheetSummary";

export function DigitalWhiteSheetPanel({
  viewModel,
  entryStatus = "submitted",
  onSubmitExpenses,
  isSubmitting,
}: {
  viewModel: DigitalWhiteSheetSummaryContract;
  entryStatus?: "submitted" | "not_submitted";
  onSubmitExpenses: (input: WhiteSheetExpenseInput) => void | Promise<void>;
  isSubmitting?: boolean;
}) {
  return (
    <div className="space-y-6" data-testid="white-sheet-panel">
      <DigitalWhiteSheetSummary viewModel={viewModel} entryStatus={entryStatus} />
      <DigitalWhiteSheetExpensesForm
        viewModel={entryStatus === "submitted" ? viewModel : undefined}
        onSubmitExpenses={onSubmitExpenses}
        isSubmitting={isSubmitting}
      />
    </div>
  );
}
