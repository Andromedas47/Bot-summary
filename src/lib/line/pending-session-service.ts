import type { SupabaseClient } from "@supabase/supabase-js";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class PendingSessionGenerationConflictError extends Error {
  constructor(sessionKey: string, expectedGeneration: string) {
    super(
      `pending session generation conflict for ${sessionKey}: expected generation ${expectedGeneration} is no longer current`,
    );
    this.name = "PendingSessionGenerationConflictError";
  }
}

// Thrown when a content item arrives after the immutable first-close
// boundary for its generation — Release B rejects it outright rather than
// appending it to the ledger (see 0032_pending_session_finalization_barrier.sql).
export class PendingSessionAfterCloseBoundaryError extends Error {
  constructor(sessionKey: string, closeEventTimestampMs: number) {
    super(
      `pending session append rejected for ${sessionKey}: message arrived after the immutable close boundary at ${closeEventTimestampMs}`,
    );
    this.name = "PendingSessionAfterCloseBoundaryError";
  }
}

export class PendingSessionClosedError extends Error {
  constructor(
    sessionKey: string,
    public readonly reason: "terminalized" | "deadline_elapsed" | "close_generation_conflict",
  ) {
    super(`pending session append rejected for ${sessionKey}: ${reason}`);
    this.name = "PendingSessionClosedError";
  }
}

export interface PendingSession {
  id:                        string;
  session_key:               string;
  source_id:                 string;
  accumulated_text:          string;
  latest_reply_token:        string | null;
  line_user_id:              string | null;
  created_at:                string;
  updated_at:                string;
  session_generation:        string;
  close_event_timestamp_ms:  number | null;
  close_requested_at:        string | null;
  close_line_event_id:       string | null;
  close_finalize_started_at: string | null;
  terminalized:              boolean;
  next_attempt_at:           string | null;
  close_deadline_at:         string | null;
  close_session_generation:  string | null;
  expected_item_count:       number | null;
  ingest_revision:           number;
  finalization_started_at?:       string | null;
  finalized_at?:                  string | null;
  finalization_status?:
    | "pending" | "processing" | "failed_closed" | "duplicate" | "finalized";
  finalization_error?:            unknown | null;
  finalized_produce_session_id?:  string | null;
}

export interface TryFinalizeResult {
  status:
    | "skipped"
    | "stale_snapshot"
    | "pending"
    | "failed_closed"
    | "duplicate"
    | "finalized";
  reason?:             string;
  missing?:            number[];
  current_revision?:   number;
  session_id?:         string;
  validation_errors?:  string[];
  notification_id?:    string;
  next_attempt_at?:    string;
}

export interface ClaimFinalizeResult {
  claimed:         boolean;
  reason?:         string;
  admission_count?: number;
  ingest_count?:   number;
  straggler_count?: number;
  session?:        PendingSession;
}

export interface PendingSessionLookup {
  session: PendingSession | null;
  reason: "found" | "no_row" | "db_error";
  error?: string;
}

export interface ReplacePendingSessionInput {
  sessionKey:                string;
  sourceId:                  string;
  expectedSessionGeneration: string;
  text:                      string;
  replyToken:                string | null;
  lineUserId:                string | null;
  lineEventId:               string;
  lineTimestampMs:           number;
  markClose:                 boolean;
  expectedItemCount?:        number;
}

interface PendingRawMessage {
  line_event_id: string;
  raw_text: string | null;
  payload: unknown;
  created_at: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export class PendingSessionService {
  constructor(private readonly supabase: AnyClient) {}

  async get(sessionKey: string): Promise<PendingSession | null> {
    return (await this.lookup(sessionKey)).session;
  }

  async lookup(sessionKey: string): Promise<PendingSessionLookup> {
    const { data, error } = await this.supabase
      .from("pending_sessions")
      .select("*")
      .eq("session_key", sessionKey)
      .maybeSingle();

    if (error) {
      return { session: null, reason: "db_error", error: error.message };
    }
    if (!data) return { session: null, reason: "no_row" };
    return { session: data as PendingSession, reason: "found" };
  }

  async create(
    sessionKey:  string,
    sourceId:    string,
    text:        string,
    replyToken:  string | null,
    lineUserId:  string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("pending_sessions").upsert(
      {
        session_key:        sessionKey,
        source_id:          sourceId,
        accumulated_text:   text,
        latest_reply_token: replyToken,
        line_user_id:       lineUserId,
        updated_at:         now,
        // Reset created_at so queryStart in rebuildForFinalization is correct
        // even when a stale row from a prior session survives the upsert.
        created_at:         now,
        close_event_timestamp_ms:  null,
        close_requested_at:        null,
        close_line_event_id:       null,
        close_finalize_started_at: null,
        terminalized:              false,
        next_attempt_at:           null,
        close_deadline_at:         null,
        close_session_generation:  null,
        expected_item_count:       null,
        ingest_revision:           0,
        finalization_started_at:      null,
        finalized_at:                 null,
        finalization_status:          "pending",
        finalization_error:           null,
        finalized_produce_session_id: null,
      },
      { onConflict: "session_key" },
    );
    if (error) throw new Error(`pending session create failed: ${error.message}`);
  }

  async replaceGeneration(
    input: ReplacePendingSessionInput,
  ): Promise<PendingSession | null> {
    const now = new Date();
    const nowIso = now.toISOString();
    const replacementGeneration = crypto.randomUUID();
    const closeDeadline = input.markClose
      ? new Date(now.getTime() + 30_000).toISOString()
      : null;
    const nextAttempt = input.markClose
      ? new Date(now.getTime() + 8_000).toISOString()
      : null;
    const { data, error } = await this.supabase
      .from("pending_sessions")
      .update({
        session_generation:        replacementGeneration,
        source_id:                 input.sourceId,
        accumulated_text:          input.text,
        latest_reply_token:        input.replyToken,
        line_user_id:              input.lineUserId,
        created_at:                nowIso,
        updated_at:                nowIso,
        close_event_timestamp_ms:  input.markClose ? input.lineTimestampMs : null,
        close_requested_at:        input.markClose ? nowIso : null,
        close_line_event_id:       input.markClose ? input.lineEventId : null,
        close_finalize_started_at: null,
        terminalized:              false,
        next_attempt_at:           nextAttempt,
        close_deadline_at:         closeDeadline,
        close_session_generation:  input.markClose ? replacementGeneration : null,
        expected_item_count:       input.markClose ? input.expectedItemCount ?? null : null,
        ingest_revision:           1,
        finalization_started_at:      null,
        finalized_at:                 null,
        finalization_status:          "pending",
        finalization_error:           null,
        finalized_produce_session_id: null,
      })
      .eq("session_key", input.sessionKey)
      .eq("session_generation", input.expectedSessionGeneration)
      .select("*")
      .maybeSingle();

    if (error) {
      throw new Error(`pending session generation replace failed: ${error.message}`);
    }
    if (!data) return null;

    try {
      const { error: ingestError } = await this.supabase
        .from("pending_session_ingest")
        .insert({
          session_key:        input.sessionKey,
          session_generation: replacementGeneration,
          line_event_id:      input.lineEventId,
          line_timestamp_ms:  input.lineTimestampMs,
          raw_text:           input.text,
        });
      if (ingestError) {
        throw new Error(`pending session replacement ingest failed: ${ingestError.message}`);
      }

      const { error: admissionError } = await this.supabase
        .from("pending_session_admission")
        .insert({
          session_key:        input.sessionKey,
          session_generation: replacementGeneration,
          line_event_id:      input.lineEventId,
          line_timestamp_ms:  input.lineTimestampMs,
        });
      if (admissionError) {
        throw new Error(`pending session replacement admission failed: ${admissionError.message}`);
      }
    } catch (registrationError) {
      await this.deleteGeneration(input.sessionKey, replacementGeneration);
      throw registrationError;
    }

    return data as PendingSession;
  }

  async append(
    sessionKey:          string,
    newText:             string,
    replyToken:          string | null,
    lineEventId?:        string,
    lineTimestampMs?:    number,
    markClose?:          boolean,
    expectedGeneration?: string,
    expectedItemCount?:  number,
  ): Promise<PendingSession> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("append_pending_session", {
      p_session_key:                  sessionKey,
      p_new_text:                     newText,
      p_reply_token:                  replyToken,
      p_line_event_id:                lineEventId     ?? null,
      p_line_timestamp_ms:            lineTimestampMs ?? null,
      p_mark_close:                   markClose       ?? false,
      p_expected_session_generation:  expectedGeneration ?? null,
      p_expected_item_count:          expectedItemCount  ?? null,
    });
    if (error) throw new Error(`pending session append failed: ${error.message}`);
    const result = data as {
      accepted: boolean;
      reason?: string;
      session?: PendingSession;
    } | null;
    if (!result || !result.accepted) {
      const reason = result?.reason;
      if (reason === "generation_conflict" && expectedGeneration) {
        throw new PendingSessionGenerationConflictError(sessionKey, expectedGeneration);
      }
      if (reason === "after_close_boundary") {
        const boundary = result?.session?.close_event_timestamp_ms ?? lineTimestampMs ?? 0;
        throw new PendingSessionAfterCloseBoundaryError(sessionKey, boundary);
      }
      if (
        reason === "terminalized"
        || reason === "deadline_elapsed"
        || reason === "close_generation_conflict"
      ) {
        throw new PendingSessionClosedError(sessionKey, reason);
      }
      throw new Error(`pending session not found for append: ${sessionKey}`);
    }
    return result.session as PendingSession;
  }

  async tryFinalizeGeneration(
    sessionKey:         string,
    expectedGeneration: string,
    expectedLineUserId: string | null,
    snapshotRevision:   number,
    sessionHash:        string,
    rawText:            string,
    sessionPayload:     Record<string, unknown>,
    items:              Array<Record<string, unknown>>,
  ): Promise<TryFinalizeResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("try_finalize_pending_generation", {
      p_session_key:         sessionKey,
      p_expected_generation: expectedGeneration,
      p_expected_line_user_id: expectedLineUserId,
      p_snapshot_revision:   snapshotRevision,
      p_session_hash:        sessionHash,
      p_raw_text:            rawText,
      p_session:             sessionPayload,
      p_items:               items,
    });
    if (error) throw new Error(`pending session finalize failed: ${error.message}`);
    return data as TryFinalizeResult;
  }

  async admit(
    sessionKey:          string,
    lineEventId:         string,
    lineTimestampMs:     number,
    expectedGeneration?: string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("admit_pending_session_event", {
      p_session_key:                  sessionKey,
      p_line_event_id:                lineEventId,
      p_line_timestamp_ms:            lineTimestampMs,
      p_expected_session_generation:  expectedGeneration ?? null,
    });
    if (error) throw new Error(`pending session admit failed: ${error.message}`);
    if (data === false) {
      if (expectedGeneration) {
        throw new PendingSessionGenerationConflictError(sessionKey, expectedGeneration);
      }
      throw new Error(`pending session admit failed: session not found for ${sessionKey}`);
    }
  }

  async registerIngest(
    sessionKey:     string,
    lineEventId:    string,
    lineTimestampMs: number,
    rawText:        string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (this.supabase as any).rpc("register_pending_session_ingest", {
      p_session_key:       sessionKey,
      p_line_event_id:     lineEventId,
      p_line_timestamp_ms: lineTimestampMs,
      p_raw_text:          rawText,
    });
    if (error) throw new Error(`pending session register ingest failed: ${error.message}`);
  }

  async claimFinalize(
    sessionKey:          string,
    expectedGeneration?: string,
  ): Promise<ClaimFinalizeResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("claim_pending_close_finalize", {
      p_session_key:                 sessionKey,
      p_expected_session_generation: expectedGeneration ?? null,
    });
    if (error) throw new Error(`pending session claim failed: ${error.message}`);
    return data as ClaimFinalizeResult;
  }

  async loadIngestRows(
    sessionKey:        string,
    sessionGeneration: string,
    closeTimestampMs:  number,
  ): Promise<Array<{ line_event_id: string; line_timestamp_ms: number; raw_text: string }>> {
    const { data, error } = await this.supabase
      .from("pending_session_ingest")
      .select("line_event_id, line_timestamp_ms, raw_text")
      .eq("session_key", sessionKey)
      .eq("session_generation", sessionGeneration)
      .lte("line_timestamp_ms", closeTimestampMs)
      .order("line_timestamp_ms", { ascending: true })
      .order("line_event_id", { ascending: true });

    if (error) throw new Error(`pending session ingest load failed: ${error.message}`);
    return (data ?? []) as Array<{ line_event_id: string; line_timestamp_ms: number; raw_text: string }>;
  }

  // Conditional update: only clears the claim if close_finalize_started_at still matches
  // the value set by our specific claim call, preventing a concurrent retry-close from
  // being inadvertently released.
  async releaseFinalizeClaim(sessionKey: string, claimedAt: string): Promise<void> {
    const { error } = await this.supabase
      .from("pending_sessions")
      .update({ close_finalize_started_at: null })
      .eq("session_key", sessionKey)
      .eq("close_finalize_started_at", claimedAt);
    if (error) throw new Error(`release finalize claim failed: ${error.message}`);
  }

  async delete(sessionKey: string): Promise<void> {
    const { error } = await this.supabase
      .from("pending_sessions")
      .delete()
      .eq("session_key", sessionKey);
    if (error) throw new Error(`pending session delete failed: ${error.message}`);
  }

  async deleteGeneration(sessionKey: string, sessionGeneration: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("pending_sessions")
      .delete()
      .eq("session_key", sessionKey)
      .eq("session_generation", sessionGeneration)
      .select("session_generation");
    if (error) throw new Error(`pending session generation delete failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  isExpired(session: PendingSession): boolean {
    return Date.now() - new Date(session.updated_at).getTime() > TIMEOUT_MS;
  }

  expiresAt(session: PendingSession): string {
    return new Date(new Date(session.updated_at).getTime() + TIMEOUT_MS).toISOString();
  }

  async rebuildForFinalization(
    session: PendingSession,
    endEventTimestamp: number,
  ): Promise<string> {
    // Fail closed rather than reconstruct from every sender in the source: a
    // null sender here would mean scoping this query by source_id alone,
    // which is exactly the cross-sender contamination this method exists to
    // prevent (see getPendingSessionKey in verify.ts).
    if (!session.line_user_id) {
      throw new Error(
        `pending session raw-message rebuild refused: no line_user_id to scope reconstruction for ${session.session_key}`,
      );
    }

    const queryStart = new Date(
      new Date(session.created_at).getTime() - 5 * 60 * 1000,
    ).toISOString();
    // Cap the upper bound to 60 s after the close event so stale created_at on
    // a re-used session row never pulls in messages from a different session.
    const queryEnd = new Date(endEventTimestamp + 60_000).toISOString();

    const { data, error } = await this.supabase
      .from("raw_messages")
      .select("line_event_id, raw_text, payload, created_at")
      .eq("source_id", session.source_id)
      .eq("user_id", session.line_user_id)
      .eq("message_type", "text")
      .gte("created_at", queryStart)
      .lte("created_at", queryEnd)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`pending session raw-message rebuild failed: ${error.message}`);
    }

    return rebuildPendingSessionText(
      session.accumulated_text,
      (data ?? []) as PendingRawMessage[],
      endEventTimestamp,
    );
  }
}

export function rebuildPendingSessionText(
  currentText: string,
  rows: PendingRawMessage[],
  endEventTimestamp: number,
): string {
  const initialHeader = currentText.split("\n")[0]?.trim();
  if (!initialHeader) return currentText;

  const ordered = rows
    .map((row, index) => ({
      ...row,
      index,
      eventTimestamp: readEventTimestamp(row.payload),
    }))
    .filter(
      (row) =>
        row.raw_text !== null
        && row.eventTimestamp !== null
        && row.eventTimestamp <= endEventTimestamp,
    )
    .sort(
      (a, b) =>
        (a.eventTimestamp! - b.eventTimestamp!)
        || a.created_at.localeCompare(b.created_at)
        || a.index - b.index,
    );

  let headerIndex = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (ordered[index].raw_text?.trim() === initialHeader) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) {
    // Throw so the caller can fail closed; returning stale accumulated_text
    // risks contaminating the session with data from an earlier session on the same source.
    throw new Error(
      `session header "${initialHeader}" not found in raw_messages — cannot reconstruct session boundary safely`,
    );
  }

  const seen = new Set<string>();
  const texts: string[] = [];
  for (const row of ordered.slice(headerIndex)) {
    if (seen.has(row.line_event_id)) continue;
    seen.add(row.line_event_id);
    texts.push(row.raw_text!);
  }

  return texts.length > 0 ? texts.join("\n") : currentText;
}

function readEventTimestamp(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("timestamp" in payload)) return null;
  const timestamp = (payload as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}
