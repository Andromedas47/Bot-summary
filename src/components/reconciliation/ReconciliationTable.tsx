import { Badge } from "@/components/ui/Badge";
import {
  STATUS_LABEL_TH,
  rowNeedsReview,
  type ReconciliationReportRow,
  type ReconciliationStatus,
} from "@/lib/reconciliation-report";

const STATUS_VARIANT: Record<ReconciliationStatus, "success" | "warning" | "error" | "info"> = {
  matched:        "success",
  transfer_short: "error",
  transfer_over:  "warning",
  pending_review: "info",
  missing_data:   "warning",
};

function fmtMoney(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function diffClass(v: number | null): string {
  if (v == null) return "text-slate-400";
  if (Math.abs(v) < 0.005) return "text-emerald-600";
  return v > 0 ? "text-amber-600" : "text-red-600";
}

export function ReconciliationTable({ rows }: { rows: ReconciliationReportRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
        ไม่พบข้อมูลกระทบยอดในช่วงที่เลือก
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[920px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3">วันที่ธุรกิจ</th>
            <th className="px-4 py-3">ตลาด</th>
            <th className="px-4 py-3 text-right">ยอดโอนที่ส่ง</th>
            <th className="px-4 py-3 text-right">AI ตรวจสลิป</th>
            <th className="px-4 py-3 text-right">สลิปมือ</th>
            <th className="px-4 py-3 text-right">รวมสลิปที่ตรวจ</th>
            <th className="px-4 py-3 text-right">ส่วนต่าง</th>
            <th className="px-4 py-3">สถานะ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const exception = rowNeedsReview(r.status);
            return (
              <tr
                key={`${r.source_id}-${r.business_date}-${i}`}
                className={`border-b border-slate-100 last:border-0 ${
                  exception ? "bg-amber-50/40 hover:bg-amber-50" : "hover:bg-slate-50"
                }`}
              >
                <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-700 tabular-nums">
                  {r.business_date}
                </td>
                <td className="px-4 py-3 text-slate-700">{r.market}</td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                  {fmtMoney(r.submitted_transfer_total)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                  {fmtMoney(r.ai_verified_total)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                  {fmtMoney(r.manual_slip_total)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                  {fmtMoney(r.checked_slip_total)}
                </td>
                <td className={`px-4 py-3 text-right font-semibold tabular-nums ${diffClass(r.difference)}`}>
                  {fmtMoney(r.difference)}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={STATUS_VARIANT[r.status]} dot>
                    {STATUS_LABEL_TH[r.status]}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
