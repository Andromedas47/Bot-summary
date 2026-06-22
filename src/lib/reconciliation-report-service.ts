import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { displayMarketName } from "@/lib/market";
import {
  deriveReconciliationStatus,
  filterByStatus,
  summarizeReconciliationReport,
  type ReconciliationReportRow,
  type ReconciliationStatusFilter,
  type ReconciliationSummary,
} from "@/lib/reconciliation-report";

type Supabase = SupabaseClient<Database>;

export interface ReconciliationReportFilters {
  /** Inclusive business_date lower bound (ISO yyyy-mm-dd). */
  fromDate: string;
  /** Inclusive business_date upper bound (ISO yyyy-mm-dd). */
  toDate:   string;
  /** Exact market label to keep (matched against the derived market). */
  market?:  string;
  status?:  ReconciliationStatusFilter;
}

export interface ReconciliationReportResult {
  rows:    ReconciliationReportRow[];
  summary: ReconciliationSummary;
  /** Distinct markets present in the date range, before market/status filtering. */
  markets: string[];
}

function keyOf(sourceId: string, businessDate: string): string {
  return `${sourceId}|${businessDate}`;
}

/**
 * Fetch and aggregate the reconciliation report for a business-date range.
 *
 * Reads three tables and joins them in memory on (source_id, business_date):
 *  - transfer_reconciliations: the canonical computed financials.
 *  - manual_slip_sessions:     market label + open-session detection.
 *  - settlement_entries:       market-name fallback + activity detection.
 *
 * Rows with activity but no reconciliation row surface as "missing_data".
 * All status/summary logic is delegated to the shared reconciliation-report
 * module so the page and the Excel export stay consistent.
 */
export async function fetchReconciliationReport(
  supabase: Supabase,
  filters:  ReconciliationReportFilters,
): Promise<ReconciliationReportResult> {
  const { fromDate, toDate } = filters;

  const [reconRes, sessionRes, settlementRes] = await Promise.all([
    supabase
      .from("transfer_reconciliations")
      .select(
        "source_id, business_date, ai_verified_total, manual_slip_total, checked_slip_total, submitted_transfer_total, difference, matched",
      )
      .gte("business_date", fromDate)
      .lte("business_date", toDate),
    supabase
      .from("manual_slip_sessions")
      .select("source_id, business_date, market_label, status")
      .gte("business_date", fromDate)
      .lte("business_date", toDate),
    supabase
      .from("settlement_entries")
      .select("source_id, settlement_date, market_name")
      .gte("settlement_date", fromDate)
      .lte("settlement_date", toDate),
  ]);

  if (reconRes.error)      throw new Error(`transfer_reconciliations query failed: ${reconRes.error.message}`);
  if (sessionRes.error)    throw new Error(`manual_slip_sessions query failed: ${sessionRes.error.message}`);
  if (settlementRes.error) throw new Error(`settlement_entries query failed: ${settlementRes.error.message}`);

  // Market label + open-session map keyed by (source_id, business_date).
  const marketByKey   = new Map<string, string>();
  const openSessions  = new Set<string>();
  const activityKeys  = new Map<string, { source_id: string; business_date: string }>();

  for (const s of sessionRes.data ?? []) {
    const k = keyOf(s.source_id, s.business_date);
    activityKeys.set(k, { source_id: s.source_id, business_date: s.business_date });
    if (s.status === "open") openSessions.add(k);
    const label = displayMarketName(s.market_label, "");
    if (label && !marketByKey.has(k)) marketByKey.set(k, label);
  }

  for (const e of settlementRes.data ?? []) {
    if (!e.source_id) continue;
    const k = keyOf(e.source_id, e.settlement_date);
    activityKeys.set(k, { source_id: e.source_id, business_date: e.settlement_date });
    const label = displayMarketName(e.market_name, "");
    if (label && !marketByKey.has(k)) marketByKey.set(k, label);
  }

  // Index reconciliation rows by key; they are the canonical financials.
  const reconByKey = new Map<string, (typeof reconRes.data)[number]>();
  for (const r of reconRes.data ?? []) {
    const k = keyOf(r.source_id, r.business_date);
    reconByKey.set(k, r);
    activityKeys.set(k, { source_id: r.source_id, business_date: r.business_date });
  }

  // Build one report row per unique (source_id, business_date).
  const rows: ReconciliationReportRow[] = [];

  for (const [k, { source_id, business_date }] of activityKeys) {
    const recon              = reconByKey.get(k) ?? null;
    const hasOpenManualSess  = openSessions.has(k);
    const market             = marketByKey.get(k) ?? source_id;

    const difference = recon ? Number(recon.difference) : null;
    const status = deriveReconciliationStatus({
      hasReconciliation:    recon != null,
      hasOpenManualSession: hasOpenManualSess,
      difference,
    });

    rows.push({
      source_id,
      business_date,
      market,
      submitted_transfer_total: recon ? Number(recon.submitted_transfer_total) : null,
      ai_verified_total:        recon ? Number(recon.ai_verified_total) : null,
      manual_slip_total:        recon ? Number(recon.manual_slip_total) : null,
      checked_slip_total:       recon ? Number(recon.checked_slip_total) : null,
      difference,
      status,
      has_open_manual_session:  hasOpenManualSess,
    });
  }

  // Stable sort: newest business_date first, then market.
  rows.sort(
    (a, b) =>
      b.business_date.localeCompare(a.business_date) ||
      a.market.localeCompare(b.market, "th"),
  );

  // Distinct markets across the whole range (pre market/status filter) for the dropdown.
  const markets = Array.from(new Set(rows.map((r) => r.market))).sort((a, b) =>
    a.localeCompare(b, "th"),
  );

  // Apply market then status filters in memory (market is a derived value).
  let filtered = filters.market
    ? rows.filter((r) => r.market === filters.market)
    : rows;
  filtered = filterByStatus(filtered, filters.status);

  return {
    rows:    filtered,
    summary: summarizeReconciliationReport(filtered),
    markets,
  };
}
