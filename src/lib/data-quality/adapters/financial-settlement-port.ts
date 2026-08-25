/**
 * Financial Settlement port — a narrow adapter for a signal source that does
 * not exist yet.
 *
 * A concurrent worker is building `getDailyFinancialSettlement(businessDate,
 * ...)` on branch `feat/daily-financial-settlement`. That branch is not
 * available here, so this file defines the SHAPE the Data Quality scan needs
 * from it and ships a no-op default. Wiring the real thing later is a
 * one-file change: implement `FinancialSettlementPort` against the finished
 * function and pass it into `scanDataQualityIssues({ financialSettlementPort })`
 * — nothing else in src/lib/data-quality changes.
 *
 * Every signal this port returns becomes exactly one candidate in the scan
 * (see scan.ts `mapFinancialSettlementSignals`) — none are ever dropped,
 * deduplicated by anything other than the normal issue-key rule, or
 * filtered by severity before being handed to the inbox.
 */

export type FinancialSettlementSignalKind = "mismatch" | "incomplete_evidence";

export interface FinancialSettlementSignal {
  kind: FinancialSettlementSignalKind;
  businessDate: string;
  /** Stable identifiers for the affected settlement scope (e.g. source id,
   *  accountability round id) — becomes part of the dedup key. */
  entityRefs: string[];
  /** Operator-safe Thai summary. No secrets. */
  summaryTh: string;
  technicalContext?: Record<string, unknown>;
}

export interface FinancialSettlementPort {
  getSignals(businessDate: string): Promise<FinancialSettlementSignal[]>;
}

/** Default until `feat/daily-financial-settlement` lands. Never drops signals
 *  because it never has any to drop — it always answers "nothing to report". */
export const noopFinancialSettlementPort: FinancialSettlementPort = {
  async getSignals(): Promise<FinancialSettlementSignal[]> {
    return [];
  },
};
