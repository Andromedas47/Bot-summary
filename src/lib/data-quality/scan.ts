/**
 * Data Quality Inbox — the ONE scan/upsert function.
 *
 * Gathers candidates from every wired source (produce preflight, financial
 * reconciliation, and the not-yet-built Financial Settlement port), then
 * upserts each through inbox.ts. Called by the nightly cron
 * (src/app/api/cron/data-quality-scan/route.ts) and safe to call again for
 * the same business date any number of times — see inbox.ts for the
 * dedup/reopen/ignore rules that make repeated scans idempotent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import { fetchReconciliationReport } from "@/lib/reconciliation-report-service";
import { preflightIssuesToCandidates } from "./sources/preflight-source";
import { reconciliationRowsToCandidates } from "./sources/reconciliation-source";
import {
  noopFinancialSettlementPort,
  type FinancialSettlementPort,
  type FinancialSettlementSignal,
} from "./adapters/financial-settlement-port";
import { upsertDataQualityIssue, type UpsertResult } from "./inbox";
import type { DataQualityCategory } from "./severity";
import type { DataQualityIssueCandidate } from "./types";

type Supabase = SupabaseClient<Database>;

function categoryForSettlementSignal(kind: FinancialSettlementSignal["kind"]): DataQualityCategory {
  switch (kind) {
    case "mismatch":
      return "financial_settlement_mismatch";
    case "incomplete_evidence":
      return "financial_evidence_incomplete";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Pure: every settlement signal becomes exactly one candidate. None dropped. */
export function financialSettlementSignalsToCandidates(
  signals: readonly FinancialSettlementSignal[],
): DataQualityIssueCandidate[] {
  return signals.map((signal) => ({
    category: categoryForSettlementSignal(signal.kind),
    businessDate: signal.businessDate,
    entityRefs: signal.entityRefs,
    summaryTh: signal.summaryTh,
    technicalContext: signal.technicalContext,
  }));
}

export interface ScanDataQualityIssuesOptions {
  /** Injected for tests, or once feat/daily-financial-settlement lands. */
  financialSettlementPort?: FinancialSettlementPort;
}

export interface ScanDataQualityIssuesResult {
  businessDate: string;
  candidateCount: number;
  upserts: UpsertResult[];
}

export async function scanDataQualityIssues(
  supabase: Supabase,
  businessDate: string,
  options: ScanDataQualityIssuesOptions = {},
): Promise<ScanDataQualityIssuesResult> {
  const settlementPort = options.financialSettlementPort ?? noopFinancialSettlementPort;

  const [preflight, reconciliation, settlementSignals] = await Promise.all([
    runDailyClosePreflight(supabase, businessDate),
    fetchReconciliationReport(supabase, { fromDate: businessDate, toDate: businessDate }),
    settlementPort.getSignals(businessDate),
  ]);

  const candidates: DataQualityIssueCandidate[] = [
    ...preflightIssuesToCandidates(preflight, businessDate),
    ...reconciliationRowsToCandidates(reconciliation.rows),
    ...financialSettlementSignalsToCandidates(settlementSignals),
  ];

  const upserts: UpsertResult[] = [];
  for (const candidate of candidates) {
    upserts.push(await upsertDataQualityIssue(supabase, candidate));
  }

  return { businessDate, candidateCount: candidates.length, upserts };
}
