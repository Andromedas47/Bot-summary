import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { WhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import type { WhiteSheetSessionFieldSet } from "@/lib/line/white-sheet-session-command";
import { loadWhiteSheetCashEntry, type WhiteSheetExpenses } from "@/lib/white-sheet";

type Supabase = SupabaseClient<Database>;

export type WhiteSheetSessionRow =
  Database["public"]["Tables"]["manual_white_sheet_sessions"]["Row"];

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export type WhiteSheetSessionOpenResult =
  | { opened: true; reused: false; session: WhiteSheetSessionRow }
  | { opened: false; reason: "resumed"; session: WhiteSheetSessionRow }
  | { opened: false; reason: "other_open"; session: WhiteSheetSessionRow }
  | { opened: false; reason: "finalized_locked"; session: WhiteSheetSessionRow }
  | { opened: false; reason: "closing_in_progress"; session: WhiteSheetSessionRow };

export type WhiteSheetSessionOpenPreview =
  | { kind: "fresh" }
  | { kind: "resumed"; session: WhiteSheetSessionRow }
  | { kind: "other_open"; session: WhiteSheetSessionRow }
  | { kind: "finalized_locked"; session: WhiteSheetSessionRow }
  | { kind: "closing_in_progress"; session: WhiteSheetSessionRow };

export type WhiteSheetSessionCloseClaim =
  | { claimed: true; session: WhiteSheetSessionRow }
  | { claimed: false; reason: "already_closed"; session: WhiteSheetSessionRow }
  | { claimed: false; reason: "closing_in_progress"; session: WhiteSheetSessionRow }
  | { claimed: false; reason: "cancelled"; session: WhiteSheetSessionRow }
  | { claimed: false; reason: "not_found" };

export type WhiteSheetSessionCancelResult =
  | { cancelled: true; session: WhiteSheetSessionRow }
  | { cancelled: false; reason: "already_cancelled"; session: WhiteSheetSessionRow }
  | { cancelled: false; reason: "already_closed"; session: WhiteSheetSessionRow }
  | { cancelled: false; reason: "not_found" };

/**
 * Persistence for the Manual White Sheet LINE session wrapper. Never computes
 * White Sheet arithmetic — that stays in @/lib/white-sheet and
 * @/lib/line/white-sheet-close-service, which own the canonical close path.
 */
export class WhiteSheetSessionService {
  constructor(private readonly supabase: Supabase) {}

  async findOpenSession(sourceId: string): Promise<WhiteSheetSessionRow | null> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .in("status", ["open", "closing"])
      .maybeSingle();
    if (error) throw new Error(`findOpenSession failed: ${error.message}`);
    return data;
  }

  async findSession(
    sourceId: string,
    marketLabelNormalized: string,
    businessDate: string,
  ): Promise<WhiteSheetSessionRow | null> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("market_label_normalized", marketLabelNormalized)
      .eq("business_date", businessDate)
      .maybeSingle();
    if (error) throw new Error(`findSession failed: ${error.message}`);
    return data;
  }

  /**
   * Read-only precheck so the caller can skip an expensive produce-market
   * lookup for every blocked case (resume / other-market-open / closing /
   * finalized-locked) and only spend it on a genuinely fresh-or-reopenable
   * open. A `closed` session is only a hard block when the canonical White
   * Sheet is FINALIZED — otherwise it is reopenable for correction, same as
   * `cancelled`, so both fall through to "fresh".
   */
  async previewOpen(
    sourceId: string,
    marketLabelNormalized: string,
    businessDate: string,
  ): Promise<WhiteSheetSessionOpenPreview> {
    const existing = await this.findSession(sourceId, marketLabelNormalized, businessDate);
    if (existing) {
      if (existing.status === "open") return { kind: "resumed", session: existing };
      if (existing.status === "closing") return { kind: "closing_in_progress", session: existing };
      if (existing.status === "closed") {
        const canonical = await loadWhiteSheetCashEntry(this.supabase, {
          sourceId,
          marketLabelNormalized,
          businessDate,
        });
        if (canonical.status === "finalized") {
          return { kind: "finalized_locked", session: existing };
        }
        // submitted or not_submitted — safe to reopen for correction.
      }
      // cancelled, or closed-but-not-finalized — falls through to "fresh".
    } else {
      const otherOpen = await this.findOpenSession(sourceId);
      if (otherOpen) {
        return {
          kind: otherOpen.status === "closing" ? "closing_in_progress" : "other_open",
          session: otherOpen,
        };
      }
    }
    return { kind: "fresh" };
  }

  async openSession(params: {
    sourceId: string;
    marketLabel: string;
    marketLabelNormalized: string;
    businessDate: string;
    businessDateDisplay: string;
    lineUserId: string | null;
    lineEventId: string;
  }): Promise<WhiteSheetSessionOpenResult> {
    const existing = await this.findSession(
      params.sourceId,
      params.marketLabelNormalized,
      params.businessDate,
    );

    if (existing) {
      if (existing.status === "open") return { opened: false, reason: "resumed", session: existing };
      if (existing.status === "closing") {
        return { opened: false, reason: "closing_in_progress", session: existing };
      }

      if (existing.status === "closed") {
        const canonical = await loadWhiteSheetCashEntry(this.supabase, {
          sourceId: params.sourceId,
          marketLabelNormalized: params.marketLabelNormalized,
          businessDate: params.businessDate,
        });
        if (canonical.status === "finalized") {
          // Locked — this identity can never be reopened via LINE.
          return { opened: false, reason: "finalized_locked", session: existing };
        }
        // SUBMITTED (or a vanished not_submitted row) — reopen for
        // correction, seeded from the canonical persisted entry so a
        // correction made through another entry path (e.g. Backoffice)
        // isn't overwritten by stale session values.
        return this.reopenExisting(
          existing,
          params,
          canonical.status === "submitted" ? canonical.expenses : null,
          canonical.status === "submitted" ? canonical.actualCashSubmitted : null,
        );
      }

      // status === "cancelled" — a cancelled session never wrote White Sheet
      // data, so it's safe to hand the operator a fresh session on the same
      // identity instead of forcing a permanently-blocked row.
      return this.reopenExisting(existing, params, null, null);
    }

    const otherOpen = await this.findOpenSession(params.sourceId);
    if (otherOpen) {
      return {
        opened: false,
        reason: otherOpen.status === "closing" ? "closing_in_progress" : "other_open",
        session: otherOpen,
      };
    }

    try {
      const { data, error } = await this.supabase
        .from("manual_white_sheet_sessions")
        .insert({
          source_id: params.sourceId,
          market_label: params.marketLabel,
          market_label_normalized: params.marketLabelNormalized,
          business_date: params.businessDate,
          business_date_display: params.businessDateDisplay,
          status: "open",
          opened_by_line_user_id: params.lineUserId,
          opened_line_event_id: params.lineEventId,
        })
        .select()
        .single();
      if (error) throw error;
      return { opened: true, reused: false, session: data };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Lost a concurrent-open race — resolve deterministically from DB state.
        const refetched = await this.findSession(
          params.sourceId,
          params.marketLabelNormalized,
          params.businessDate,
        );
        if (refetched) return { opened: false, reason: "resumed", session: refetched };
        const other = await this.findOpenSession(params.sourceId);
        if (other) return { opened: false, reason: "other_open", session: other };
      }
      throw error;
    }
  }

  /**
   * Reopens a `cancelled` or non-finalized `closed` session on the same
   * identity row (never a new row — the unique identity constraint is
   * preserved), resetting close metadata and seeding entered values from
   * `seedExpenses`/`seedCash` (both null for a fresh/cancelled reopen, or the
   * canonical persisted entry's values for a closed-SUBMITTED correction).
   */
  private async reopenExisting(
    existing: WhiteSheetSessionRow,
    params: {
      marketLabel: string;
      businessDateDisplay: string;
      lineUserId: string | null;
      lineEventId: string;
      sourceId: string;
      marketLabelNormalized: string;
      businessDate: string;
    },
    seedExpenses: WhiteSheetExpenses | null,
    seedCash: number | null,
  ): Promise<WhiteSheetSessionOpenResult> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .update({
        status: "open",
        market_label: params.marketLabel,
        business_date_display: params.businessDateDisplay,
        labor: seedExpenses?.labor ?? null,
        location_fee: seedExpenses?.locationFee ?? null,
        bag: seedExpenses?.bag ?? null,
        snack: seedExpenses?.snack ?? null,
        other_amount: seedExpenses?.other ?? null,
        other_note: seedExpenses?.otherNote ?? null,
        actual_cash_submitted: seedCash,
        opened_by_line_user_id: params.lineUserId,
        opened_line_event_id: params.lineEventId,
        opened_at: new Date().toISOString(),
        closed_by_line_user_id: null,
        closed_line_event_id: null,
        closed_at: null,
      })
      .eq("id", existing.id)
      .in("status", ["cancelled", "closed"])
      .select()
      .maybeSingle();
    if (error) throw new Error(`reopen failed: ${error.message}`);
    if (!data) {
      // Lost the race — someone else reopened/claimed it first; resolve deterministically.
      const refetched = await this.findSession(
        params.sourceId,
        params.marketLabelNormalized,
        params.businessDate,
      );
      if (refetched) return { opened: false, reason: "resumed", session: refetched };
    }
    return data
      ? { opened: true, reused: false, session: data }
      : { opened: false, reason: "resumed", session: existing };
  }

  /** Applies only the fields present in this message (others left untouched). */
  async applyFields(
    sessionId: string,
    fields: WhiteSheetSessionFieldSet,
  ): Promise<WhiteSheetSessionRow | null> {
    const patch: Database["public"]["Tables"]["manual_white_sheet_sessions"]["Update"] = {};
    if (fields.labor !== undefined) patch.labor = fields.labor;
    if (fields.locationFee !== undefined) patch.location_fee = fields.locationFee;
    if (fields.bag !== undefined) patch.bag = fields.bag;
    if (fields.snack !== undefined) patch.snack = fields.snack;
    if (fields.other !== undefined) {
      patch.other_amount = fields.other.amount;
      patch.other_note = fields.other.note;
    }
    if (fields.actualCashSubmitted !== undefined) {
      patch.actual_cash_submitted = fields.actualCashSubmitted;
    }
    if (Object.keys(patch).length === 0) return null;

    const { data, error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .update(patch)
      .eq("id", sessionId)
      .eq("status", "open")
      .select()
      .maybeSingle();
    if (error) throw new Error(`applyFields failed: ${error.message}`);
    return data;
  }

  /** Atomically claims an open session for closing (open → closing). */
  async claimForClose(sourceId: string): Promise<WhiteSheetSessionCloseClaim> {
    const session = await this.findOpenSession(sourceId);
    if (!session) return { claimed: false, reason: "not_found" };
    if (session.status === "closing") {
      return { claimed: false, reason: "closing_in_progress", session };
    }

    const { data, error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .update({ status: "closing" })
      .eq("id", session.id)
      .eq("status", "open")
      .select()
      .maybeSingle();
    if (error) throw new Error(`claimForClose failed: ${error.message}`);
    if (!data) {
      // Someone else claimed it first — resolve current state deterministically.
      const current = await this.getById(session.id);
      if (!current) return { claimed: false, reason: "not_found" };
      if (current.status === "closed") return { claimed: false, reason: "already_closed", session: current };
      if (current.status === "cancelled") return { claimed: false, reason: "cancelled", session: current };
      return { claimed: false, reason: "closing_in_progress", session: current };
    }
    return { claimed: true, session: data };
  }

  async getById(sessionId: string): Promise<WhiteSheetSessionRow | null> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw new Error(`getById failed: ${error.message}`);
    return data;
  }

  /** Marks a claimed ("closing") session terminal after a successful White Sheet submission. */
  async finalizeClosed(
    sessionId: string,
    params: { lineUserId: string | null; lineEventId: string },
  ): Promise<WhiteSheetSessionRow> {
    const { data, error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .update({
        status: "closed",
        closed_by_line_user_id: params.lineUserId,
        closed_line_event_id: params.lineEventId,
        closed_at: new Date().toISOString(),
      })
      .eq("id", sessionId)
      .eq("status", "closing")
      .select()
      .single();
    if (error) throw new Error(`finalizeClosed failed: ${error.message}`);
    return data;
  }

  /** Returns a claimed session to "open" after a retryable close failure. */
  async revertToOpen(sessionId: string): Promise<void> {
    const { error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .update({ status: "open" })
      .eq("id", sessionId)
      .eq("status", "closing");
    if (error) throw new Error(`revertToOpen failed: ${error.message}`);
  }

  async cancelSession(
    sourceId: string,
    params: { lineUserId: string | null; lineEventId: string },
  ): Promise<WhiteSheetSessionCancelResult> {
    const session = await this.findOpenSession(sourceId);
    if (!session) {
      return { cancelled: false, reason: "not_found" };
    }

    const { data, error } = await this.supabase
      .from("manual_white_sheet_sessions")
      .update({
        status: "cancelled",
        closed_by_line_user_id: params.lineUserId,
        closed_line_event_id: params.lineEventId,
        closed_at: new Date().toISOString(),
      })
      .eq("id", session.id)
      .eq("status", "open")
      .select()
      .maybeSingle();
    if (error) throw new Error(`cancelSession failed: ${error.message}`);
    if (!data) {
      const current = await this.getById(session.id);
      if (!current) return { cancelled: false, reason: "not_found" };
      if (current.status === "cancelled") {
        return { cancelled: false, reason: "already_cancelled", session: current };
      }
      return { cancelled: false, reason: "already_closed", session: current };
    }
    return { cancelled: true, session: data };
  }
}

/**
 * Builds the canonical WhiteSheetCloseCommand directly from a claimed session
 * row. No arithmetic here — undefined means "operator never sent this field",
 * which lets the existing mergeWhiteSheetCloseInput apply its own
 * first-submit/resubmit defaulting rules unchanged.
 */
export function buildWhiteSheetCloseCommandFromSession(
  session: WhiteSheetSessionRow,
): WhiteSheetCloseCommand | null {
  if (session.actual_cash_submitted === null) return null;
  return {
    marketLabel: session.market_label_normalized,
    marketLabelNormalized: session.market_label_normalized,
    businessDate: session.business_date,
    labor: session.labor ?? undefined,
    locationFee: session.location_fee ?? undefined,
    bag: session.bag ?? undefined,
    snack: session.snack ?? undefined,
    other:
      session.other_amount !== null
        ? { amount: session.other_amount, note: session.other_note }
        : undefined,
    actualCashSubmitted: session.actual_cash_submitted,
  };
}
