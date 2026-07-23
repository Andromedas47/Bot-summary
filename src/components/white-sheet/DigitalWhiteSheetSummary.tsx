import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatThaiDate } from "@/lib/date";
import type { DigitalWhiteSheetViewModel } from "./types";
import { DigitalWhiteSheetStatus } from "./DigitalWhiteSheetStatus";
import { formatWhiteSheetMoney } from "./white-sheet-presentation";

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

export function DigitalWhiteSheetSummary({ viewModel }: { viewModel: DigitalWhiteSheetViewModel }) {
  const { expenses, warnings } = viewModel;

  return (
    <Card data-testid="white-sheet-summary">
      <CardHeader>
        <CardTitle>ใบขาวดิจิทัล — {viewModel.marketLabel}</CardTitle>
        <p className="text-sm text-slate-500">
          วันที่ {formatThaiDate(viewModel.businessDate)}
        </p>
      </CardHeader>

      <CardContent className="space-y-5 pt-4">
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            ยอดขายและโอน
          </h4>
          <MoneyRow label="ยอดขายที่ควรได้" value={viewModel.expectedSales} />
          <MoneyRow label="เงินโอนที่ตรวจแล้ว" value={viewModel.verifiedTransfers} />
        </section>

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

        {warnings.length > 0 && (
          <section
            className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2"
            data-testid="white-sheet-warnings"
          >
            <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-800">
              คำเตือน
            </h4>
            <ul className="list-disc pl-5 space-y-1 text-sm text-amber-900">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
