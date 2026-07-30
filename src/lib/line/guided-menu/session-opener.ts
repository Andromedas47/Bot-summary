/**
 * Slice 3A — turn a confirmed Guided Menu selection into a REAL structured
 * produce session.
 *
 * Every business rule here is delegated, never re-implemented:
 *   - opening/rotating goes through ProduceSessionCommandService, i.e.
 *     open_or_rotate_produce_structured_session (0049), which owns canonical
 *     session-key derivation, ownership checks, same-event idempotency and
 *     optimistic concurrency;
 *   - "is a session still open" is answered by pending_sessions.terminalized,
 *     the same flag the legacy webhook text flow uses to decide rotation.
 *
 * This module only sequences those two contracts and fails closed between them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PendingSessionService,
  type PendingSession,
} from "@/lib/line/pending-session-service";
import {
  ProduceSessionCommandService,
  produceSessionKey,
  type ProduceCommandSource,
} from "@/lib/line/produce-session-commands";
import type { BaseTransactionType } from "@/lib/parsers/weigh-session/types";
import { normalizedMarketLabel } from "@/lib/market";
import type { MenuTransactionTypeCode } from "./menu-state-types";
import { checkGuidedRoundOwner } from "./round-owner";
import type { GuidedMenuIdentity } from "./ux-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** Menu code → the parser's base transaction type stored on every item. */
export const TX_CODE_TO_BASE_TRANSACTION_TYPE: Record<
  MenuTransactionTypeCode,
  BaseTransactionType
> = {
  withdraw: "เบิก",
  return: "คืน",
  damaged_return: "คืนเสีย",
};

export interface GuidedSessionOpenInput {
  identity: GuidedMenuIdentity;
  transactionType: MenuTransactionTypeCode;
  /** Trusted seller label from the catalog — becomes produce staff_name (คนขาย). */
  sellerLabel: string;
  /** Trusted market label from the catalog — becomes produce session_title. */
  marketLabel: string;
  /** ISO business date already resolved against the Bangkok calendar. */
  businessDateIso: string;
  lineEventId: string;
  lineTimestampMs: number;
}

export type GuidedSessionOpenOutcome =
  | {
      status: "opened";
      /** "idempotent" is the LINE-retry path: the same event opened it already. */
      outcome: "opened" | "rotated" | "idempotent";
      sessionKey: string;
      sessionGeneration: string;
    }
  /** A live session already exists for this operator — nothing was written. */
  | { status: "already_open"; sessionKey: string }
  /**
   * Another operator in this source already owns a guided round for the same
   * market and business date — refused BEFORE open_or_rotate, zero writes.
   */
  | { status: "round_owned"; reason: "other_operator" | "ambiguous" | "unknown" }
  /** Ownership/generation/validation refusal from the authoritative RPC. */
  | { status: "conflict"; reason: string; detail?: string }
  /** Local fail-closed refusal — nothing reached the database. */
  | { status: "refused"; reason: string };

/** HH:MM in Asia/Bangkok for the produce transaction_time provenance field. */
export function bangkokTimeHhMm(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const hour = parts.find((p) => p.type === "hour")?.value;
  const minute = parts.find((p) => p.type === "minute")?.value;
  if (!hour || !minute) return null;
  return `${hour}:${minute}`;
}

/**
 * Build the produce command source from the menu identity.
 *
 * LINE delivers the group/room id as the source id, so a group identity's
 * groupId is its sourceId. validateCommandSource inside the command service
 * re-checks that agreement before any key is derived.
 */
export function produceCommandSourceFromIdentity(
  identity: GuidedMenuIdentity,
): ProduceCommandSource {
  return {
    type: identity.sourceType,
    sourceId: identity.sourceId,
    groupId: identity.sourceType === "group" ? identity.sourceId : null,
    roomId: identity.sourceType === "room" ? identity.sourceId : null,
    lineUserId: identity.lineUserId,
  };
}

/**
 * A row blocks a new guided open until it is terminalized — the same end-state
 * flag 0050's finalizer sets on every terminal path (finalized, failed_closed,
 * duplicate, deadline). A row mid-close is therefore still blocking, which is
 * what the operator needs: their previous round has not landed yet.
 */
function isLiveSession(row: PendingSession | null): row is PendingSession {
  return row !== null && row.terminalized !== true;
}

export class GuidedSessionOpener {
  private readonly pending: PendingSessionService;
  private readonly commands: ProduceSessionCommandService;

  constructor(
    private readonly supabase: AnyClient,
    options: {
      pendingService?: PendingSessionService;
      commandService?: ProduceSessionCommandService;
    } = {},
  ) {
    this.pending = options.pendingService ?? new PendingSessionService(supabase);
    this.commands =
      options.commandService ?? new ProduceSessionCommandService(supabase);
  }

  async open(input: GuidedSessionOpenInput): Promise<GuidedSessionOpenOutcome> {
    const source = produceCommandSourceFromIdentity(input.identity);
    const sessionKey = produceSessionKey(source);
    if (!sessionKey) {
      return { status: "refused", reason: "missing_session_key" };
    }
    // The menu identity carries its own session key binding; a disagreement
    // means the postback was built for a different source than it arrived on.
    if (input.identity.sessionKey && input.identity.sessionKey !== sessionKey) {
      return { status: "refused", reason: "session_key_mismatch" };
    }

    const transactionTime = bangkokTimeHhMm(input.lineTimestampMs);
    if (!transactionTime) {
      return { status: "refused", reason: "invalid_line_timestamp" };
    }

    // One guided owner per (source, market, business date), enforced BEFORE the
    // open RPC. The session key is per operator, so open_or_rotate cannot see
    // that a second member of the same LINE group is already standing on this
    // round; without this check B could open a parallel round and then pass
    // every per-operator guard on the way to the shared White Sheet and slips.
    //
    // Same-operator retry is unaffected: they are their own owner, and rotation
    // remains the RPC's decision. A later business date or another market is a
    // different tuple and stays independent.
    const owner = await checkGuidedRoundOwner(this.supabase, {
      sourceId: input.identity.sourceId,
      marketLabelNormalized: normalizedMarketLabel(input.marketLabel),
      businessDate: input.businessDateIso,
      lineUserId: input.identity.lineUserId,
    });
    if (owner.kind === "other_operator") {
      return { status: "round_owned", reason: "other_operator" };
    }
    if (owner.kind === "ambiguous") {
      return { status: "round_owned", reason: "ambiguous" };
    }
    if (owner.kind === "unknown") {
      return { status: "round_owned", reason: "unknown" };
    }

    const lookup = await this.pending.lookup(sessionKey);
    if (lookup.reason === "db_error") {
      return { status: "refused", reason: "pending_lookup_failed" };
    }
    const existing = lookup.session;

    // A live session is refused BEFORE the open RPC runs, because the RPC's
    // contract is open-or-ROTATE: reaching it would silently discard the
    // operator's unfinalized round. The one exception is this same LINE event
    // having opened it already — that is a webhook retry, not a second round,
    // and the RPC answers it with `idempotent` without mutating anything.
    if (isLiveSession(existing)) {
      const openedBySameEvent =
        (existing as { opened_line_event_id?: string | null })
          .opened_line_event_id === input.lineEventId;
      if (!openedBySameEvent) {
        return { status: "already_open", sessionKey };
      }
    }

    const result = await this.commands.execute(
      {
        kind: "open",
        sessionKind: "main",
        initialTransactionType:
          TX_CODE_TO_BASE_TRANSACTION_TYPE[input.transactionType],
        declaredTransactionType: null,
        additionalOpener: null,
        businessDate: input.businessDateIso,
        transactionTime,
        transactionTimeSource: "line_event",
        staffLabel: input.sellerLabel,
        marketLabel: input.marketLabel,
        lineEventId: input.lineEventId,
        lineTimestampMs: input.lineTimestampMs,
        // Optimistic concurrency closes the check-then-open race: if anything
        // rotated the row after the lookup above, the RPC refuses instead of
        // overwriting a session this call never saw.
        expectedSessionGeneration: existing?.session_generation ?? null,
      },
      source,
    );

    if (!result.ok) {
      return {
        status: "conflict",
        reason: result.reason,
        detail: result.detail,
      };
    }
    if (result.kind !== "open") {
      return { status: "refused", reason: "unexpected_command_result" };
    }

    return {
      status: "opened",
      outcome: result.outcome,
      sessionKey: result.sessionKey,
      sessionGeneration: result.sessionGeneration,
    };
  }
}
