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

// business_date (ISO) 04:00 Bangkok = prev day 21:00 UTC.
export function businessDateToUtcRange(businessDate: string): { startUtc: string; endUtc: string } {
  const [y, m, d] = businessDate.split("-").map(Number);
  const prevDay = new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
  return {
    startUtc: `${prevDay}T21:00:00Z`,
    endUtc:   `${businessDate}T21:00:00Z`,
  };
}

async function computeAiVerifiedTotal(
  supabase:     Supabase,
  sourceId:     string,
  businessDate: string,
): Promise<number> {
  const { startUtc, endUtc } = businessDateToUtcRange(businessDate);

  // ponytail: validation flags (outlier, date-mismatch) are not persisted — can't filter here.
  // Tighten this query if/when validation flags are stored on slip_checks.
  const { data: evidences } = await supabase
    .from("slip_evidences")
    .select("id")
    .eq("source_id", sourceId)
    .gte("received_at", startUtc)
    .lt("received_at", endUtc);

  const evidenceIds = (evidences ?? []).map(e => e.id);
  if (evidenceIds.length === 0) return 0;

  const { data: checks } = await supabase
    .from("slip_checks")
    .select("id, transfer_amount, reference_id")
    .in("evidence_id", evidenceIds)
    .in("status", ["EXTRACTED", "PARTIAL_EXTRACTED"])
    .not("transfer_amount", "is", null);

  // Cross-group/cross-market guard: the same bank transaction id may have
  // already been accepted under a different source_id or business_date.
  // ponytail: best-effort (no unique constraint on reference_id backs this
  // yet — see schema gap report), but a single batched query resolves the
  // globally-earliest accepted check per distinct reference id in this scope.
  const distinctRefs = [...new Set(
    (checks ?? [])
      .map((c) => normalizeTransactionId(c.reference_id))
      .filter((ref): ref is string => ref !== null),
  )];
  const globalWinners = await resolveGloballyAcceptedCheckIds(supabase, distinctRefs);

  // Duplicate slip guard: the same slip submitted twice (even across batches
  // in the same business day) extracts the same bank reference_id — count each
  // distinct reference once. Checks without a visible reference cannot be
  // distinguished from one another and are summed individually.
  const seenReferences = new Set<string>();
  let total = 0;
  for (const c of checks ?? []) {
    const ref = normalizeTransactionId(c.reference_id);
    if (ref) {
      if (seenReferences.has(ref)) continue;
      seenReferences.add(ref);
      if (globalWinners.size > 0 && !globalWinners.has(c.id)) continue;
    }
    total += Number(c.transfer_amount);
  }
  return total;
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
  const aiTotal     = round2(await computeAiVerifiedTotal(supabase, sourceId, businessDate));
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
