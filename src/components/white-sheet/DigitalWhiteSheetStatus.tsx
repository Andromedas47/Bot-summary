import { Badge } from "@/components/ui/Badge";
import type { DigitalWhiteSheetViewModel } from "./types";
import {
  formatWhiteSheetDifferenceLine,
  formatWhiteSheetMoney,
  getWhiteSheetStatusVariant,
  WHITE_SHEET_STATUS_LABELS,
} from "./white-sheet-presentation";

export function DigitalWhiteSheetStatus({
  status,
  difference,
}: Pick<DigitalWhiteSheetViewModel, "status" | "difference">) {
  const label = WHITE_SHEET_STATUS_LABELS[status];
  const variant = getWhiteSheetStatusVariant(status);
  const differenceText = formatWhiteSheetDifferenceLine(status, difference);

  return (
    <div
      className={`rounded-xl border p-4 space-y-2 ${
        status === "shortage"
          ? "border-red-200 bg-red-50"
          : status === "overage"
            ? "border-amber-200 bg-amber-50"
            : "border-emerald-200 bg-emerald-50"
      }`}
      data-testid="white-sheet-status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={variant} dot>
          {label}
        </Badge>
        <span className="text-sm font-semibold text-slate-800">{label}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          ผลต่าง
        </span>
        <span
          className={`text-lg font-bold tabular-nums ${
            status === "shortage"
              ? "text-red-700"
              : status === "overage"
                ? "text-amber-700"
                : "text-emerald-700"
          }`}
          aria-label={`ผลต่าง ${differenceText}`}
        >
          {differenceText}
        </span>
      </div>
      {status === "matched" && (
        <p className="text-xs text-emerald-700">
          ยอดตรง {formatWhiteSheetMoney(difference)} บาท
        </p>
      )}
    </div>
  );
}
