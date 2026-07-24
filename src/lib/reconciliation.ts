import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeTransactionId, resolveGloballyAcceptedCheckIds } from "@/lib/slips/transaction-dedupe";
import type { Database, TransferReconciliationRow } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export interface ReconciliationResult {
  ai_verified_total:        number;
  manual_slip_total:        number;
  checked_slip_total:       number;
  submitted_transfer_total: number;
  difference:               number;
  matched:                  boolean;
}

export interface VerifiedTransferCheckRow {
  id:               string;
  evidence_id:      string;
  transfer_amount:  number;
  reference_id:     string | null;
  created_at:       string;
}

export interface MarketScopedVerifiedTransferResult {
  attributedTotal:           number;
  unresolvedAcceptedCount:   number;
  unresolvedAcceptedAmount:  number;
}

// business_date (ISO) 04:00 Bangkok = prev day 21:00 UTC.
export function businessDateToUtcRange(businessDate: string): { startUtc: string; endUtc: string } {
  const [y, m, d] = businessDate.split("-").map(Number);
  const prevDay = new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
  return {
    startUtc: `${prevDay}T21:00:00Z`,
    endUtc:   `${businessDate}T21:00:00Z`,
  };
}

/**
 * Applies global reference dedupe first, then optionally scopes accepted winners
 * to one normalized market label. Global dedupe always runs before market filter.
 */
export function aggregateGloballyAcceptedVerifiedTransfers(
  checks: readonly VerifiedTransferCheckRow[],
  evidenceMarketById: ReadonlyMap<string, string | null>,
  globalWinners: ReadonlySet<string>,
  options?: { marketLabelNormalized?: string },
): MarketScopedVerifiedTransferResult {
  const targetMarket = options?.marketLabelNormalized;
  const countedWinnerReferences = new Set<string>();
  let attributedTotal = 0;
  let unresolvedAcceptedCount = 0;
  let unresolvedAcceptedAmount = 0;

  for (const check of checks) {
    const ref = normalizeTransactionId(check.reference_id);
    if (ref) {
      if (!globalWinners.has(check.id) || countedWinnerReferences.has(ref)) continue;
      countedWinnerReferences.add(ref);
    }

    if (targetMarket === undefined) {
      attributedTotal += Number(check.transfer_amount);
      continue;
    }

    const evidenceMarket = evidenceMarketById.get(check.evidence_id) ?? null;
    if (!evidenceMarket) {
      unresolvedAcceptedCount += 1;
      unresolvedAcceptedAmount += Number(check.transfer_amount);
      continue;
    }
    if (evidenceMarket === targetMarket) {
      attributedTotal += Number(check.transfer_amount);
    }
  }

  return {
    attributedTotal,
    unresolvedAcceptedCount,
    unresolvedAcceptedAmount,
  };
}

async function loadVerifiedTransferChecksForSourceDate(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
): Promise<{
  checks: VerifiedTransferCheckRow[];
  evidenceMarketById: Map<string, string | null>;
}> {
  const { startUtc, endUtc } = businessDateToUtcRange(businessDate);

  const { data: evidences, error: evidenceError } = await supabase
    .from("slip_evidences")
    .select("id, market_label_normalized")
    .eq("source_id", sourceId)
    .gte("received_at", startUtc)
    .lt("received_at", endUtc);
  if (evidenceError) {
    throw new Error(`slip evidence query failed: ${evidenceError.message}`);
  }

  const evidenceMarketById = new Map<string, string | null>();
  for (const evidence of evidences ?? []) {
    evidenceMarketById.set(
      evidence.id,
      evidence.market_label_normalized?.normalize("NFC").trim() || null,
    );
  }

  const evidenceIds = [...evidenceMarketById.keys()];
  if (evidenceIds.length === 0) {
    return { checks: [], evidenceMarketById };
  }

  const { data: checks, error: checkError } = await supabase
    .from("slip_checks")
    .select("id, evidence_id, transfer_amount, reference_id, created_at")
    .in("evidence_id", evidenceIds)
    .in("status", ["EXTRACTED", "PARTIAL_EXTRACTED"])
    .not("transfer_amount", "is", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (checkError) {
    throw new Error(`slip check query failed: ${checkError.message}`);
  }

  return {
    checks: (checks ?? []) as VerifiedTransferCheckRow[],
    evidenceMarketById,
  };
}

async function resolveGlobalWinnersForChecks(
  supabase: Supabase,
  checks: readonly VerifiedTransferCheckRow[],
): Promise<Set<string>> {
  const distinctRefs = [...new Set(
    checks
      .map((c) => normalizeTransactionId(c.reference_id))
      .filter((ref): ref is string => ref !== null),
  )];
  const globalWinners = await resolveGloballyAcceptedCheckIds(supabase, distinctRefs);
  if (distinctRefs.length > 0 && globalWinners.size === 0) {
    throw new Error(
      "global reference resolution returned no winners for scoped financial totals",
    );
  }
  return globalWinners;
}

/**
 * Read-only verified-transfer loader shared by reconciliation and white-sheet
 * reporting. It keeps the globally earliest accepted check per non-empty
 * reference ID and deliberately makes no duplicate claim for missing IDs.
 */
export async function loadAiVerifiedTransferTotal(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
): Promise<number> {
  const { checks, evidenceMarketById } = await loadVerifiedTransferChecksForSourceDate(
    supabase,
    sourceId,
    businessDate,
  );
  if (checks.length === 0) return 0;

  const globalWinners = await resolveGlobalWinnersForChecks(supabase, checks);
  return aggregateGloballyAcceptedVerifiedTransfers(
    checks,
    evidenceMarketById,
    globalWinners,
  ).attributedTotal;
}

/**
 * Market-scoped verified-transfer loader for Digital White Sheet. Global dedupe
 * runs before market attribution; unattributed accepted winners are reported
 * separately and must trigger fail-closed handling upstream.
 */
export async function loadMarketScopedAiVerifiedTransfers(
  supabase:                Supabase,
  sourceId:                string,
  businessDate:            string,
  marketLabelNormalized:   string,
): Promise<MarketScopedVerifiedTransferResult> {
  const targetMarket = marketLabelNormalized.normalize("NFC").trim();
  if (!targetMarket) {
    throw new Error("marketLabelNormalized must not be empty");
  }

  const { checks, evidenceMarketById } = await loadVerifiedTransferChecksForSourceDate(
    supabase,
    sourceId,
    businessDate,
  );
  if (checks.length === 0) {
    return {
      attributedTotal: 0,
      unresolvedAcceptedCount: 0,
      unresolvedAcceptedAmount: 0,
    };
  }

  const globalWinners = await resolveGlobalWinnersForChecks(supabase, checks);
  return aggregateGloballyAcceptedVerifiedTransfers(
    checks,
    evidenceMarketById,
    globalWinners,
    { marketLabelNormalized: targetMarket },
  );
}

async function computeManualSlipTotal(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
): Promise<number> {
  const { data: sessions } = await supabase
    .from("manual_slip_sessions")
    .select("id")
    .eq("source_id", sourceId)
    .eq("business_date", businessDate)
    .eq("status", "closed");

  const sessionIds = (sessions ?? []).map(s => s.id);
  if (sessionIds.length === 0) return 0;

  const { data: entries } = await supabase
    .from("manual_slip_entries")
    .select("amount")
    .in("session_id", sessionIds);

  return (entries ?? []).reduce((sum, e) => sum + Number(e.amount), 0);
}

export async function reconcile(
  supabase:             Supabase,
  sourceId:             string,
  businessDate:         string,
  submittedTransfer:    number,
): Promise<{ blocked: true; reason: string } | { blocked: false; result: ReconciliationResult; row: TransferReconciliationRow }> {
  // Block if any open manual session exists.
  const { data: openSession } = await supabase
    .from("manual_slip_sessions")
    .select("id")
    .eq("source_id", sourceId)
    .eq("business_date", businessDate)
    .eq("status", "open")
    .maybeSingle();

  if (openSession) {
    return {
      blocked: true,
      reason: "มี session สลิปมือที่ยังเปิดอยู่ กรุณาพิมพ์ จบสลิปมือ ก่อน",
    };
  }

  // Amounts are numeric(10,2) in the DB but accumulate as binary floats here —
  // round to satang before comparing so 0.1 + 0.2 style drift never turns a
  // genuinely matched settlement into a false mismatch.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const aiTotal     = round2(await loadAiVerifiedTransferTotal(supabase, sourceId, businessDate));
  const manualTotal = round2(await computeManualSlipTotal(supabase, sourceId, businessDate));
  const checkedTotal = round2(aiTotal + manualTotal);
  const difference   = round2(submittedTransfer - checkedTotal);
  const matched      = difference === 0;

  const result: ReconciliationResult = {
    ai_verified_total:        aiTotal,
    manual_slip_total:        manualTotal,
    checked_slip_total:       checkedTotal,
    submitted_transfer_total: submittedTransfer,
    difference,
    matched,
  };

  const { data: row, error } = await supabase
    .from("transfer_reconciliations")
    .upsert(
      {
        source_id:                sourceId,
        business_date:            businessDate,
        ...result,
        updated_at:               new Date().toISOString(),
      },
      { onConflict: "source_id,business_date" },
    )
    .select()
    .single();

  if (error) throw new Error(`reconciliation upsert failed: ${error.message}`);

  return { blocked: false, result, row: row as TransferReconciliationRow };
}
