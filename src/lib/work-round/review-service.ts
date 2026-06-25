import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { tryFinalizeWorkRound, type FinalizeWorkRoundResult } from "./finalizer";
import { WorkRoundStatusService } from "./status";
import type { SettlementDraft, WorkRound } from "./types";

type Supabase = SupabaseClient<Database>;

export type ReviewAction = "approve" | "needs_correction";

export type ReviewResult =
  | { ok: true; finalizeStatus?: FinalizeWorkRoundResult }
  | { ok: false; status: number; error: string };

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

async function loadRound(supabase: Supabase, workRoundId: string): Promise<WorkRound | null> {
  const { data, error } = await supabase
    .from("work_rounds")
    .select("*")
    .eq("id", workRoundId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as WorkRound | null) ?? null;
}

async function loadLatestDraft(supabase: Supabase, workRoundId: string): Promise<SettlementDraft | null> {
  const { data, error } = await supabase
    .from("settlement_drafts")
    .select("*")
    .eq("work_round_id", workRoundId)
    .in("status", ["submitted", "variance_found", "ready_for_review", "approved", "needs_correction"])
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SettlementDraft | null) ?? null;
}

async function hasOpenEvidence(supabase: Supabase, workRoundId: string): Promise<boolean> {
  const { data: manualOpen, error: manualErr } = await supabase
    .from("manual_slip_sessions")
    .select("id")
    .eq("work_round_id", workRoundId)
    .eq("status", "open")
    .limit(1);
  if (manualErr) throw new Error(manualErr.message);
  if ((manualOpen ?? []).length > 0) return true;

  const { data: activeBatches, error: batchErr } = await supabase
    .from("slip_batches")
    .select("id")
    .eq("work_round_id", workRoundId)
    .in("status", ["collecting", "closing", "processing"])
    .limit(1);
  if (batchErr) throw new Error(batchErr.message);
  return (activeBatches ?? []).length > 0;
}

export async function reviewWorkRound(
  supabase: Supabase,
  params: {
    workRoundId: string;
    action: ReviewAction;
    actor?: string | null;
    reason?: string | null;
    push?: Parameters<typeof tryFinalizeWorkRound>[2];
  },
): Promise<ReviewResult> {
  const now = new Date().toISOString();
  const round = await loadRound(supabase, params.workRoundId);
  if (!round) return { ok: false, status: 404, error: "work round not found" };

  if (params.action === "needs_correction") {
    if (round.status === "approved") {
      return { ok: false, status: 409, error: "approved rounds cannot be reopened automatically" };
    }
    const draft = await loadLatestDraft(supabase, params.workRoundId);
    if (draft) {
      if (draft.status === "approved") {
        return { ok: false, status: 409, error: "approved drafts cannot be reopened automatically" };
      }
      await supabase.from("settlement_draft_history").insert({
        draft_id: draft.id,
        changed_by: params.actor ?? null,
        change_type: "review_needs_correction",
        previous_data: toJson(draft),
        new_data: { status: "needs_correction", reason: params.reason ?? null },
      });
      await supabase
        .from("settlement_drafts")
        .update({ status: "needs_correction", updated_at: now })
        .eq("id", draft.id);
    }
    await new WorkRoundStatusService(supabase).applyEvent(params.workRoundId, "needs_correction");
    return { ok: true };
  }

  await tryFinalizeWorkRound(supabase, params.workRoundId, params.push);
  const [freshRound, draft] = await Promise.all([
    loadRound(supabase, params.workRoundId),
    loadLatestDraft(supabase, params.workRoundId),
  ]);
  if (!freshRound || !draft) return { ok: false, status: 409, error: "round is not ready for approval" };
  if (!["ready_for_review", "variance_found", "approved"].includes(freshRound.status)) {
    return { ok: false, status: 409, error: "round is not ready for approval" };
  }
  if (!["ready_for_review", "variance_found", "approved"].includes(draft.status)) {
    return { ok: false, status: 409, error: "settlement draft is not ready for approval" };
  }
  if (await hasOpenEvidence(supabase, params.workRoundId)) {
    return { ok: false, status: 409, error: "evidence is still open" };
  }

  if (freshRound.status !== "approved" || draft.status !== "approved") {
    await supabase.from("settlement_draft_history").insert({
      draft_id: draft.id,
      changed_by: params.actor ?? null,
      change_type: "review_approved",
      previous_data: toJson(draft),
      new_data: { status: "approved", reason: params.reason ?? null },
    });
    await supabase
      .from("settlement_drafts")
      .update({
        status: "approved",
        approved_by: params.actor ?? null,
        approved_at: now,
        updated_at: now,
      })
      .eq("id", draft.id)
      .in("status", ["ready_for_review", "variance_found"]);
    await new WorkRoundStatusService(supabase).applyEvent(params.workRoundId, "approved");
  }

  const finalizeStatus = await tryFinalizeWorkRound(supabase, params.workRoundId, params.push);
  return { ok: true, finalizeStatus };
}
