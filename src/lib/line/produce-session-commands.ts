import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PendingSessionService,
  type PendingSession,
} from "@/lib/line/pending-session-service";
import {
  COMMAND_CONTRACT_VERSION,
  isStructuredSession,
  type StructuredSessionMetadata,
  type TransactionTimeSource,
} from "@/lib/parsers/weigh-session/seed";
import { findProduceSessionHeader } from "@/lib/line/webhook-service";
import { ADDITIONAL_TYPE_MAP } from "@/lib/parsers/weigh-session/parser";
import type { BaseTransactionType, SessionKind } from "@/lib/parsers/weigh-session/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** A pending session row plus the 0049 structured metadata columns. */
export type StructuredPendingSession = PendingSession & Partial<StructuredSessionMetadata>;

/**
 * Source identity for a typed command.
 *
 * All three LINE source types stay explicit — a "group" is not a "user" with a
 * group id attached, and the session key differs per type. lineUserId is
 * nullable at the type level precisely so the fail-closed check below has
 * something to reject: LINE omits it for some group/room events, and a menu
 * command that cannot be attributed to a person must never take a session key
 * shared by everyone in the group.
 */
export interface ProduceCommandSource {
  type: "user" | "group" | "room";
  sourceId: string;
  groupId?: string | null;
  roomId?: string | null;
  lineUserId: string | null;
}

export interface OpenProduceSessionCommand {
  kind: "open";
  /** Both kinds are supported by the service. Which ones a menu chooses to
   *  expose is a UI decision and is deliberately not encoded here. */
  sessionKind: SessionKind;
  /** Required for both kinds. For "additional" it must equal declaredTransactionType. */
  initialTransactionType: BaseTransactionType;
  declaredTransactionType: BaseTransactionType | null;
  additionalOpener: string | null;
  businessDate: string;
  transactionTime: string;
  transactionTimeSource: TransactionTimeSource;
  staffLabel: string;
  marketLabel: string;
  lineEventId: string;
  lineTimestampMs: number;
  expectedSessionGeneration?: string | null;
}

export interface AppendProduceSessionCommand {
  kind: "append";
  text: string;
  lineEventId: string;
  lineTimestampMs: number;
  expectedSessionGeneration?: string | null;
}

export interface CloseProduceSessionCommand {
  kind: "close";
  lineEventId: string;
  lineTimestampMs: number;
  expectedItemCount?: number | null;
  expectedSessionGeneration?: string | null;
}

/** Control-event confirmation that releases the 0050 finalization hold. */
export interface ConfirmProduceSessionCommand {
  kind: "confirm";
  lineEventId: string;
  expectedSessionGeneration?: string | null;
}

export interface StatusProduceSessionCommand {
  kind: "status";
}

export type ProduceSessionCommand =
  | OpenProduceSessionCommand
  | AppendProduceSessionCommand
  | CloseProduceSessionCommand
  | ConfirmProduceSessionCommand
  | StatusProduceSessionCommand;

export type ProduceCommandResult =
  | { ok: true; kind: "open"; outcome: "opened" | "rotated" | "idempotent"; sessionKey: string; sessionGeneration: string }
  | { ok: true; kind: "append"; sessionKey: string; session: StructuredPendingSession }
  | { ok: true; kind: "close"; sessionKey: string; reason: "first_close" | "close_already_requested"; session: StructuredPendingSession }
  | {
      ok: true;
      kind: "confirm";
      sessionKey: string;
      reason: "confirmed" | "already_confirmed";
      session: StructuredPendingSession;
    }
  | { ok: true; kind: "status"; sessionKey: string; structured: boolean; session: StructuredPendingSession | null }
  | { ok: false; reason: ProduceCommandRejection; detail?: string; admission_count?: number; ingest_count?: number; straggler_count?: number };

export type ProduceCommandRejection =
  | "missing_line_user_id"
  | "invalid_source"
  | "invalid_command"
  | "not_found"
  | "not_structured"
  | "ownership_conflict"
  | "generation_conflict"
  | "structured_header_refused"
  | "terminalized"
  | "not_closing"
  | "not_held"
  | "hold_expired"
  | "not_ready";

/** Mirrors getPendingSessionKey in verify.ts, including its fail-closed nulls. */
export function produceSessionKey(source: ProduceCommandSource): string | null {
  if (!source.lineUserId) return null;
  if (source.type === "group") {
    return source.groupId ? `group:${source.groupId}:user:${source.lineUserId}` : null;
  }
  if (source.type === "room") {
    return source.roomId ? `room:${source.roomId}:user:${source.lineUserId}` : null;
  }
  return `dm:${source.lineUserId}`;
}

/**
 * The authoritative produce ingest identity: `<session_key>:<session_generation>`.
 *
 * 0036 makes `produce_sessions.ingest_idempotency_key` the idempotency identity,
 * and the deferred finalizer writes exactly this value. Anything that needs to
 * ask "were THIS generation's produce rows written?" must derive the key here
 * rather than composing the string again — see produce-finalization.ts.
 */
export function produceIngestIdempotencyKey(
  sessionKey: string,
  sessionGeneration: string | null | undefined,
): string | null {
  const key = sessionKey.trim();
  const generation = String(sessionGeneration ?? "").trim();
  if (!key || !generation) return null;
  return `${key}:${generation}`;
}

/**
 * True when the text carries a produce session header.
 *
 * Delegates to the webhook's findProduceSessionHeader so structured-append
 * refusal and pending creation/rotation share one predicate: SESSION_START
 * plus seller/market, a รายการ… opener, or a date — never bare เบิก/คืน/คืนเสีย
 * embedded in a product name.
 */
export function containsProduceHeader(text: string): boolean {
  return findProduceSessionHeader(text) !== null;
}

/**
 * The domain-command entry point for structured produce sessions.
 *
 * Future text and postback adapters call this; neither the legacy webhook text
 * flow nor any existing RPC signature is changed by its existence. Postbacks
 * are handled as typed commands and are never converted into synthetic Thai
 * messages — a control event must not enter the parser's input.
 */
export class ProduceSessionCommandService {
  private readonly pending: PendingSessionService;

  constructor(private readonly supabase: AnyClient) {
    this.pending = new PendingSessionService(supabase);
  }

  async execute(
    command: ProduceSessionCommand,
    source: ProduceCommandSource,
    guidedMarketLabelNormalized?: string,
  ): Promise<ProduceCommandResult> {
    // Fail closed before anything else: no identity, no session key, no write.
    const sessionKey = produceSessionKey(source);
    if (!source.lineUserId) {
      return { ok: false, reason: "missing_line_user_id" };
    }
    if (!sessionKey) {
      return { ok: false, reason: "invalid_source", detail: `source type ${source.type} lacks its id` };
    }
    if (!source.sourceId?.trim()) {
      return { ok: false, reason: "invalid_source", detail: "sourceId is required" };
    }
    // The source must bind to the session key it implies before any read or
    // write: a mismatched sourceId/groupId/roomId would key traffic under a
    // session that does not belong to it.
    const badSource = validateCommandSource(source);
    if (badSource) return { ok: false, reason: "invalid_source", detail: badSource };

    switch (command.kind) {
      case "open":    return this.open(
        command,
        source,
        sessionKey,
        guidedMarketLabelNormalized,
      );
      case "append":  return this.append(command, source, sessionKey);
      case "close":   return this.close(command, source, sessionKey);
      case "confirm": return this.confirm(command, source, sessionKey);
      case "status":  return this.status(sessionKey);
    }
  }

  /**
   * Open or rotate. Rotation happens ONLY here — an explicit typed command.
   * There is no implicit rotation from observing a header in message text.
   */
  private async open(
    command: OpenProduceSessionCommand,
    source: ProduceCommandSource,
    sessionKey: string,
    guidedMarketLabelNormalized?: string,
  ): Promise<ProduceCommandResult> {
    const invalid = validateOpenCommand(command);
    if (invalid) return { ok: false, reason: "invalid_command", detail: invalid };
    if (guidedMarketLabelNormalized !== undefined && !guidedMarketLabelNormalized.trim()) {
      return {
        ok: false,
        reason: "invalid_command",
        detail: "guidedMarketLabelNormalized is required for a guided open",
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc(
      guidedMarketLabelNormalized === undefined
        ? "open_or_rotate_produce_structured_session"
        : "open_or_rotate_guided_produce_structured_session",
      {
        p_session_key:               sessionKey,
        p_source_type:               source.type,
        p_source_id:                 source.sourceId,
        p_line_user_id:              source.lineUserId,
        p_opened_line_event_id:      command.lineEventId,
        p_line_timestamp_ms:         command.lineTimestampMs,
        p_command_contract_version:  COMMAND_CONTRACT_VERSION,
        p_business_date:             command.businessDate,
        p_transaction_time:          command.transactionTime,
        p_transaction_time_source:   command.transactionTimeSource,
        p_staff_label:               command.staffLabel,
        p_market_label:              command.marketLabel,
        ...(guidedMarketLabelNormalized === undefined
          ? {}
          : { p_market_label_normalized: guidedMarketLabelNormalized }),
        p_session_kind:              command.sessionKind,
        p_initial_transaction_type:  command.initialTransactionType,
        p_declared_transaction_type: command.declaredTransactionType,
        p_additional_opener:         command.additionalOpener,
        p_expected_session_generation: command.expectedSessionGeneration ?? null,
      },
    );
    if (error) throw new Error(`structured session open failed: ${error.message}`);

    const result = data as {
      outcome: string;
      session_generation: string;
      reason?: string;
    } | null;
    if (!result) return { ok: false, reason: "not_found" };

    if (result.outcome === "ownership_conflict") {
      return { ok: false, reason: "ownership_conflict", detail: result.reason };
    }
    if (result.outcome === "generation_conflict") {
      return { ok: false, reason: "generation_conflict", detail: result.reason };
    }

    return {
      ok: true,
      kind: "open",
      outcome: result.outcome as "opened" | "rotated" | "idempotent",
      sessionKey,
      sessionGeneration: result.session_generation,
    };
  }

  /**
   * Append parser-consumable operator text.
   *
   * A textual header arriving inside a structured session is refused BEFORE the
   * append RPC runs, so it is never appended, never admitted and never
   * ingested. Rotating on a typed-open session because someone pasted a header
   * would silently discard the operator's declared metadata.
   */
  private async append(
    command: AppendProduceSessionCommand,
    source: ProduceCommandSource,
    sessionKey: string,
  ): Promise<ProduceCommandResult> {
    // Before any lookup or RPC: a degenerate append must leave both ledgers,
    // accumulated_text and ingest_revision completely untouched.
    const invalid = validateAppendCommand(command);
    if (invalid) return { ok: false, reason: "invalid_command", detail: invalid };

    const lookup = await this.pending.lookup(sessionKey);
    const row = lookup.session as StructuredPendingSession | null;
    if (!row) return { ok: false, reason: "not_found" };
    if (row.entry_origin == null) return { ok: false, reason: "not_structured" };
    if (row.line_user_id && row.line_user_id !== source.lineUserId) {
      return { ok: false, reason: "ownership_conflict" };
    }
    if (row.terminalized) return { ok: false, reason: "terminalized" };

    if (containsProduceHeader(command.text)) {
      return {
        ok: false,
        reason: "structured_header_refused",
        detail: "a structured session is opened by a typed command; a text header cannot replace it",
      };
    }

    const session = await this.pending.append(
      sessionKey,
      command.text,
      null,
      command.lineEventId,
      command.lineTimestampMs,
      false,
      command.expectedSessionGeneration ?? row.session_generation,
    );
    return { ok: true, kind: "append", sessionKey, session: session as StructuredPendingSession };
  }

  /**
   * Close as a control event: sets the immutable boundary and the real
   * close_line_event_id, and writes no admission row, no ingest row and no
   * synthetic close text.
   */
  private async close(
    command: CloseProduceSessionCommand,
    source: ProduceCommandSource,
    sessionKey: string,
  ): Promise<ProduceCommandResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc(
      "close_produce_structured_session",
      {
        p_session_key:                 sessionKey,
        p_line_user_id:                source.lineUserId,
        p_close_line_event_id:         command.lineEventId,
        p_line_timestamp_ms:           command.lineTimestampMs,
        p_expected_session_generation: command.expectedSessionGeneration ?? null,
        p_expected_item_count:         command.expectedItemCount ?? null,
      },
    );
    if (error) throw new Error(`structured session close failed: ${error.message}`);

    const result = data as {
      accepted: boolean;
      reason?: string;
      session?: StructuredPendingSession;
    } | null;
    if (!result || !result.accepted) {
      const reason = result?.reason;
      if (reason === "not_found")           return { ok: false, reason: "not_found" };
      if (reason === "not_structured")      return { ok: false, reason: "not_structured" };
      if (reason === "ownership_conflict")  return { ok: false, reason: "ownership_conflict" };
      if (reason === "generation_conflict") return { ok: false, reason: "generation_conflict" };
      if (reason === "terminalized")        return { ok: false, reason: "terminalized" };
      return { ok: false, reason: "invalid_command", detail: reason };
    }

    return {
      ok: true,
      kind: "close",
      sessionKey,
      reason: result.reason as "first_close" | "close_already_requested",
      session: result.session as StructuredPendingSession,
    };
  }

  /**
   * Confirm finalization for a held structured session.
   * Writes no admission/ingest/synthetic text and does not persist Produce rows.
   */
  private async confirm(
    command: ConfirmProduceSessionCommand,
    source: ProduceCommandSource,
    sessionKey: string,
  ): Promise<ProduceCommandResult> {
    if (!command.lineEventId?.trim()) {
      return { ok: false, reason: "invalid_command", detail: "lineEventId is required" };
    }

    const result = await this.pending.confirmFinalization(
      sessionKey,
      source.lineUserId!,
      command.lineEventId,
      command.expectedSessionGeneration ?? null,
    );

    if (!result.accepted) {
      const reason = result.reason;
      if (reason === "not_found")           return { ok: false, reason: "not_found" };
      if (reason === "not_structured")      return { ok: false, reason: "not_structured" };
      if (reason === "ownership_conflict")  return { ok: false, reason: "ownership_conflict" };
      if (reason === "generation_conflict") return { ok: false, reason: "generation_conflict" };
      if (reason === "terminalized")        return { ok: false, reason: "terminalized" };
      if (reason === "not_closing")         return { ok: false, reason: "not_closing" };
      if (reason === "not_held")            return { ok: false, reason: "not_held" };
      if (reason === "hold_expired")        return { ok: false, reason: "hold_expired" };
      if (reason === "not_ready") {
        return {
          ok: false,
          reason: "not_ready",
          detail: result.readiness_reason ?? reason,
          admission_count: result.admission_count,
          ingest_count: result.ingest_count,
          straggler_count: result.straggler_count,
        };
      }
      return { ok: false, reason: "invalid_command", detail: reason };
    }

    return {
      ok: true,
      kind: "confirm",
      sessionKey,
      reason: result.reason as "confirmed" | "already_confirmed",
      session: result.session as StructuredPendingSession,
    };
  }

  /** Read-only. Reports whether the row is a contract-compatible structured session. */
  private async status(sessionKey: string): Promise<ProduceCommandResult> {
    const lookup = await this.pending.lookup(sessionKey);
    const row = lookup.session as StructuredPendingSession | null;
    return {
      ok: true,
      kind: "status",
      sessionKey,
      structured: isStructuredSession(row),
      session: row,
    };
  }
}

function validateOpenCommand(command: OpenProduceSessionCommand): string | null {
  if (!command.staffLabel?.trim())  return "staffLabel is required";
  if (!command.marketLabel?.trim()) return "marketLabel is required";
  if (!command.businessDate)        return "businessDate is required";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(command.businessDate)) return "businessDate must be ISO yyyy-mm-dd";
  if (!command.transactionTime)     return "transactionTime is required";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(command.transactionTime)) return "transactionTime must be HH:MM";
  if (!command.lineEventId?.trim()) return "lineEventId is required";
  if (!(command.lineTimestampMs > 0)) return "lineTimestampMs must be positive";

  // Required for both kinds — a guided main session may be ชั่งคืน or คืนเสีย,
  // and there is no textual section marker to recover that from later.
  if (!BASE_TRANSACTION_TYPES.includes(command.initialTransactionType)) {
    return "initialTransactionType is required and must be a base transaction type";
  }

  if (command.sessionKind === "additional") {
    if (!command.declaredTransactionType) {
      return "an additional session requires declaredTransactionType";
    }
    if (!command.additionalOpener) {
      return "an additional session requires additionalOpener";
    }
    if (command.initialTransactionType !== command.declaredTransactionType) {
      return "an additional session's initialTransactionType must equal declaredTransactionType";
    }
    if (ADDITIONAL_TYPE_MAP[command.additionalOpener] !== command.declaredTransactionType) {
      return `additionalOpener ${command.additionalOpener} does not declare ${command.declaredTransactionType}`;
    }
  } else {
    if (command.declaredTransactionType || command.additionalOpener) {
      return "a main session must not declare a transaction type or additional opener";
    }
  }
  return null;
}

// Derived from the opener map so the three base types are declared in exactly
// one place, and so no Thai literal is needed in this module's executable code.
const BASE_TRANSACTION_TYPES: readonly BaseTransactionType[] =
  Object.values(ADDITIONAL_TYPE_MAP);

/**
 * Blank/degenerate append rejection, evaluated before any lookup or RPC.
 *
 * append_pending_session writes the admission row and the ingest row in one
 * statement pair, but only a non-blank raw_text counts towards ingest parity in
 * check_pending_close_ready. A whitespace-only append therefore produces
 * admission_count = 1 / ingest_count = 0, which never reaches parity and strands
 * the session until the hard deadline. Refusing here means no admission row, no
 * ingest row, no accumulated_text change and no ingest_revision bump.
 */
function validateAppendCommand(command: AppendProduceSessionCommand): string | null {
  if (typeof command.text !== "string" || command.text.trim() === "") {
    return "append text must contain at least one non-whitespace character";
  }
  if (!command.lineEventId?.trim()) return "lineEventId is required";
  if (!Number.isSafeInteger(command.lineTimestampMs) || command.lineTimestampMs <= 0) {
    return "lineTimestampMs must be a positive safe integer";
  }
  if (command.expectedSessionGeneration !== undefined
      && command.expectedSessionGeneration !== null
      && command.expectedSessionGeneration.trim() === "") {
    return "expectedSessionGeneration must be non-blank when provided";
  }
  return null;
}

/**
 * The source object must agree with itself before it is trusted to name a
 * session key. LINE delivers the group/room id and the user id separately; a
 * caller that passes a group id as sourceId while claiming type "user" would
 * otherwise mint `dm:<user>` for traffic that belongs to a group key.
 */
export function validateCommandSource(source: ProduceCommandSource): string | null {
  const sourceId = source.sourceId?.trim() ?? "";
  if (source.type === "group") {
    if (!source.groupId?.trim()) return "a group source requires groupId";
    if (sourceId !== source.groupId.trim()) return "group sourceId must equal groupId";
    return null;
  }
  if (source.type === "room") {
    if (!source.roomId?.trim()) return "a room source requires roomId";
    if (sourceId !== source.roomId.trim()) return "room sourceId must equal roomId";
    return null;
  }
  if (sourceId !== (source.lineUserId ?? "").trim()) {
    return "a user source must have sourceId equal to lineUserId";
  }
  return null;
}
