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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

// ── Regex ──────────────────────────────────────────────────────────────────────

// Matches the settlement command line (case-insensitive, trimmed).
// Captures [1] = date string (Buddhist, DD/MM/YY or DD/MM/YYYY).
export const SETTLEMENT_CMD_RE =
  /^(?:ส่งเงิน|ปิดยอด)\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})\s*$/;

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
    const { data } = await this.supabase
      .from("work_rounds")
      .select("*")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .in("status", ["open", "produce_complete", "awaiting_settlement", "awaiting_evidence"])
      .order("round_seq", { ascending: true });

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
      .not("status", "in", "(\"approved\",\"needs_correction\")")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) return { draft: existing as SettlementDraft, created: false };

    const { data: created, error } = await this.supabase
      .from("settlement_drafts")
      .insert({
        work_round_id:            workRoundId,
        declared_via:             "line",
        declared_by_line_user_id: lineUserId,
      })
      .select()
      .single();

    if (error) throw new Error(`settlement_draft insert failed: ${error.message}`);
    return { draft: created as SettlementDraft, created: true };
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

  // Builds the settlement confirmation reply after amounts are recorded.
  buildSettlementConfirmReply(
    draft:  SettlementDraft,
    round:  WorkRound,
  ): string {
    const total =
      (draft.declared_transfer ?? 0) +
      (draft.declared_cash     ?? 0) +
      (draft.declared_expenses ?? 0) +
      (draft.declared_labor    ?? 0);

    const lines = [
      `รับยอดส่งเงิน ${round.seller_name} — ${round.market_name}`,
      `โอน: ${(draft.declared_transfer ?? 0).toLocaleString("th-TH")} บาท`,
      `สด: ${(draft.declared_cash ?? 0).toLocaleString("th-TH")} บาท`,
      `ค่าใช้จ่าย: ${(draft.declared_expenses ?? 0).toLocaleString("th-TH")} บาท`,
      `ค่าแรง: ${(draft.declared_labor ?? 0).toLocaleString("th-TH")} บาท`,
      `รวม: ${total.toLocaleString("th-TH")} บาท`,
      "",
      "รอการตรวจสอบจากเจ้าหน้าที่",
    ];
    return lines.join("\n");
  }
}
