import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ManualWhiteSheetNoteSessionRow } from "@/types/database";
import type { WhiteSheetNoteFieldValue } from "@/lib/line/white-sheet-note-command";

type Supabase = SupabaseClient<Database>;

export type { ManualWhiteSheetNoteSessionRow };

const COLUMN_BY_FIELD_KEY = {
  labor: "labor",
  locationFee: "location_fee",
  bag: "bag",
  snack: "snack",
  actualCash: "actual_cash",
} as const;

export class WhiteSheetNoteSessionService {
  constructor(private readonly supabase: Supabase) {}

  async findOpenSession(sourceId: string): Promise<ManualWhiteSheetNoteSessionRow | null> {
    const { data } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("status", "open")
      .maybeSingle();
    return data;
  }

  async openSession(params: {
    sourceId: string;
    marketLabel: string;
    marketLabelNormalized: string;
    businessDate: string;
    lineUserId: string | null;
    lineEventId: string;
  }): Promise<{ opened: true; session: ManualWhiteSheetNoteSessionRow } | { opened: false; session: ManualWhiteSheetNoteSessionRow }> {
    const existing = await this.findOpenSession(params.sourceId);
    if (existing) {
      return { opened: false, session: existing };
    }

    const { data, error } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .insert({
        source_id: params.sourceId,
        market_label: params.marketLabel,
        market_label_normalized: params.marketLabelNormalized,
        business_date: params.businessDate,
        status: "open",
        opened_by_line_user_id: params.lineUserId,
        opened_line_event_id: params.lineEventId,
      })
      .select()
      .single();

    if (error) throw new Error(`white sheet note session open failed: ${error.message}`);
    return { opened: true, session: data };
  }

  async applyField(
    session: ManualWhiteSheetNoteSessionRow,
    field: WhiteSheetNoteFieldValue,
  ): Promise<ManualWhiteSheetNoteSessionRow> {
    const patch: Database["public"]["Tables"]["manual_white_sheet_note_sessions"]["Update"] =
      field.key === "other"
        ? { other_amount: field.amount, other_note: field.note }
        : { [COLUMN_BY_FIELD_KEY[field.key]]: field.amount };

    const { data, error } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .update(patch)
      .eq("id", session.id)
      .eq("status", "open")
      .select()
      .maybeSingle();

    if (error) throw new Error(`white sheet note session field update failed: ${error.message}`);
    return data ?? session;
  }

  hasAnyValue(session: ManualWhiteSheetNoteSessionRow): boolean {
    return (
      session.labor !== null
      || session.location_fee !== null
      || session.bag !== null
      || session.snack !== null
      || session.other_amount !== null
      || session.actual_cash !== null
    );
  }

  async closeSession(
    session: ManualWhiteSheetNoteSessionRow,
    params: { lineUserId: string | null; lineEventId: string },
  ): Promise<ManualWhiteSheetNoteSessionRow> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        closed_by_line_user_id: params.lineUserId,
        closed_line_event_id: params.lineEventId,
      })
      .eq("id", session.id)
      .eq("status", "open")
      .select()
      .maybeSingle();

    if (error) throw new Error(`white sheet note session close failed: ${error.message}`);
    return data ?? session;
  }

  async cancelSession(
    session: ManualWhiteSheetNoteSessionRow,
    params: { lineUserId: string | null; lineEventId: string },
  ): Promise<ManualWhiteSheetNoteSessionRow> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .update({
        status: "cancelled",
        closed_at: new Date().toISOString(),
        closed_by_line_user_id: params.lineUserId,
        closed_line_event_id: params.lineEventId,
      })
      .eq("id", session.id)
      .eq("status", "open")
      .select()
      .maybeSingle();

    if (error) throw new Error(`white sheet note session cancel failed: ${error.message}`);
    return data ?? session;
  }
}
