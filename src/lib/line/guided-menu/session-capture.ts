/**
 * Slice 3B — guided capture, review and finalization of an open structured
 * produce session.
 *
 * No parser logic and no barrier logic lives here. Reading the captured items
 * re-uses buildSeedFromStructuredMetadata + parseWeighSession exactly as the
 * deferred finalizer does; closing and confirming go through
 * ProduceSessionCommandService, i.e. close_produce_structured_session and
 * confirm_produce_structured_finalization (0050). This module only reads the
 * session row, refuses what it is not entitled to touch, and shapes the
 * outcome for the LINE layer.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import {
  ProduceSessionCommandService,
  produceSessionKey,
  type StructuredPendingSession,
} from "@/lib/line/produce-session-commands";
import { buildSeedFromStructuredMetadata } from "@/lib/parsers/weigh-session/seed";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { produceCommandSourceFromIdentity } from "./session-opener";
import type { GuidedMenuIdentity } from "./ux-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** Why a guided session action could not proceed. Never shown raw to LINE. */
export type GuidedCaptureRefusal =
  | "missing_session_key"
  | "session_key_mismatch"
  | "lookup_failed"
  | "no_open_session"
  | "not_structured"
  | "ownership_conflict"
  | "terminalized";

export type GuidedSessionSnapshot = {
  session: StructuredPendingSession;
  /** Parsed with the session's own frozen seed — the same parse the finalizer runs. */
  parsed: WeighSession;
  /** True once the immutable close boundary has been set. */
  closeRequested: boolean;
};

export type GuidedCaptureStatusOutcome =
  | ({ status: "ok" } & GuidedSessionSnapshot)
  | { status: "refused"; reason: GuidedCaptureRefusal };

export type GuidedCaptureCloseOutcome =
  | ({ status: "closed"; reason: "first_close" | "close_already_requested" } & GuidedSessionSnapshot)
  | { status: "refused"; reason: GuidedCaptureRefusal }
  | { status: "conflict"; reason: string; detail?: string };

export type GuidedCaptureFinalizeOutcome =
  | ({
      status: "confirmed";
      reason: "confirmed" | "already_confirmed";
    } & GuidedSessionSnapshot)
  /** The close barrier says the round is not ready — nothing was released. */
  | {
      status: "not_ready";
      detail?: string;
      admissionCount?: number;
      ingestCount?: number;
      stragglerCount?: number;
    }
  | { status: "refused"; reason: GuidedCaptureRefusal }
  | { status: "conflict"; reason: string; detail?: string };

export class GuidedSessionCaptureService {
  private readonly pending: PendingSessionService;
  private readonly commands: ProduceSessionCommandService;

  constructor(
    supabase: AnyClient,
    options: {
      pendingService?: PendingSessionService;
      commandService?: ProduceSessionCommandService;
    } = {},
  ) {
    this.pending = options.pendingService ?? new PendingSessionService(supabase);
    this.commands =
      options.commandService ?? new ProduceSessionCommandService(supabase);
  }

  /**
   * Read-only snapshot of the operator's own open guided session.
   *
   * Refuses a legacy (entry_origin IS NULL) row and a row owned by another
   * LINE user before anything is parsed or disclosed.
   */
  async snapshot(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedCaptureStatusOutcome> {
    const source = produceCommandSourceFromIdentity(identity);
    const sessionKey = produceSessionKey(source);
    if (!sessionKey) {
      return { status: "refused", reason: "missing_session_key" };
    }
    if (identity.sessionKey && identity.sessionKey !== sessionKey) {
      return { status: "refused", reason: "session_key_mismatch" };
    }

    const lookup = await this.pending.lookup(sessionKey);
    if (lookup.reason === "db_error") {
      return { status: "refused", reason: "lookup_failed" };
    }
    const row = lookup.session as StructuredPendingSession | null;
    if (!row) return { status: "refused", reason: "no_open_session" };
    if (row.entry_origin == null) {
      return { status: "refused", reason: "not_structured" };
    }
    if (row.line_user_id && row.line_user_id !== identity.lineUserId) {
      return { status: "refused", reason: "ownership_conflict" };
    }
    if (row.terminalized) return { status: "refused", reason: "terminalized" };

    return { status: "ok", ...this.readSnapshot(row) };
  }

  /** จบรายการ — set the immutable close boundary and arm the 0050 hold. */
  async requestClose(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedCaptureCloseOutcome> {
    const current = await this.snapshot(input.identity);
    if (current.status !== "ok") return current;

    const result = await this.commands.execute(
      {
        kind: "close",
        lineEventId: input.lineEventId,
        lineTimestampMs: input.lineTimestampMs,
        // The generation the operator's summary was built from. A round that
        // rotated underneath this button must refuse, not close a stranger.
        expectedSessionGeneration: current.session.session_generation,
      },
      produceCommandSourceFromIdentity(input.identity),
    );

    if (!result.ok) {
      return { status: "conflict", reason: result.reason, detail: result.detail };
    }
    if (result.kind !== "close") {
      return { status: "conflict", reason: "unexpected_command_result" };
    }
    return {
      status: "closed",
      reason: result.reason,
      ...this.readSnapshot(result.session),
    };
  }

  /**
   * Release the 0050 finalization hold. The produce rows are written later by
   * the deferred finalizer through try_finalize_pending_generation; this is a
   * control event only and persists nothing itself.
   */
  async confirmFinalize(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
  }): Promise<GuidedCaptureFinalizeOutcome> {
    const current = await this.snapshot(input.identity);
    if (current.status !== "ok") return current;

    const result = await this.commands.execute(
      {
        kind: "confirm",
        lineEventId: input.lineEventId,
        expectedSessionGeneration: current.session.session_generation,
      },
      produceCommandSourceFromIdentity(input.identity),
    );

    if (!result.ok) {
      if (result.reason === "not_ready") {
        return {
          status: "not_ready",
          detail: result.detail,
          admissionCount: result.admission_count,
          ingestCount: result.ingest_count,
          stragglerCount: result.straggler_count,
        };
      }
      return { status: "conflict", reason: result.reason, detail: result.detail };
    }
    if (result.kind !== "confirm") {
      return { status: "conflict", reason: "unexpected_command_result" };
    }
    return {
      status: "confirmed",
      reason: result.reason,
      ...this.readSnapshot(result.session),
    };
  }

  /**
   * Parse the session's accumulated text with its own frozen seed.
   *
   * A seeded parse starts in the item state, so the declared transaction type,
   * seller, market and business date can never be overwritten by operator
   * text. This is a preview of the same parse the finalizer performs; the
   * finalizer's version additionally intersects the admission and ingest
   * ledgers through the close boundary, so a straggler still in flight can
   * make the final result differ from this preview.
   */
  private readSnapshot(row: StructuredPendingSession): GuidedSessionSnapshot {
    const seed = buildSeedFromStructuredMetadata(row);
    const parsed = parseWeighSession(
      row.accumulated_text,
      row.business_date ?? bangkokBusinessDateNow(),
      undefined,
      seed,
    );
    return {
      session: row,
      parsed,
      closeRequested: row.close_event_timestamp_ms !== null,
    };
  }
}
