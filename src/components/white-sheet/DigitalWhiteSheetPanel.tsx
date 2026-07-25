import type { DigitalWhiteSheetSummary as DigitalWhiteSheetSummaryContract } from "@/lib/white-sheet";
import type { WhiteSheetExpenseInput } from "./types";
import { DigitalWhiteSheetExpensesForm } from "./DigitalWhiteSheetExpensesForm";
import { DigitalWhiteSheetSummary } from "./DigitalWhiteSheetSummary";
import { WhiteSheetLifecycleControls } from "./WhiteSheetLifecycleControls";

export function DigitalWhiteSheetPanel({
  viewModel,
  entryStatus = "submitted",
  finalizedAt = null,
  finalizedBy = null,
  onSubmitExpenses,
  isSubmitting,
  lifecyclePending = false,
  lifecycleError = "",
  onFinalize,
  onReopen,
}: {
  viewModel: DigitalWhiteSheetSummaryContract;
  entryStatus?: "submitted" | "finalized" | "not_submitted";
  finalizedAt?: string | null;
  finalizedBy?: string | null;
  onSubmitExpenses: (input: WhiteSheetExpenseInput) => void | Promise<void>;
  isSubmitting?: boolean;
  lifecyclePending?: boolean;
  lifecycleError?: string;
  onFinalize: () => void | Promise<void>;
  onReopen: (reason: string) => void | Promise<void>;
}) {
  return (
    <div className="space-y-6" data-testid="white-sheet-panel">
      <DigitalWhiteSheetSummary viewModel={viewModel} entryStatus={entryStatus} />
      <DigitalWhiteSheetExpensesForm
        viewModel={entryStatus !== "not_submitted" ? viewModel : undefined}
        onSubmitExpenses={onSubmitExpenses}
        isSubmitting={isSubmitting}
        readOnly={entryStatus === "finalized"}
      />
      <WhiteSheetLifecycleControls
        entryStatus={entryStatus}
        finalizedAt={finalizedAt}
        finalizedBy={finalizedBy}
        isPending={lifecyclePending}
        error={lifecycleError}
        onFinalize={onFinalize}
        onReopen={onReopen}
      />
    </div>
  );
}
