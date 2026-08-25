/**
 * Financial reconciliation anomaly source — adapts the EXISTING slip/transfer
 * reconciliation report (src/lib/reconciliation-report.ts +
 * src/lib/reconciliation-report-service.ts) into Data Quality Inbox
 * candidates. The status derivation (`deriveReconciliationStatus`) is never
 * reimplemented here — this file only reads already-computed
 * `ReconciliationReportRow`s and relabels the non-matched ones.
 *
 * This is distinct from the future Financial Settlement port
 * (../adapters/financial-settlement-port.ts): reconciliation already exists
 * today and answers "does the submitted transfer match the checked slips for
 * this source/date", while the settlement port will answer a broader
 * close-time question once that work lands.
 */

import type { ReconciliationReportRow } from "@/lib/reconciliation-report";
import { STATUS_LABEL_TH } from "@/lib/reconciliation-report";
import type { DataQualityCategory } from "../severity";
import type { DataQualityIssueCandidate } from "../types";

function categoryFor(status: ReconciliationReportRow["status"]): DataQualityCategory | null {
  switch (status) {
    case "matched":
      return null;
    case "transfer_short":
    case "transfer_over":
      return "financial_reconciliation_mismatch";
    case "pending_review":
    case "missing_data":
      return "financial_evidence_incomplete";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function fmtBaht(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function summaryFor(row: ReconciliationReportRow): string {
  const label = STATUS_LABEL_TH[row.status];
  if (row.status === "transfer_short" || row.status === "transfer_over") {
    return `${row.market} — ${label} ${fmtBaht(row.difference !== null ? Math.abs(row.difference) : null)} บาท `
      + `(โอน ${fmtBaht(row.submitted_transfer_total)} / สลิปที่ตรวจแล้ว ${fmtBaht(row.checked_slip_total)})`;
  }
  return `${row.market} — ${label}`;
}

/** Pure: one already-loaded report's worth of rows, for one business date. */
export function reconciliationRowsToCandidates(
  rows: readonly ReconciliationReportRow[],
): DataQualityIssueCandidate[] {
  const out: DataQualityIssueCandidate[] = [];
  for (const row of rows) {
    const category = categoryFor(row.status);
    if (!category) continue;
    out.push({
      category,
      businessDate: row.business_date,
      entityRefs: [row.source_id],
      summaryTh: summaryFor(row),
      technicalContext: {
        reconciliationStatus: row.status,
        market: row.market,
        submittedTransferTotal: row.submitted_transfer_total,
        checkedSlipTotal: row.checked_slip_total,
        difference: row.difference,
        hasOpenManualSession: row.has_open_manual_session,
      },
    });
  }
  return out;
}
