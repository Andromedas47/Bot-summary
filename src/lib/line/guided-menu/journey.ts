/**
 * Slices 3C/3D — where the operator is in the guided journey.
 *
 * The journey has no table of its own. Every stage is derived from state the
 * existing subsystems already own:
 *
 *   capture / awaiting_confirm  pending_sessions (0049 structured metadata)
 *   white_sheet                 digital_white_sheet_cash_entries
 *   slips                       slip_batches / manual_slip_sessions
 *   reconcile                   slip_checks + settlement_entries
 *
 * Nothing here is a second source of truth, and nothing writes. The seller,
 * market, business date and transaction type that bind the whole journey come
 * from the produce session's own frozen metadata, so a later stage can never
 * drift onto a different seller/market/date than the round was opened for.
 *
 * There is deliberately no work_round_id: see
 * docs/guided-operations-end-to-end.md §2.1.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import {
  produceSessionKey,
  type StructuredPendingSession,
} from "@/lib/line/produce-session-commands";
import { loadWhiteSheetCashEntry } from "@/lib/white-sheet";
import type { WhiteSheetCashEntryState } from "@/lib/white-sheet/persist";
import { normalizedMarketLabel } from "@/lib/market";
import { produceCommandSourceFromIdentity } from "./session-opener";
import {
  guidedProduceHandedToFinalizer,
  resolveGuidedProduceFinalization,
} from "./produce-finalization";
import type { GuidedMenuIdentity } from "./ux-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export type GuidedJourneyStage =
  /** No guided round to continue. */
  | "idle"
  /** Round open, items being sent. */
  | "capture"
  /** Close boundary set, waiting for the operator's confirmation. */
  | "awaiting_confirm"
  /**
   * Hold released, deferred finalizer has not reported yet. NOT success: no
   * later stage may be entered until produce rows are proven to exist.
   */
  | "finalizing"
  /** Terminal without a successful finalization status — nothing was saved. */
  | "finalize_failed"
  /** Produce rows exist; the white sheet has not been submitted yet. */
  | "white_sheet"
  /** White sheet submitted; slip evidence is still being collected. */
  | "slips"
  /** Slips collected; the round is ready to be checked and closed. */
  | "reconcile";

/** The tuple every stage of the journey is bound to. */
export type GuidedJourneyContext = {
  sessionKey: string;
  sourceId: string;
  lineUserId: string;
  /** คนขาย — produce staff_label. */
  sellerLabel: string;
  /** Raw catalog market label as frozen on the session. */
  marketLabel: string;
  /** NFC-normalized market label — the white sheet / slip identity. */
  marketLabelNormalized: string;
  businessDate: string;
  /** Base transaction type the round was opened for (เบิก / คืน / คืนเสีย). */
  transactionType: string;
  sessionGeneration: string;
};

export type GuidedJourneyState =
  | { stage: "idle"; reason: GuidedJourneyIdleReason }
  | {
      stage: Exclude<GuidedJourneyStage, "idle">;
      context: GuidedJourneyContext;
      session: StructuredPendingSession;
      whiteSheet: WhiteSheetCashEntryState;
    };

export type GuidedJourneyIdleReason =
  | "missing_session_key"
  | "session_key_mismatch"
  | "lookup_failed"
  | "no_session"
  | "not_structured"
  | "ownership_conflict"
  | "incomplete_metadata";

/** Source-wide ownership of the guided round for one market/business date. */
export type GuidedRoundOwnership =
  | { kind: "none" }
  | { kind: "owned"; lineUserId: string; sessionKey: string }
  /** The lookup itself failed — callers must fail closed, never fall back. */
  | { kind: "unknown" };

export class GuidedJourneyService {
  private readonly pending: PendingSessionService;

  constructor(
    private readonly supabase: AnyClient,
    options: { pendingService?: PendingSessionService } = {},
  ) {
    this.pending = options.pendingService ?? new PendingSessionService(supabase);
  }

  /**
   * Resolve the operator's current stage.
   *
   * Unlike GuidedSessionCaptureService.snapshot this tolerates a terminalized
   * row: the round's frozen seller/market/date metadata survives finalization
   * and is exactly what the white-sheet and slip stages need to stay bound to
   * the same round.
   */
  async resolve(identity: GuidedMenuIdentity): Promise<GuidedJourneyState> {
    const source = produceCommandSourceFromIdentity(identity);
    const sessionKey = produceSessionKey(source);
    if (!sessionKey) return { stage: "idle", reason: "missing_session_key" };
    if (identity.sessionKey && identity.sessionKey !== sessionKey) {
      return { stage: "idle", reason: "session_key_mismatch" };
    }

    const lookup = await this.pending.lookup(sessionKey);
    if (lookup.reason === "db_error") {
      return { stage: "idle", reason: "lookup_failed" };
    }
    const row = lookup.session as StructuredPendingSession | null;
    if (!row) return { stage: "idle", reason: "no_session" };
    if (row.entry_origin == null) {
      return { stage: "idle", reason: "not_structured" };
    }
    if (row.line_user_id && row.line_user_id !== identity.lineUserId) {
      return { stage: "idle", reason: "ownership_conflict" };
    }

    const marketLabel = (row.market_label ?? "").trim();
    const sellerLabel = (row.staff_label ?? "").trim();
    const businessDate = row.business_date ?? "";
    const marketLabelNormalized = normalizedMarketLabel(marketLabel);
    if (
      !marketLabel ||
      !sellerLabel ||
      !businessDate ||
      !marketLabelNormalized ||
      !row.initial_transaction_type
    ) {
      // A structured row is CHECK-constrained to carry all of these; a row that
      // somehow does not is not something later stages may guess at.
      return { stage: "idle", reason: "incomplete_metadata" };
    }

    const context: GuidedJourneyContext = {
      sessionKey,
      sourceId: identity.sourceId,
      lineUserId: identity.lineUserId,
      sellerLabel,
      marketLabel,
      marketLabelNormalized,
      businessDate,
      transactionType: row.initial_transaction_type,
      sessionGeneration: row.session_generation,
    };

    // Produce stages first — an unfinished round is never skipped past.
    if (!guidedProduceHandedToFinalizer(row)) {
      const stage =
        row.close_event_timestamp_ms !== null ? "awaiting_confirm" : "capture";
      return {
        stage,
        context,
        session: row,
        whiteSheet: { status: "not_submitted" },
      };
    }

    // The hold is released, but produce rows are only proven by the
    // authoritative finalization status. Neither `finalizing` nor
    // `finalize_failed` may proceed to the White Sheet.
    const produce = await resolveGuidedProduceFinalization(this.supabase, row);
    if (produce !== "succeeded") {
      return {
        stage: produce === "failed" ? "finalize_failed" : "finalizing",
        context,
        session: row,
        whiteSheet: { status: "not_submitted" },
      };
    }

    const whiteSheet = await loadWhiteSheetCashEntry(this.supabase, {
      sourceId: context.sourceId,
      marketLabelNormalized: context.marketLabelNormalized,
      businessDate: context.businessDate,
    });

    if (whiteSheet.status === "not_submitted") {
      return { stage: "white_sheet", context, session: row, whiteSheet };
    }

    // The white sheet is in. Whether the operator is still collecting slips or
    // ready to check the round is decided by the slip batch, not by this row.
    const collecting = await this.hasOpenSlipWork(context);
    return {
      stage: collecting ? "slips" : "reconcile",
      context,
      session: row,
      whiteSheet,
    };
  }

  /**
   * Who owns the guided round for one market and business date in this source.
   *
   * The journey key is per operator (`group:<source>:user:<user>`), so a second
   * member of the same LINE group resolves `idle` and would otherwise fall
   * through to the shared legacy writers. This is the source-wide question the
   * guards ask before allowing any such fallback.
   *
   * Terminalized rounds are included on purpose: ownership of a market/date does
   * not lapse when the produce session ends — the White Sheet and slip stages
   * come afterwards.
   */
  async findRoundOwner(input: {
    sourceId: string;
    marketLabelNormalized: string;
    businessDate: string;
  }): Promise<GuidedRoundOwnership> {
    const target = input.marketLabelNormalized.normalize("NFC").trim();
    if (!target || !input.businessDate) return { kind: "none" };

    let data: Array<Record<string, unknown>> | null;
    try {
      const result = await this.supabase
        .from("pending_sessions")
        .select("session_key, line_user_id, market_label, entry_origin, created_at")
        .eq("source_id", input.sourceId)
        .eq("business_date", input.businessDate)
        .not("entry_origin", "is", null)
        .order("created_at", { ascending: false });
      if (result.error) return { kind: "unknown" };
      data = result.data;
    } catch {
      // Unanswerable is not "nobody owns it" — callers must fail closed.
      return { kind: "unknown" };
    }

    for (const row of data ?? []) {
      const lineUserId = String(row.line_user_id ?? "").trim();
      if (!lineUserId) continue;
      if (normalizedMarketLabel(String(row.market_label ?? "")) !== target) {
        continue;
      }
      return {
        kind: "owned",
        lineUserId,
        sessionKey: String(row.session_key ?? ""),
      };
    }
    return { kind: "none" };
  }

  /**
   * True while any slip work for this source/date is still open: a batch that
   * has not reached a terminal state, or a manual slip session still open.
   * Both are existing lifecycle states — nothing new is inferred.
   */
  private async hasOpenSlipWork(
    context: GuidedJourneyContext,
  ): Promise<boolean> {
    const [batches, manual] = await Promise.all([
      this.supabase
        .from("slip_batches")
        .select("id, status")
        .eq("source_id", context.sourceId)
        .in("status", ["collecting", "closing", "processing"]),
      this.supabase
        .from("manual_slip_sessions")
        .select("id")
        .eq("source_id", context.sourceId)
        .eq("business_date", context.businessDate)
        .eq("status", "open"),
    ]);
    if (batches.error) {
      throw new Error(`slip batch lookup failed: ${batches.error.message}`);
    }
    if (manual.error) {
      throw new Error(`manual slip lookup failed: ${manual.error.message}`);
    }
    return (batches.data ?? []).length > 0 || (manual.data ?? []).length > 0;
  }
}

/** DD/MM/BBBB for the operator-facing command templates. */
export function thaiDateFromIso(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  return `${match[3]}/${match[2]}/${Number(match[1]) + 543}`;
}

/**
 * The White Sheet closing template, in the EXACT syntax
 * parseWhiteSheetCloseCommand already accepts:
 *
 *   <market> ปิดยอด <DD/MM/BBBB>
 *   ค่าแรง / ค่าที่ / ค่าถุง / ค่าขนม / ค่าอื่น / เงินสด
 *   จบปิดยอด
 *
 * No field is invented and no second parser exists — the operator edits the
 * numbers and the message goes through the existing close command path.
 */
export function buildWhiteSheetTemplate(context: {
  marketLabel: string;
  businessDate: string;
}): string | null {
  const thaiDate = thaiDateFromIso(context.businessDate);
  if (!thaiDate) return null;
  return [
    `${context.marketLabel} ปิดยอด ${thaiDate}`,
    "ค่าแรง 0",
    "ค่าที่ 0",
    "ค่าถุง 0",
    "ค่าขนม 0",
    "ค่าอื่น 0",
    "เงินสด 0",
    "จบปิดยอด",
  ].join("\n");
}

/**
 * The transfer-slip batch header, in the EXACT syntax parseSlipSessionHeader
 * already accepts: "<seller> <market> สลิปเงินโอน <D/M/BBBB>".
 */
export function buildSlipHeaderTemplate(context: {
  sellerLabel: string;
  marketLabel: string;
  businessDate: string;
}): string | null {
  const thaiDate = thaiDateFromIso(context.businessDate);
  if (!thaiDate) return null;
  return `${context.sellerLabel} ${context.marketLabel} สลิปเงินโอน ${thaiDate}`;
}
