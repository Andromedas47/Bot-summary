import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatThaiDate } from "@/lib/date";
import type { DigitalWhiteSheetSummary as DigitalWhiteSheetSummaryContract } from "@/lib/white-sheet";
import { DigitalWhiteSheetStatus } from "./DigitalWhiteSheetStatus";
import { formatWhiteSheetMoney, splitWhiteSheetWarnings } from "./white-sheet-presentation";

function MoneyRow({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-slate-600">{label}</span>
      <span
        className={`tabular-nums ${
          emphasis ? "text-base font-bold text-slate-900" : "text-sm font-medium text-slate-800"
        }`}
      >
        {formatWhiteSheetMoney(value)} บาท
      </span>
    </div>
  );
}

export function DigitalWhiteSheetSummary({
  viewModel,
  entryStatus = "submitted",
}: {
  viewModel: DigitalWhiteSheetSummaryContract;
  /**
   * "not_submitted" means no White Sheet cash/expense entry has been saved
   * yet for this source/market/business date. expectedSales/verifiedTransfers
   * still come from real persisted transactions, but expenses/expenseTotal/
   * expectedCash/actualCashSubmitted/status on `viewModel` are placeholder
   * zeros in that state — they are intentionally NOT rendered here, so a
   * missing entry can never be misread as "$0 submitted, ยอดตรง".
   */
  entryStatus?: "submitted" | "not_submitted";
}) {
  const { expenses, warnings } = viewModel;
  const submitted = entryStatus === "submitted";
  const { hardStopWarnings, otherWarnings } = splitWhiteSheetWarnings(warnings);

  return (
    <Card data-testid="white-sheet-summary">
      <CardHeader>
        <CardTitle>ใบขาวดิจิทัล — {viewModel.marketLabel}</CardTitle>
        <p className="text-sm text-slate-500">
          วันที่ {formatThaiDate(viewModel.businessDate)}
        </p>
      </CardHeader>

      <CardContent className="space-y-5 pt-4">
        {hardStopWarnings.length > 0 && (
          <section
            className="rounded-xl border-2 border-red-300 bg-red-50 p-4 space-y-2"
            data-testid="white-sheet-hard-stop"
          >
            <p className="text-sm font-bold uppercase tracking-wide text-red-800">
              ห้ามเชื่อผลลัพธ์ทางการเงินนี้
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-red-900">
              {hardStopWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            ยอดขายและโอน
          </h4>
          <MoneyRow label="ยอดขายที่ควรได้" value={viewModel.expectedSales} />
          <MoneyRow label="เงินโอนที่ตรวจแล้ว" value={viewModel.verifiedTransfers} />
        </section>

        {submitted ? (
          <>
            <section className="rounded-lg border border-slate-100 bg-slate-50 p-4 space-y-1">
              <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                ค่าใช้จ่าย
              </h4>
              <MoneyRow label="ค่าแรง" value={expenses.labor} />
              <MoneyRow label="ค่าที่" value={expenses.locationFee} />
              <MoneyRow label="ค่าถุง" value={expenses.bag} />
              <MoneyRow label="ค่าขนม" value={expenses.snack} />
              <MoneyRow label="ค่าใช้จ่ายอื่น" value={expenses.other} />
              {expenses.otherNote?.trim() && (
                <p className="text-xs text-slate-500 pl-1">หมายเหตุ: {expenses.otherNote.trim()}</p>
              )}
              <div className="border-t border-slate-200 pt-2 mt-2">
                <MoneyRow label="รวมค่าใช้จ่าย" value={viewModel.expenseTotal} emphasis />
              </div>
            </section>

            <section className="space-y-1">
              <MoneyRow label="เงินสดที่ควรส่ง" value={viewModel.expectedCash} emphasis />
              <MoneyRow label="เงินสดส่งจริง" value={viewModel.actualCashSubmitted} emphasis />
            </section>

            <DigitalWhiteSheetStatus
              status={viewModel.status}
              difference={viewModel.difference}
            />
          </>
        ) : (
          <section
            className="rounded-xl border border-amber-200 bg-amber-50 p-4"
            data-testid="white-sheet-not-submitted"
          >
            <p className="text-sm font-semibold text-amber-800">ยังไม่ได้บันทึก</p>
            <p className="mt-1 text-xs text-amber-700">
              กรอกค่าใช้จ่ายและเงินสดส่งจริงด้านล่าง แล้วกดบันทึกเพื่อดูผลต่างและสถานะ
            </p>
          </section>
        )}

        {otherWarnings.length > 0 && (
          <section
            className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2"
            data-testid="white-sheet-warnings"
          >
            <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-800">
              คำเตือน
            </h4>
            <ul className="list-disc pl-5 space-y-1 text-sm text-amber-900">
              {otherWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
