/**
 * Settlement intake via LINE (V2).
 *
 * Users initiate settlement with a command such as:
 *   ส่งเงิน 24/06/2569
 *   ปิดยอด 24/06/2569
 *
 * Followed by (or included in the same message) declared amounts:
 *   โอน 730 สด 1420 ค่าใช้จ่าย 410 ค่าแรง 400
 *
 * Identity is always the Work Round, never seller+market text or source_id+date alone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SettlementDraft, WorkRound } from "@/lib/work-round/types";
import { SETTLEMENT_ELIGIBLE_STATUSES } from "@/lib/work-round/work-round-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

// A draft this old (since last update) is considered stale and is not reused by
// a bare follow-up amount message — prevents consuming unrelated later input.
const DRAFT_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours
const SETTLEMENT_RECEIVED_REPLY = "รับข้อมูลส่งเงินแล้ว รอตรวจสอบใบขาวและสลิป";
const SETTLEMENT_SUBMITTED_REPLY = "รับข้อมูลส่งเงินและหลักฐานแล้ว รอตรวจสอบ";

// ── Regex ──────────────────────────────────────────────────────────────────────

// Matches the settlement command line (case-insensitive, trimmed).
// Captures [1] = date string (Buddhist, DD/MM/YY or DD/MM/YYYY).
export const SETTLEMENT_CMD_RE =
  /^(?:ส่งเงิน|ปิดยอด)\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})\s*$/;

// Confirmation command that submits a declared draft for review.
export const SETTLEMENT_CONFIRM_RE = /^(?:ยืนยันส่งเงิน|ยืนยันยอด)\s*$/;

/** True if the text is a settlement confirmation command. */
export function isConfirmCommand(text: string): boolean {
  return SETTLEMENT_CONFIRM_RE.test(text.trim());
}

// Named-amount pattern applied individually against the full message text.
const TRANSFER_RE  = /โอน\s+(\d+(?:\.\d+)?)/;
const CASH_RE      = /(?:^|\s)สด\s+(\d+(?:\.\d+)?)/;
const EXPENSES_RE  = /ค่าใช้จ่าย\s+(\d+(?:\.\d+)?)/;
const LABOR_RE     = /ค่าแรง\s+(\d+(?:\.\d+)?)/;

export interface ParsedAmounts {
  transfer:  number | null;
  cash:      number | null;
  expenses:  number | null;
  labor:     number | null;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/** Returns the date string from a settlement command, or null if no match. */
export function parseSettlementCommand(text: string): string | null {
  const m = text.trim().match(SETTLEMENT_CMD_RE);
  return m ? m[1] : null;
}

/** Extracts declared amounts from free-text (same-message or follow-up). */
export function parseSettlementAmounts(text: string): ParsedAmounts {
  const extract = (re: RegExp) => {
    const m = text.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  return {
    transfer: extract(TRANSFER_RE),
    cash:     extract(CASH_RE),
    expenses: extract(EXPENSES_RE),
    labor:    extract(LABOR_RE),
  };
}

/** Returns true if at least one named amount was found in the text. */
export function hasAnyAmount(text: string): boolean {
  return (
    TRANSFER_RE.test(text) ||
    CASH_RE.test(text)     ||
    EXPENSES_RE.test(text) ||
    LABOR_RE.test(text)
  );
}

// ── Service ────────────────────────────────────────────────────────────────────

export class SettlementIntakeService {
  constructor(private readonly supabase: AnyClient) {}

  // Returns Work Rounds eligible to receive a settlement declaration.
  async findEligibleRounds(sourceId: string, businessDate: string): Promise<WorkRound[]> {
    const { data, error } = await this.supabase
      .from("work_rounds")
      .select("*")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .in("status", SETTLEMENT_ELIGIBLE_STATUSES)
      .order("round_seq", { ascending: true });

    if (error) throw new Error(`settlement eligible round lookup failed: ${error.message}`);
    return (data ?? []) as WorkRound[];
  }

  // Opens a settlement draft for a Work Round, or returns the existing open draft.
  async openDraft(
    workRoundId: string,
    lineUserId:  string | null,
  ): Promise<{ draft: SettlementDraft; created: boolean }> {
    const { data: existing } = await this.supabase
      .from("settlement_drafts")
      .select("*")
      .eq("work_round_id", workRoundId)
      .in("status", ["pending", "declared"])
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) return { draft: existing as SettlementDraft, created: false };

    const { data: created, error } = await this.supabase
      .from("settlement_drafts")
      .insert({
        work_round_id:            workRoundId,
        status:                   "pending",
        declared_via:             "line",
        declared_by_line_user_id: lineUserId,
      })
      .select()
      .single();

    if (error) throw new Error(`settlement_draft insert failed: ${error.message}`);
    return { draft: created as SettlementDraft, created: true };
  }

  // Finds the open (pending/declared) draft for THIS sender in this group.
  // Used to attach a follow-up amounts/confirm message to the right draft.
  // Filters by declared_by_line_user_id so a different sender never touches it,
  // and ignores stale drafts so old drafts don't consume unrelated input.
  async findOpenDraftForSender(
    sourceId:   string,
    lineUserId: string | null,
  ): Promise<{ draft: SettlementDraft; round: WorkRound } | null> {
    const drafts = await this.findOpenDraftsForSender(sourceId, lineUserId);
    return drafts.length === 1 ? drafts[0] : null;
  }

  async findOpenDraftsForSender(
    sourceId:   string,
    lineUserId: string | null,
  ): Promise<Array<{ draft: SettlementDraft; round: WorkRound }>> {
    if (!lineUserId) return [];

    // Rounds in this group still eligible for settlement.
    const { data: rounds, error: roundError } = await this.supabase
      .from("work_rounds")
      .select("*")
      .eq("source_id", sourceId)
      .in("status", SETTLEMENT_ELIGIBLE_STATUSES);

    if (roundError) throw new Error(`settlement draft round lookup failed: ${roundError.message}`);

    const roundList = (rounds ?? []) as WorkRound[];
    if (roundList.length === 0) return [];
    const roundById = new Map(roundList.map((r) => [r.id, r]));

    let q = this.supabase
      .from("settlement_drafts")
      .select("*")
      .in("work_round_id", roundList.map((r) => r.id))
      .in("status", ["pending", "declared"]);

    q = lineUserId === null
      ? q.is("declared_by_line_user_id", null)
      : q.eq("declared_by_line_user_id", lineUserId);

    const { data: drafts, error: draftError } = await q.order("updated_at", { ascending: false });
    if (draftError) throw new Error(`settlement draft lookup failed: ${draftError.message}`);

    const out: Array<{ draft: SettlementDraft; round: WorkRound }> = [];
    for (const draft of (drafts ?? []) as SettlementDraft[]) {
      if (Date.now() - new Date(draft.updated_at).getTime() > DRAFT_STALE_MS) continue;
      const round = roundById.get(draft.work_round_id);
      if (round) out.push({ draft, round });
    }
    return out;
  }

  // Marks a declared draft submitted (user confirmed via ยืนยันส่งเงิน).
  async confirmDraft(draftId: string, lineUserId: string | null): Promise<SettlementDraft> {
    const { data: current } = await this.supabase
      .from("settlement_drafts")
      .select("*")
      .eq("id", draftId)
      .single();

    if (!current || current.status !== "declared") {
      throw new Error("settlement draft is not ready to confirm");
    }

    if (current) {
      await this.supabase.from("settlement_draft_history").insert({
        draft_id:      draftId,
        changed_by:    lineUserId,
        change_type:   "submitted",
        previous_data: current,
        new_data:      { status: "submitted" },
      });
    }

    const { data: updated, error } = await this.supabase
      .from("settlement_drafts")
      .update({ status: "submitted", updated_at: new Date().toISOString() })
      .eq("id", draftId)
      .eq("status", "declared")
      .select()
      .single();

    if (error) throw new Error(`settlement_draft confirm failed: ${error.message}`);
    return updated as SettlementDraft;
  }

  // Records declared amounts onto an existing draft.
  // Writes the prior state to history before overwriting.
  async recordDeclared(
    draftId:    string,
    amounts:    ParsedAmounts,
    lineUserId: string | null,
  ): Promise<SettlementDraft> {
    const { data: current } = await this.supabase
      .from("settlement_drafts")
      .select("*")
      .eq("id", draftId)
      .single();

    if (!current || !["pending", "declared"].includes(String(current.status))) {
      throw new Error("settlement draft is not actionable");
    }

    if (current) {
      await this.supabase.from("settlement_draft_history").insert({
        draft_id:      draftId,
        changed_by:    lineUserId,
        change_type:   "declared_update",
        previous_data: current,
        new_data:      { ...amounts },
      });
    }

    const patch: Record<string, unknown> = {
      declared_by_line_user_id: lineUserId,
      status:                   "declared",
      version:                  ((current?.version as number) ?? 1) + 1,
      updated_at:               new Date().toISOString(),
    };
    if (amounts.transfer  != null) patch.declared_transfer  = amounts.transfer;
    if (amounts.cash      != null) patch.declared_cash      = amounts.cash;
    if (amounts.expenses  != null) patch.declared_expenses  = amounts.expenses;
    if (amounts.labor     != null) patch.declared_labor     = amounts.labor;

    const { data: updated, error } = await this.supabase
      .from("settlement_drafts")
      .update(patch)
      .eq("id", draftId)
      .select()
      .single();

    if (error) throw new Error(`settlement_draft update failed: ${error.message}`);
    return updated as SettlementDraft;
  }

  // Builds the round-selection reply when multiple Work Rounds are eligible.
  buildSelectionPrompt(rounds: WorkRound[], dateStr: string): string {
    if (rounds.length === 0) {
      return [
        `ไม่พบรายการที่เปิดอยู่สำหรับวันที่ ${dateStr}`,
        "กรุณาส่งรายการเบิกก่อน",
      ].join("\n");
    }
    const lines = [`มีรายการสำหรับวันที่ ${dateStr}:`];
    rounds.forEach((r, i) => lines.push(`${i + 1}. ${r.seller_name} — ${r.market_name}`));
    lines.push("\nพิมพ์หมายเลข เช่น 1 เพื่อเลือก");
    return lines.join("\n");
  }

  // Builds the prompt asking the user to send declared amounts.
  buildAmountsPrompt(round: WorkRound): string {
    return [
      `เปิดรายการส่งเงิน ${round.seller_name} — ${round.market_name}`,
      "ส่งยอด เช่น",
      "โอน 730 สด 1420 ค่าใช้จ่าย 410 ค่าแรง 400",
    ].join("\n");
  }

  private draftLines(draft: SettlementDraft): string[] {
    const total =
      (draft.declared_transfer ?? 0) +
      (draft.declared_cash     ?? 0) +
      (draft.declared_expenses ?? 0) +
      (draft.declared_labor    ?? 0);
    return [
      `โอน: ${(draft.declared_transfer ?? 0).toLocaleString("th-TH")} บาท`,
      `สด: ${(draft.declared_cash ?? 0).toLocaleString("th-TH")} บาท`,
      `ค่าใช้จ่าย: ${(draft.declared_expenses ?? 0).toLocaleString("th-TH")} บาท`,
      `ค่าแรง: ${(draft.declared_labor ?? 0).toLocaleString("th-TH")} บาท`,
      `รวม: ${total.toLocaleString("th-TH")} บาท`,
    ];
  }

  // Review summary after amounts recorded — asks the user to confirm.
  buildReviewSummary(_draft: SettlementDraft, _round: WorkRound): string {
    void _draft;
    void _round;
    return [
      SETTLEMENT_RECEIVED_REPLY,
      "พิมพ์ ยืนยันส่งเงิน เพื่อส่งให้ผู้ตรวจสอบ",
    ].join("\n");
  }

  // Final reply once the user confirms the declared settlement.
  buildSubmittedReply(_draft: SettlementDraft, _round: WorkRound): string {
    void _draft;
    void _round;
    return SETTLEMENT_SUBMITTED_REPLY;
  }

  // Backward-compatible alias retained for existing callers/tests.
  buildSettlementConfirmReply(draft: SettlementDraft, round: WorkRound): string {
    return this.buildReviewSummary(draft, round);
  }
}
