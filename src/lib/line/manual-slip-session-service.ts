import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ManualSlipSessionRow } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export type { ManualSlipSessionRow };

export class ManualSlipSessionService {
  constructor(private readonly supabase: Supabase) {}

  async findSession(sourceId: string, businessDate: string, marketKey: string): Promise<ManualSlipSessionRow | null> {
    const { data } = await this.supabase
      .from("manual_slip_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .eq("market_key", marketKey)
      .maybeSingle();
    return data;
  }

  // Returns the single open session for this source, if any.
  async findOpenSession(sourceId: string): Promise<ManualSlipSessionRow | null> {
    const { data } = await this.supabase
      .from("manual_slip_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("status", "open")
      .maybeSingle();
    return data;
  }

  async openSession(params: {
    sourceId:       string;
    businessDate:   string;
    marketKey:      string;
    marketLabel:    string | null;
    lineUserId:     string | null;
    lineMessageId:  string;
  }): Promise<{
    opened:  boolean;
    session: ManualSlipSessionRow | null;
    reason?: "same_market_exists" | "other_market_open";
  }> {
    // 1. Same market + date already has a session (open or closed)?
    const existing = await this.findSession(params.sourceId, params.businessDate, params.marketKey);
    if (existing) {
      return { opened: false, session: existing, reason: "same_market_exists" };
    }

    // 2. Any other session currently open for this source (different market / date)?
    //    Enforce max-one-open-at-a-time rule to avoid ambiguous amount routing.
    const otherOpen = await this.findOpenSession(params.sourceId);
    if (otherOpen) {
      return { opened: false, session: otherOpen, reason: "other_market_open" };
    }

    // 3. All clear — create new session.
    const { data, error } = await this.supabase
      .from("manual_slip_sessions")
      .insert({
        source_id:               params.sourceId,
        business_date:           params.businessDate,
        market_key:              params.marketKey,
        market_label:            params.marketLabel,
        status:                  "open",
        opened_by_line_user_id:  params.lineUserId,
        opened_line_message_id:  params.lineMessageId,
      })
      .select()
      .single();

    if (error) throw new Error(`manual session open failed: ${error.message}`);
    return { opened: true, session: data };
  }

  // Returns current max sequence_no + 1 (0 if no entries yet).
  async nextSequenceNo(sessionId: string): Promise<number> {
    const { data } = await this.supabase
      .from("manual_slip_entries")
      .select("sequence_no")
      .eq("session_id", sessionId)
      .order("sequence_no", { ascending: false })
      .limit(1);
    return data && data.length > 0 ? (data[0].sequence_no as number) + 1 : 0;
  }

  async appendEntries(params: {
    sessionId:      string;
    entries:        Array<{ rawLine: string; amount: number }>;
    lineMessageId:  string;
    lineUserId:     string | null;
  }): Promise<void> {
    // Re-delivery check: if entries for this line_message_id already exist, skip.
    const { data: existing } = await this.supabase
      .from("manual_slip_entries")
      .select("id")
      .eq("session_id", params.sessionId)
      .eq("line_message_id", params.lineMessageId)
      .limit(1);
    if (existing && existing.length > 0) return;

    const startSeq = await this.nextSequenceNo(params.sessionId);
    const rows = params.entries.map((e, i) => ({
      session_id:      params.sessionId,
      sequence_no:     startSeq + i,
      raw_line:        e.rawLine,
      amount:          e.amount,
      line_message_id: params.lineMessageId,
      line_user_id:    params.lineUserId,
    }));

    const { error } = await this.supabase
      .from("manual_slip_entries")
      .upsert(rows, { onConflict: "line_message_id,sequence_no", ignoreDuplicates: true });

    if (error) throw new Error(`manual entry append failed: ${error.message}`);
  }

  async closeSession(params: {
    sessionId:      string;
    lineUserId:     string | null;
    lineMessageId:  string;
  }): Promise<{ total: number; alreadyClosed: boolean }> {
    const { data: entries } = await this.supabase
      .from("manual_slip_entries")
      .select("amount")
      .eq("session_id", params.sessionId);

    const total = (entries ?? []).reduce((sum, e) => sum + Number(e.amount), 0);

    const { data: updated, error } = await this.supabase
      .from("manual_slip_sessions")
      .update({
        status:                  "closed",
        closed_at:               new Date().toISOString(),
        closed_by_line_user_id:  params.lineUserId,
        closed_line_message_id:  params.lineMessageId,
      })
      .eq("id", params.sessionId)
      .eq("status", "open")
      .select("id");

    if (error) throw new Error(`manual session close failed: ${error.message}`);

    const alreadyClosed = !updated || updated.length === 0;
    return { total, alreadyClosed };
  }
}
