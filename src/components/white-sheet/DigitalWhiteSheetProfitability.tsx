import {
  PROFITABILITY_NOT_CALCULATED_MESSAGE,
  PROFITABILITY_ROUND_UNBOUND_MESSAGE,
} from "@/lib/profitability/format";
import type { DigitalWhiteSheetProfitability as ProfitabilityReadState } from "@/lib/white-sheet";

/**
 * Read-only P3 profitability block. Renders the preformatted Thai snapshot
 * from the page model — no COGS/P/L recalculation in React.
 */
export function DigitalWhiteSheetProfitability({
  profitability,
}: {
  profitability: ProfitabilityReadState;
}) {
  if (profitability.state === "round_unbound") {
    return (
      <section
        className="rounded-xl border border-slate-200 bg-slate-50 p-4"
        data-testid="white-sheet-profitability"
        data-profitability-state="round_unbound"
      >
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          กำไร/ขาดทุน
        </h4>
        <p className="mt-2 text-sm text-slate-600">{PROFITABILITY_ROUND_UNBOUND_MESSAGE}</p>
      </section>
    );
  }

  if (profitability.state === "not_calculated") {
    return (
      <section
        className="rounded-xl border border-slate-200 bg-slate-50 p-4"
        data-testid="white-sheet-profitability"
        data-profitability-state="not_calculated"
      >
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          กำไร/ขาดทุน
        </h4>
        <p className="mt-2 text-sm text-slate-600">{PROFITABILITY_NOT_CALCULATED_MESSAGE}</p>
      </section>
    );
  }

  const incomplete = profitability.snapshot.certificationState === "INCOMPLETE";

  return (
    <section
      className={
        incomplete
          ? "rounded-xl border-2 border-amber-300 bg-amber-50 p-4"
          : "rounded-xl border border-slate-200 bg-white p-4"
      }
      data-testid="white-sheet-profitability"
      data-profitability-state="available"
      data-certification-state={profitability.snapshot.certificationState}
    >
      <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
        กำไร/ขาดทุน
      </h4>
      {incomplete && (
        <p
          className="mb-2 text-sm font-semibold text-amber-900"
          data-testid="white-sheet-profitability-incomplete"
        >
          ผลกำไร/ขาดทุนนี้ยังไม่ได้รับการรับรอง
        </p>
      )}
      <pre
        className="whitespace-pre-wrap break-words font-sans text-sm text-slate-800"
        data-testid="white-sheet-profitability-formatted"
      >
        {profitability.formatted}
      </pre>
    </section>
  );
}
