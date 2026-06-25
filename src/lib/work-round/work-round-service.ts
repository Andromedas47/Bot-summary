import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkRound, SelectionCandidate, WorkRoundStatus } from "./types";
import { computeRoundTotals } from "./expected-sales";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

// Statuses for which a round can still receive a settlement declaration.
export const SETTLEMENT_ELIGIBLE_STATUSES: WorkRoundStatus[] = [
  "awaiting_settlement", "needs_correction",
];

// Statuses for which a round can still receive slip / manual-slip evidence.
export const EVIDENCE_ELIGIBLE_STATUSES: WorkRoundStatus[] = [
  "awaiting_slips", "variance_found", "ready_for_review", "needs_correction",
];

export interface ResolveParams {
  sourceId:     string;
  businessDate: string;
  sellerName:   string;
  marketName:   string;
  sourceMeta?:  Record<string, unknown>;
}

export interface ResolveResult {
  workRound: WorkRound;
  created:   boolean;
}

export type DisambiguationResult =
  | { status: "resolved"; workRound: WorkRound }
  | { status: "none" }
  | { status: "ambiguous"; candidates: WorkRound[] };

// Evidence (slip / manual slip) attachment decision.
export type EvidenceResolution =
  | { mode: "linked"; workRound: WorkRound }
  | { mode: "select"; candidates: WorkRound[] }
  | { mode: "no_round" }  // no rounds exist for this source/date
  | { mode: "blocked" }   // rounds exist for this date but none are eligible
  | { mode: "legacy" }    // deliberate legacy caller only
  | { mode: "error"; error: string };

export class WorkRoundService {
  constructor(private readonly supabase: AnyClient) {}

  // Finds the latest open Work Round for this seller+market, or creates one.
  async resolve(params: ResolveParams): Promise<ResolveResult> {
    const { sourceId, businessDate, sellerName, marketName, sourceMeta } = params;

    // Find an existing open round for this combination.
    const { data: existing } = await this.supabase
      .from("work_rounds")
      .select("*")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .eq("seller_name", sellerName)
      .eq("market_name", marketName)
      .eq("status", "open")
      .order("round_seq", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) return { workRound: existing as WorkRound, created: false };

    // Determine the next round_seq for this combination.
    const { data: maxRow } = await this.supabase
      .from("work_rounds")
      .select("round_seq")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .eq("seller_name", sellerName)
      .eq("market_name", marketName)
      .order("round_seq", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextSeq = maxRow ? (maxRow.round_seq as number) + 1 : 1;

    const { data: created, error } = await this.supabase
      .from("work_rounds")
      .insert({
        source_id:     sourceId,
        business_date: businessDate,
        seller_name:   sellerName,
        market_name:   marketName,
        round_seq:     nextSeq,
        source_meta:   sourceMeta ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(`work_round insert failed: ${error.message}`);
    return { workRound: created as WorkRound, created: true };
  }

  // Returns all open Work Rounds for a group+date.
  // Used to disambiguate generic headers.
  async findOpenRounds(sourceId: string, businessDate: string): Promise<WorkRound[]> {
    const { data } = await this.supabase
      .from("work_rounds")
      .select("*")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .eq("status", "open")
      .order("round_seq", { ascending: true });

    return (data ?? []) as WorkRound[];
  }

  // Resolves a generic header: returns the unique open round, none, or ambiguous.
  async disambiguateGeneric(sourceId: string, businessDate: string): Promise<DisambiguationResult> {
    const rounds = await this.findOpenRounds(sourceId, businessDate);
    if (rounds.length === 0) return { status: "none" };
    if (rounds.length === 1) return { status: "resolved", workRound: rounds[0] };
    return { status: "ambiguous", candidates: rounds };
  }

  // Returns all rounds for a group+date (any status).
  async findAllRounds(sourceId: string, businessDate: string): Promise<WorkRound[]> {
    const { data } = await this.supabase
      .from("work_rounds")
      .select("*")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .order("round_seq", { ascending: true });
    return (data ?? []) as WorkRound[];
  }

  // Returns rounds eligible to receive a settlement declaration.
  async findSettlementEligible(sourceId: string, businessDate: string): Promise<WorkRound[]> {
    const all = await this.findAllRounds(sourceId, businessDate);
    return all.filter((r) => SETTLEMENT_ELIGIBLE_STATUSES.includes(r.status));
  }

  /**
   * Decides how slip / manual-slip evidence should attach to a Work Round.
   *
   *  - no rounds exist for the date      → "no_round" (V2 must fail closed)
   *  - exactly one eligible (or a unique
   *    seller+market match)              → "linked"
   *  - more than one eligible            → "select" (caller opens pending selection)
   *  - rounds exist but none eligible    → "blocked"
   *
   * Fail-closed: if the work_rounds query throws, returns "error" so V2
   * evidence commands do not create null-linked financial records.
   */
  async resolveForEvidence(
    sourceId:     string,
    businessDate: string,
    opts:         { sellerName?: string; marketName?: string } = {},
  ): Promise<EvidenceResolution> {
    let all: WorkRound[];
    try {
      all = await this.findAllRounds(sourceId, businessDate);
    } catch (err) {
      return { mode: "error", error: err instanceof Error ? err.message : String(err) };
    }

    if (all.length === 0) return { mode: "no_round" };

    const eligible = all.filter((r) => EVIDENCE_ELIGIBLE_STATUSES.includes(r.status));
    if (eligible.length === 0) return { mode: "blocked" };

    // Prefer a unique seller+market match among the eligible rounds.
    if (opts.sellerName && opts.marketName) {
      const matched = eligible.filter(
        (r) => r.seller_name === opts.sellerName && r.market_name === opts.marketName,
      );
      if (matched.length === 1) return { mode: "linked", workRound: matched[0] };
    }

    if (eligible.length === 1) return { mode: "linked", workRound: eligible[0] };
    return { mode: "select", candidates: eligible };
  }

  // Links a slip batch to a Work Round (best-effort; logs but never throws).
  async linkSlipBatch(batchId: string, workRoundId: string): Promise<void> {
    await this.supabase.from("slip_batches").update({ work_round_id: workRoundId }).eq("id", batchId);
  }

  // Links a manual slip session to a Work Round.
  async linkManualSlipSession(sessionId: string, workRoundId: string): Promise<void> {
    await this.supabase.from("manual_slip_sessions").update({ work_round_id: workRoundId }).eq("id", sessionId);
  }

  // Builds selection candidates with expected sales for a numbered prompt.
  async buildCandidates(rounds: WorkRound[]): Promise<SelectionCandidate[]> {
    const out: SelectionCandidate[] = [];
    for (const r of rounds) {
      let expected = 0;
      try {
        expected = (await computeRoundTotals(this.supabase, r.id)).expected;
      } catch { /* expected sales is best-effort for the prompt */ }
      out.push({
        work_round_id: r.id,
        seller_name:   r.seller_name,
        market_name:   r.market_name,
        round_seq:     r.round_seq,
        expected_sales: expected,
      });
    }
    return out;
  }

  // Re-validates a chosen candidate still exists, belongs to source+date, and is
  // eligible for the given purpose. Returns the round or null.
  async validateChoice(
    workRoundId:  string,
    sourceId:     string,
    businessDate: string,
    eligible:     WorkRoundStatus[],
  ): Promise<WorkRound | null> {
    const { data } = await this.supabase
      .from("work_rounds")
      .select("*")
      .eq("id", workRoundId)
      .maybeSingle();
    if (!data) return null;
    const r = data as WorkRound;
    if (r.source_id !== sourceId || r.business_date !== businessDate) return null;
    if (!eligible.includes(r.status)) return null;
    return r;
  }

  // Attaches a produce_session to a Work Round after it has been persisted.
  async attachProduceSession(
    workRoundId: string,
    sessionId:   string,
    isAppend     = false,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("produce_sessions")
      .update({ work_round_id: workRoundId, is_append_session: isAppend })
      .eq("id", sessionId);

    if (error) throw new Error(`attach produce_session failed: ${error.message}`);
  }

  // Builds a user-facing disambiguation prompt (Thai).
  buildDisambiguationPrompt(candidates: WorkRound[]): string {
    const lines = ["มีหลายรายการที่เปิดอยู่ กรุณาส่งรายการที่มีหัว เช่น:"];
    for (const r of candidates) {
      lines.push(`• ${r.seller_name}-${r.market_name} เบิก`);
    }
    lines.push("เพื่อระบุว่าเป็นรายการของใคร");
    return lines.join("\n");
  }

  // Builds a prompt for when no open Work Round is found for a generic header.
  buildNoRoundPrompt(): string {
    return [
      "ไม่พบรายการที่เปิดอยู่",
      "กรุณาส่งหัวรายการที่ระบุผู้ขายและตลาด เช่น:",
      "กี้-วัดทุ่งลานนา เบิก 24/06/2569",
    ].join("\n");
  }
}
