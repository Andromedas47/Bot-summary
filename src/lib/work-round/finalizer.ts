import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SlipCheckStatus, SlipType } from "@/types/database";
import { pushLineMessage } from "@/lib/line/reply";
import { buildFinalSettlementMessage } from "@/lib/line/settlement-message";
import { calculateSettlementTotals } from "@/lib/summary/transactions";
import { computeRoundTotals } from "./expected-sales";
import { WorkRoundStatusService } from "./status";
import type { SettlementDraft, WorkRound } from "./types";
import { logger } from "@/lib/logger";

type Supabase = SupabaseClient<Database>;
type PushFn = (to: string, text: string, retryKey?: string) => Promise<unknown>;

const defaultPush: PushFn = pushLineMessage;

export type FinalizeWorkRoundResult =
  | "finalized"
  | "review_pending"
  | "not_ready"
  | "already_done"
  | "failed";

interface EvidenceCheck {
  status: SlipCheckStatus | null;
  slip_type: SlipType | null;
  transfer_amount: number | null;
}

async function loadRound(supabase: Supabase, workRoundId: string): Promise<WorkRound | null> {
  const { data, error } = await supabase
    .from("work_rounds")
    .select("*")
    .eq("id", workRoundId)
    .maybeSingle();
  if (error) throw new Error(`work_round lookup failed: ${error.message}`);
  return (data as WorkRound | null) ?? null;
}

async function loadSubmittedDraft(supabase: Supabase, workRoundId: string): Promise<SettlementDraft | null> {
  const { data, error } = await supabase
    .from("settlement_drafts")
    .select("*")
    .eq("work_round_id", workRoundId)
    .in("status", ["submitted", "variance_found", "ready_for_review", "approved"])
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`settlement draft lookup failed: ${error.message}`);
  return (data as SettlementDraft | null) ?? null;
}

async function hasOpenEvidence(supabase: Supabase, workRoundId: string): Promise<boolean> {
  const { data: manualOpen, error: manualErr } = await supabase
    .from("manual_slip_sessions")
    .select("id")
    .eq("work_round_id", workRoundId)
    .eq("status", "open")
    .limit(1);
  if (manualErr) throw new Error(`manual slip lookup failed: ${manualErr.message}`);
  if ((manualOpen ?? []).length > 0) return true;

  const { data: activeBatches, error: batchErr } = await supabase
    .from("slip_batches")
    .select("id")
    .eq("work_round_id", workRoundId)
    .in("status", ["collecting", "closing", "processing"])
    .limit(1);
  if (batchErr) throw new Error(`slip batch lookup failed: ${batchErr.message}`);
  return (activeBatches ?? []).length > 0;
}

async function computeAiVerifiedTotal(supabase: Supabase, workRoundId: string): Promise<number> {
  const { data: batches, error: batchErr } = await supabase
    .from("slip_batches")
    .select("id")
    .eq("work_round_id", workRoundId)
    .in("status", ["completed", "review_needed", "failed"]);
  if (batchErr) throw new Error(`slip batch total lookup failed: ${batchErr.message}`);

  const batchIds = (batches ?? []).map((b) => b.id as string);
  if (batchIds.length === 0) return 0;

  const { data: evidences, error: evidenceErr } = await supabase
    .from("slip_evidences")
    .select("id")
    .in("batch_id", batchIds);
  if (evidenceErr) throw new Error(`slip evidence lookup failed: ${evidenceErr.message}`);

  const evidenceIds = (evidences ?? []).map((e) => e.id as string);
  if (evidenceIds.length === 0) return 0;

  const { data: checks, error: checkErr } = await supabase
    .from("slip_checks")
    .select("status, slip_type, transfer_amount")
    .in("evidence_id", evidenceIds)
    .in("status", ["EXTRACTED", "PARTIAL_EXTRACTED"])
    .not("transfer_amount", "is", null);
  if (checkErr) throw new Error(`slip check total lookup failed: ${checkErr.message}`);

  return ((checks ?? []) as EvidenceCheck[])
    .reduce((sum, c) => sum + Number(c.transfer_amount ?? 0), 0);
}

async function computeManualSlipTotal(supabase: Supabase, workRoundId: string): Promise<number> {
  const { data: sessions, error: sessionErr } = await supabase
    .from("manual_slip_sessions")
    .select("id")
    .eq("work_round_id", workRoundId)
    .eq("status", "closed");
  if (sessionErr) throw new Error(`manual slip total lookup failed: ${sessionErr.message}`);

  const sessionIds = (sessions ?? []).map((s) => s.id as string);
  if (sessionIds.length === 0) return 0;

  const { data: entries, error: entryErr } = await supabase
    .from("manual_slip_entries")
    .select("amount")
    .in("session_id", sessionIds);
  if (entryErr) throw new Error(`manual slip entry lookup failed: ${entryErr.message}`);

  return (entries ?? []).reduce((sum, e) => sum + Number(e.amount ?? 0), 0);
}

export async function tryFinalizeWorkRound(
  supabase: Supabase,
  workRoundId: string,
  push: PushFn = defaultPush,
): Promise<FinalizeWorkRoundResult> {
  const log = logger.child({ fn: "tryFinalizeWorkRound", workRoundId });
  const round = await loadRound(supabase, workRoundId);
  if (!round) return "not_ready";

  const draft = await loadSubmittedDraft(supabase, workRoundId);
  if (!draft) return "not_ready";
  if (await hasOpenEvidence(supabase, workRoundId)) return "not_ready";

  const [produceTotals, aiTotal, manualTotal] = await Promise.all([
    computeRoundTotals(supabase, workRoundId),
    computeAiVerifiedTotal(supabase, workRoundId),
    computeManualSlipTotal(supabase, workRoundId),
  ]);

  const checkedTotal = aiTotal + manualTotal;
  const submittedTransfer = draft.declared_transfer ?? 0;
  const difference = submittedTransfer - checkedTotal;
  const matched = difference === 0;
  const now = new Date().toISOString();

  const { error: recErr } = await supabase
    .from("transfer_reconciliations")
    .upsert({
      source_id: round.source_id,
      business_date: round.business_date,
      work_round_id: workRoundId,
      ai_verified_total: aiTotal,
      manual_slip_total: manualTotal,
      checked_slip_total: checkedTotal,
      submitted_transfer_total: submittedTransfer,
      difference,
      matched,
      updated_at: now,
    }, { onConflict: "work_round_id" });
  if (recErr) throw new Error(`work-round reconciliation upsert failed: ${recErr.message}`);

  await new WorkRoundStatusService(supabase).applyEvent(
    workRoundId,
    matched ? "reconciled_match" : "reconciled_variance",
  );

  const reviewStatus = matched ? "ready_for_review" : "variance_found";
  if (draft.status !== "approved") {
    await supabase
      .from("settlement_drafts")
      .update({ status: reviewStatus, updated_at: now })
      .eq("id", draft.id)
      .in("status", ["submitted", "variance_found", "ready_for_review"]);
    return "review_pending";
  }

  if (round.status !== "approved") return "review_pending";

  const { data: alreadySent } = await supabase
    .from("settlement_finalizations")
    .select("id, status, message_sent_at")
    .eq("work_round_id", workRoundId)
    .maybeSingle();
  if (alreadySent?.status === "sent" || alreadySent?.message_sent_at) return "already_done";

  const { data: inserted, error: insertErr } = await supabase
    .from("settlement_finalizations")
    .insert({
      source_id: round.source_id,
      business_date: round.business_date,
      work_round_id: workRoundId,
      status: "sending",
      claimed_at: now,
    })
    .select("id, line_retry_key")
    .maybeSingle();

  let claim = inserted as { id: string; line_retry_key: string } | null;
  if (!claim) {
    if (insertErr && !insertErr.message.includes("duplicate")) {
      throw new Error(`work-round finalization insert failed: ${insertErr.message}`);
    }
    const { data: existing } = await supabase
      .from("settlement_finalizations")
      .select("id, status, message_sent_at, line_retry_key")
      .eq("work_round_id", workRoundId)
      .maybeSingle();
    if (existing?.status === "sent" || existing?.message_sent_at) return "already_done";
    const { data: updated } = await supabase
      .from("settlement_finalizations")
      .update({ status: "sending", claimed_at: now, updated_at: now })
      .eq("work_round_id", workRoundId)
      .in("status", ["pending", "failed"])
      .select("id, line_retry_key")
      .maybeSingle();
    claim = updated as { id: string; line_retry_key: string } | null;
    if (!claim) return "not_ready";
  }

  const transactions = {
    เบิก: produceTotals.borrow,
    คืน: produceTotals.ret,
    คืนเสีย: produceTotals.badReturn,
    ยอดส่ง: produceTotals.expected,
  };
  const settlement = calculateSettlementTotals({
    ยอดส่ง: produceTotals.expected,
    money_transfer: draft.declared_transfer ?? 0,
    money_cash: draft.declared_cash ?? 0,
    expenses: draft.declared_expenses ?? 0,
    labor: draft.declared_labor ?? 0,
  });
  const message = buildFinalSettlementMessage({
    date: round.business_date,
    staffName: round.seller_name,
    marketName: round.market_name,
    transactions,
    settlement,
    reconciliation: {
      ai_verified_total: aiTotal,
      manual_slip_total: manualTotal,
      checked_slip_total: checkedTotal,
      submitted_transfer_total: submittedTransfer,
      difference,
      matched,
    },
    notes: draft.notes ?? "",
  });

  try {
    await push(round.source_id, message, claim.line_retry_key);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await supabase
      .from("settlement_finalizations")
      .update({ status: "failed", last_error: reason, updated_at: new Date().toISOString() })
      .eq("id", claim.id);
    log.warn("work-round final LINE push failed", { reason });
    return "failed";
  }

  const sentAt = new Date().toISOString();
  await supabase
    .from("settlement_finalizations")
    .update({ status: "sent", message_sent_at: sentAt, updated_at: sentAt })
    .eq("id", claim.id);
  return "finalized";
}
