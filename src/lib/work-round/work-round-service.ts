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

// Statuses for which a standalone "รายการเบิกเพิ่ม" can attach another produce batch.
// Only while the round is still in the produce stage — i.e. before ปิดรอบ / ยืนยันปิดรอบ
// (→ awaiting_settlement). Once the money/slip flow has begun the borrow total is locked.
//
// `needs_correction` is intentionally EXCLUDED: under V2 it occurs AFTER the round has been
// closed / settled (e.g. a later "คืนเพิ่ม" reopens it for review). Allowing produce append
// there would silently change the borrow total after slips and settlement already started.
// Corrections must go through a deliberate command/flow (เช่น ชั่งคืนเพิ่ม) or a reviewer action.
export const PRODUCE_APPEND_ELIGIBLE_STATUSES: WorkRoundStatus[] = [
  "open",
  "produce_complete",
];

// Statuses for which a standalone "ชั่งคืนเพิ่ม" (append RETURN) can attach.
//
// Unlike produce append, a late return is the intended V2 correction path through
// the produce stage and AFTER close / settlement submission: it attaches a return
// session and reopens the round to needs_correction (see WorkRoundStatusService
// "produce_reopened").
//
// This is an EXPLICIT allowlist, NOT "everything except approved". It is declared
// as an exhaustive Record over WorkRoundStatus, so adding a new status to the enum
// (e.g. cancelled / rejected / void / archived) will FAIL THE BUILD here until
// someone deliberately classifies it. A new/unknown status is never silently
// allowed to receive a return append.
const RETURN_APPEND_ELIGIBILITY: Record<WorkRoundStatus, boolean> = {
  open:                true,  // ยังเปิดรอบอยู่
  produce_complete:    true,  // ชั่งเบิกครบ ยังไม่ปิดรอบ
  awaiting_settlement: true,  // หลังปิดรอบ (รอส่งเงิน)
  awaiting_slips:      true,  // หลังยืนยันส่งเงิน (settlement submitted, รอสลิป)
  needs_correction:    true,  // ถูกเปิดให้แก้ไขแล้ว — รับคืนเพิ่มต่อได้
  variance_found:      false, // อยู่ระหว่างกระทบยอดสลิป — ใช้ reviewer action
  ready_for_review:    false, // รอผู้ตรวจอนุมัติ — ใช้ reviewer action
  approved:            false, // ปิดงานแล้ว — ล็อก
};

export const RETURN_APPEND_ELIGIBLE_STATUSES: WorkRoundStatus[] =
  (Object.keys(RETURN_APPEND_ELIGIBILITY) as WorkRoundStatus[])
    .filter((status) => RETURN_APPEND_ELIGIBILITY[status]);

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
  | { mode: "blocked"; candidates: WorkRound[] }   // rounds exist for this date but none are eligible
  | { mode: "legacy" }    // deliberate legacy caller only
  | { mode: "error"; error: string };

export interface ResolveForIntentParams {
  sourceId: string;
  businessDate: string;
  allowedStatuses: WorkRoundStatus[];
  sellerName?: string;
  marketName?: string;
}

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
        status:        "open",
        source_meta:   sourceMeta ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(`work_round insert failed: ${error.message}`);
    return { workRound: created as WorkRound, created: true };
  }

  // Returns Work Rounds still eligible for a standalone produce-append marker.
  // businessDate is optional: when omitted, all dates are searched (for generic
  // append headers that carry no date — the round's own date is authoritative).
  async findProduceAppendEligibleRounds(
    sourceId:      string,
    businessDate?: string,
  ): Promise<WorkRound[]> {
    let q = this.supabase
      .from("work_rounds")
      .select("*")
      .eq("source_id", sourceId)
      .in("status", PRODUCE_APPEND_ELIGIBLE_STATUSES);
    if (businessDate) q = q.eq("business_date", businessDate);
    const { data } = await q.order("round_seq", { ascending: true });
    return (data ?? []) as WorkRound[];
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

  /**
   * Resolves the Work Round for an explicit produce-append header
   * ("seller-market รายการเบิกเพิ่ม|เบิกเพิ่ม date").
   *
   * Scoped to sourceId + businessDate + seller + market. Only append-eligible
   * statuses match. Never creates a round; never picks latest on ambiguity.
   */
  async resolveExplicitProduceAppend(params: ResolveParams): Promise<DisambiguationResult> {
    const { sourceId, businessDate, sellerName, marketName } = params;
    const rounds = (await this.findProduceAppendEligibleRounds(sourceId, businessDate))
      .filter((r) => r.seller_name === sellerName && r.market_name === marketName);

    if (rounds.length === 0) return { status: "none" };
    if (rounds.length === 1) return { status: "resolved", workRound: rounds[0] };
    return { status: "ambiguous", candidates: rounds };
  }

  /**
   * Resolves the Work Round for a standalone "รายการเบิกเพิ่ม" marker.
   *
   * Strictly scoped to the SAME LINE group (`sourceId`) and the SAME
   * `business_date`. A candidate must also carry both seller_name and
   * market_name (identity) and be in an append-eligible status.
   *
   *  - no candidate            → "none"   (caller asks to open a fresh header)
   *  - exactly one candidate   → "resolved"
   *  - more than one candidate → "ambiguous" (caller asks which round)
   *
   * Fail-closed by design: it never falls back across business_date and never
   * silently picks the "latest" round. Appending to the wrong / a closed round
   * would change the locked borrow total, so ambiguity must surface to the user.
   */
  async resolveProduceAppendTarget(
    sourceId:      string,
    businessDate?: string,
  ): Promise<DisambiguationResult> {
    const hasIdentity = (r: WorkRound) =>
      r.seller_name.trim().length > 0 && r.market_name.trim().length > 0;

    const rounds = (await this.findProduceAppendEligibleRounds(sourceId, businessDate))
      .filter(hasIdentity);

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

  async resolveForIntent(params: ResolveForIntentParams): Promise<EvidenceResolution> {
    const {
      sourceId,
      businessDate,
      allowedStatuses,
      sellerName,
      marketName,
    } = params;

    let all: WorkRound[];
    try {
      all = await this.findAllRounds(sourceId, businessDate);
    } catch (err) {
      return { mode: "error", error: err instanceof Error ? err.message : String(err) };
    }

    const candidates = all.filter((round) => {
      if (sellerName && round.seller_name !== sellerName) return false;
      if (marketName && round.market_name !== marketName) return false;
      return true;
    });

    if (candidates.length === 0) return { mode: "no_round" };

    const eligible = candidates.filter((round) => allowedStatuses.includes(round.status));
    if (eligible.length === 0) return { mode: "blocked", candidates };
    if (eligible.length === 1) return { mode: "linked", workRound: eligible[0] };
    return { mode: "select", candidates: eligible };
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
    return this.resolveForIntent({
      sourceId,
      businessDate,
      allowedStatuses: EVIDENCE_ELIGIBLE_STATUSES,
      sellerName: opts.sellerName,
      marketName: opts.marketName,
    });
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

  // Builds a user-facing disambiguation prompt (Thai) for produce append.
  buildDisambiguationPrompt(candidates: WorkRound[]): string {
    const lines = ["มีหลายรายการที่เปิดอยู่ กรุณาส่งรายการที่มีหัว เช่น:"];
    for (const r of candidates) {
      lines.push(`• ${r.seller_name}-${r.market_name} รายการเบิกเพิ่ม ${formatSlashBeDate(r.business_date)}`);
    }
    lines.push("เพื่อระบุว่าเป็นรายการของใคร");
    return lines.join("\n");
  }

  buildNoExplicitAppendRoundPrompt(
    sellerName:   string,
    marketName:   string,
    businessDate: string,
  ): string {
    return [
      `ไม่พบรอบเบิกที่ยังเปิดอยู่ของ ${sellerName}-${marketName} วันที่ ${formatSlashBeDate(businessDate)}`,
      "กรุณาตรวจสอบชื่อ ตลาด และวันที่ หรือเปิดหัวเบิกใหม่ก่อน",
    ].join("\n");
  }

  buildNoExplicitProduceRoundPrompt(
    sellerName:   string,
    marketName:   string,
    businessDate: string,
  ): string {
    return [
      `ไม่พบรอบที่ตรงกับ ${sellerName} — ${marketName} วันที่ ${formatSlashBeDate(businessDate)}`,
      "กรุณาตรวจสอบชื่อ ตลาด และวันที่ หรือเปิดหัวเบิกก่อนชั่งคืน",
    ].join("\n");
  }

  // Builds a prompt for when no open Work Round is found for a generic header.
  buildNoRoundPrompt(): string {
    return [
      "ไม่พบรายการที่เปิดอยู่",
      "กรุณาส่งหัวรายการที่ระบุผู้ขายและตลาด เช่น:",
      "กี้-วัดทุ่งลานนา เบิก / เบิกเพิ่ม / ชั่งคืน / คืนเสีย 24/06/2569",
    ].join("\n");
  }

  buildNoAppendRoundPrompt(): string {
    return "ไม่พบรอบเบิกที่ยังเปิดอยู่สำหรับรายการเพิ่ม กรุณาเปิดหัวเบิกใหม่พร้อมชื่อและตลาด";
  }
}

function formatSlashBeDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return `${day}/${month}/${year + 543}`;
}
