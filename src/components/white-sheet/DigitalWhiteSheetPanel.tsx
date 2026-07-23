import type { DigitalWhiteSheetViewModel, WhiteSheetExpenseInput } from "./types";
import { DigitalWhiteSheetExpensesForm } from "./DigitalWhiteSheetExpensesForm";
import { DigitalWhiteSheetSummary } from "./DigitalWhiteSheetSummary";

export function DigitalWhiteSheetPanel({
  viewModel,
  onSubmitExpenses,
  isSubmitting,
}: {
  viewModel: DigitalWhiteSheetViewModel;
  onSubmitExpenses: (input: WhiteSheetExpenseInput) => void | Promise<void>;
  isSubmitting?: boolean;
}) {
  return (
    <div className="space-y-6" data-testid="white-sheet-panel">
      <DigitalWhiteSheetSummary viewModel={viewModel} />
      <DigitalWhiteSheetExpensesForm
        viewModel={viewModel}
        onSubmitExpenses={onSubmitExpenses}
        isSubmitting={isSubmitting}
      />
    </div>
  );
}
