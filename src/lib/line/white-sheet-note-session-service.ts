import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ManualWhiteSheetNoteSessionRow } from "@/types/database";
import type { WhiteSheetNoteFieldValue } from "@/lib/line/white-sheet-note-command";

type Supabase = SupabaseClient<Database>;
type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

export type { ManualWhiteSheetNoteSessionRow };

const COLUMN_BY_FIELD_KEY = {
  labor: "labor",
  locationFee: "location_fee",
  bag: "bag",
  snack: "snack",
  actualCash: "actual_cash",
} as const;

/** Postgres unique_violation. Thrown by the partial one-open-per-source index. */
const UNIQUE_VIOLATION = "23505";

export class WhiteSheetNoteSessionLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhiteSheetNoteSessionLookupError";
  }
}

export type ApplyFieldResult =
  | { ok: true; session: ManualWhiteSheetNoteSessionRow }
  | { ok: false; reason: "conflict" };

export type CancelResult =
  | { ok: true; session: ManualWhiteSheetNoteSessionRow }
  | { ok: false; reason: "conflict" };

export type CloseOutcome =
  | { outcome: "closed"; session: ManualWhiteSheetNoteSessionRow; cashEntry: CashEntryRow }
  | { outcome: "already_closed"; session: ManualWhiteSheetNoteSessionRow }
  | { outcome: "already_cancelled"; session: ManualWhiteSheetNoteSessionRow }
  | { outcome: "empty"; session: ManualWhiteSheetNoteSessionRow }
  | { outcome: "finalized"; session: ManualWhiteSheetNoteSessionRow }
  | { outcome: "not_found" };

export class WhiteSheetNoteSessionService {
  constructor(private readonly supabase: Supabase) {}

  /** Throws WhiteSheetNoteSessionLookupError on a genuine DB/query failure. */
  async findOpenSession(sourceId: string): Promise<ManualWhiteSheetNoteSessionRow | null> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("status", "open")
      .maybeSingle();

    if (error) {
      throw new WhiteSheetNoteSessionLookupError(`open session lookup failed: ${error.message}`);
    }
    return data;
  }

  /** Most recent session for this source regardless of status, or null if none exists. */
  async findLatestSessionForSource(sourceId: string): Promise<ManualWhiteSheetNoteSessionRow | null> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new WhiteSheetNoteSessionLookupError(`latest session lookup failed: ${error.message}`);
    }
    return data;
  }

  /**
   * Opens a new session, or returns the already-open one. Two concurrent
   * callers for the same source can both pass the initial findOpenSession
   * check and both attempt the insert — the partial one-open-per-source
   * unique index lets exactly one succeed; the loser here re-reads and
   * returns the winner's row instead of surfacing a raw DB error.
   */
  async openSession(params: {
    sourceId: string;
    marketLabel: string;
    marketLabelNormalized: string;
    businessDate: string;
    lineUserId: string | null;
    lineEventId: string;
    accountabilityRoundId?: string | null;
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
        accountability_round_id: params.accountabilityRoundId ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        const winner = await this.findOpenSession(params.sourceId);
        if (winner) return { opened: false, session: winner };
      }
      throw new Error(`white sheet note session open failed: ${error.message}`);
    }
    return { opened: true, session: data };
  }

  /**
   * Applies one or more fields in a single conditional UPDATE (id + source_id
   * + status = 'open'). Repeated keys in `fields` resolve last-wins into one
   * patch — never one DB write per line. A racing close/cancel that already
   * terminated the session returns a typed conflict instead of a false
   * "saved" reply.
   */
  async applyFields(
    session: ManualWhiteSheetNoteSessionRow,
    fields: WhiteSheetNoteFieldValue[],
  ): Promise<ApplyFieldResult> {
    if (fields.length === 0) {
      throw new Error("white sheet note session applyFields requires at least one field");
    }

    const patch: Database["public"]["Tables"]["manual_white_sheet_note_sessions"]["Update"] = {};
    for (const field of fields) {
      if (field.key === "other") {
        patch.other_amount = field.amount;
        patch.other_note = field.note;
      } else {
        patch[COLUMN_BY_FIELD_KEY[field.key]] = field.amount;
      }
    }

    const { data, error } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .update(patch)
      .eq("id", session.id)
      .eq("source_id", session.source_id)
      .eq("status", "open")
      .select()
      .maybeSingle();

    if (error) throw new Error(`white sheet note session field update failed: ${error.message}`);
    if (!data) return { ok: false, reason: "conflict" };
    return { ok: true, session: data };
  }

  /** Convenience wrapper — one field, same conditional UPDATE semantics. */
  async applyField(
    session: ManualWhiteSheetNoteSessionRow,
    field: WhiteSheetNoteFieldValue,
  ): Promise<ApplyFieldResult> {
    return this.applyFields(session, [field]);
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

  /**
   * Atomically closes the session AND saves its entered fields into
   * digital_white_sheet_cash_entries in one PostgreSQL transaction (see
   * close_manual_white_sheet_note_session in migration 0059). The RPC reads
   * field values from the row it locks — never from application memory —
   * merges only entered fields, preserves the rest, and rejects a FINALIZED
   * canonical row. The session is marked closed only if the canonical write
   * succeeds; any failure rolls back the whole call.
   */
  async closeSession(
    session: ManualWhiteSheetNoteSessionRow,
    params: { lineUserId: string | null; lineEventId: string },
  ): Promise<CloseOutcome> {
    const { data, error } = await this.supabase.rpc("close_manual_white_sheet_note_session", {
      p_session_id: session.id,
      p_source_id: session.source_id,
      p_closed_by_line_user_id: params.lineUserId,
      p_closed_line_event_id: params.lineEventId,
    });

    if (error) throw new Error(`white sheet note session close failed: ${error.message}`);

    const result = data as unknown as {
      outcome: CloseOutcome["outcome"];
      session: ManualWhiteSheetNoteSessionRow | null;
      cash_entry: CashEntryRow | null;
    };

    if (result.outcome === "not_found") return { outcome: "not_found" };
    if (result.outcome === "closed") {
      return { outcome: "closed", session: result.session!, cashEntry: result.cash_entry! };
    }
    return { outcome: result.outcome, session: result.session! };
  }

  /**
   * Conditional UPDATE (id + source_id + status = 'open') so cancel racing
   * against a close (or another cancel) never overwrites a terminal row —
   * exactly one caller wins, the loser gets a typed conflict.
   */
  async cancelSession(
    session: ManualWhiteSheetNoteSessionRow,
    params: { lineUserId: string | null; lineEventId: string },
  ): Promise<CancelResult> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_note_sessions")
      .update({
        status: "cancelled",
        closed_at: new Date().toISOString(),
        closed_by_line_user_id: params.lineUserId,
        closed_line_event_id: params.lineEventId,
      })
      .eq("id", session.id)
      .eq("source_id", session.source_id)
      .eq("status", "open")
      .select()
      .maybeSingle();

    if (error) throw new Error(`white sheet note session cancel failed: ${error.message}`);
    if (!data) return { ok: false, reason: "conflict" };
    return { ok: true, session: data };
  }
}
