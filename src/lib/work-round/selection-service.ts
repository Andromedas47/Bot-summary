/**
 * Pending Work Round selection state (V2 — P0).
 *
 * When more than one Work Round is eligible for a financial action, the bot
 * NEVER auto-picks. It stores the candidates here and waits for a numeric reply
 * from the SAME source_id + sender within the TTL.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SelectionIntent,
  SelectionCandidate,
  WorkRoundSelection,
} from "./types";
import { logger } from "@/lib/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Parses a bare numeric selection reply ("1".."99"). Returns null otherwise. */
export function parseNumericSelection(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 ? n : null;
}

export class WorkRoundSelectionService {
  constructor(private readonly supabase: AnyClient) {}

  // Expires any prior pending selection for this sender, then creates a new one.
  async create(params: {
    sourceId:     string;
    lineUserId:   string | null;
    businessDate: string;
    intent:       SelectionIntent;
    candidates:   SelectionCandidate[];
    payload?:     Record<string, unknown>;
    ttlMs?:       number;
  }): Promise<WorkRoundSelection> {
    if (!params.lineUserId) {
      throw new Error("selection requires a LINE userId");
    }
    await this.expireActiveFor(params.sourceId, params.lineUserId);

    const expiresAt = new Date(Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
    const { data, error } = await this.supabase
      .from("work_round_selections")
      .insert({
        source_id:     params.sourceId,
        line_user_id:  params.lineUserId,
        business_date: params.businessDate,
        intent:        params.intent,
        candidates:    params.candidates,
        payload:       params.payload ?? null,
        status:        "pending",
        created_at:    new Date().toISOString(),
        expires_at:    expiresAt,
      })
      .select()
      .single();

    if (error) throw new Error(`selection create failed: ${error.message}`);
    return data as WorkRoundSelection;
  }

  async claim(params: {
    selectionId: string;
    sourceId: string;
    lineUserId: string | null;
    choice: number;
    allowedStatuses: string[];
  }): Promise<WorkRoundSelection | null> {
    if (!params.lineUserId) return null;

    const rpc = (this.supabase as unknown as {
      rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    }).rpc?.bind(this.supabase);

    if (rpc) {
      const { data, error } = await rpc("claim_work_round_selection", {
        p_selection_id:     params.selectionId,
        p_source_id:        params.sourceId,
        p_line_user_id:     params.lineUserId,
        p_choice:           params.choice,
        p_allowed_statuses: params.allowedStatuses,
      });
      if (!error) {
        const rows = Array.isArray(data) ? data : data ? [data] : [];
        return (rows[0] as WorkRoundSelection | undefined) ?? null;
      }
      // PGRST202: function not found — migration 0040 not yet applied; fall through to JS path.
      if (!error.message.includes("does not exist") && !error.message.includes("Could not find the function")) {
        throw new Error(`selection claim failed: ${error.message}`);
      }
    }

    // Test-double fallback: production uses the RPC above.
    const active = await this.findActive(params.sourceId, params.lineUserId);
    if (!active || active.id !== params.selectionId) return null;
    const candidates = active.candidates as SelectionCandidate[];
    const candidate = candidates[params.choice - 1];
    if (!candidate) return null;
    const { data: round } = await this.supabase
      .from("work_rounds")
      .select("id, source_id, business_date, status")
      .eq("id", candidate.work_round_id)
      .maybeSingle();
    if (!round) return null;
    if (round.source_id !== params.sourceId) return null;
    if (round.business_date !== active.business_date) return null;
    if (!params.allowedStatuses.includes(String(round.status))) return null;
    await this.resolve(active.id, candidate.work_round_id);
    return { ...active, status: "resolved", resolved_work_round_id: candidate.work_round_id, resolved_at: new Date().toISOString() };
  }

  // Returns the active (pending, unexpired) selection for this sender, if any.
  async findActive(sourceId: string, lineUserId: string | null): Promise<WorkRoundSelection | null> {
    let q = this.supabase
      .from("work_round_selections")
      .select("*")
      .eq("source_id", sourceId)
      .eq("status", "pending");

    q = lineUserId === null ? q.is("line_user_id", null) : q.eq("line_user_id", lineUserId);

    const { data } = await q
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return null;
    const sel = data as WorkRoundSelection;
    if (new Date(sel.expires_at).getTime() <= Date.now()) {
      // Lazily expire a stale row so it cannot consume later numeric messages.
      await this.expire(sel.id);
      return null;
    }
    return sel;
  }

  async resolve(selectionId: string, workRoundId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from("work_round_selections")
      .update({ status: "resolved", resolved_work_round_id: workRoundId, resolved_at: now })
      .eq("id", selectionId)
      .eq("status", "pending");
    if (error) logger.warn("selection resolve failed", { selectionId, error: error.message });
  }

  async expire(selectionId: string): Promise<void> {
    await this.supabase
      .from("work_round_selections")
      .update({ status: "expired" })
      .eq("id", selectionId)
      .eq("status", "pending");
  }

  private async expireActiveFor(sourceId: string, lineUserId: string | null): Promise<void> {
    let q = this.supabase
      .from("work_round_selections")
      .update({ status: "expired" })
      .eq("source_id", sourceId)
      .eq("status", "pending");
    q = lineUserId === null ? q.is("line_user_id", null) : q.eq("line_user_id", lineUserId);
    await q;
  }
}

// ── Reply builders ─────────────────────────────────────────────────────────────

const INTENT_TITLE: Record<SelectionIntent, string> = {
  settlement:     "เลือกงวดที่จะส่งเงิน",
  produce_attach: "เลือกงวดสำหรับรายการนี้",
  slip:           "เลือกงวดสำหรับสลิป",
  manual_slip:    "เลือกงวดสำหรับสลิปมือ",
  close_round:    "เลือกงวดที่จะปิดรอบ",
  close_round_confirm: "ยืนยันงวดที่จะปิดรอบ",
};

/** Builds a numbered selection prompt with seller, market, round, and expected sales. */
export function buildSelectionMessage(intent: SelectionIntent, candidates: SelectionCandidate[]): string {
  const lines = [INTENT_TITLE[intent]];
  candidates.forEach((c, i) => {
    const roundPart = c.round_seq > 1 ? ` (รอบ ${c.round_seq})` : "";
    lines.push(
      `${i + 1}. ${c.seller_name} — ${c.market_name}${roundPart} | ยอดส่ง ${c.expected_sales.toLocaleString("th-TH")} บาท`,
    );
  });
  lines.push("");
  lines.push("พิมพ์หมายเลข เช่น 1");
  return lines.join("\n");
}
