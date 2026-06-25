import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkRound } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

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
