import type { SupabaseClient } from "@supabase/supabase-js";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";



const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes



export interface PendingSession {

  id:                  string;

  session_key:         string;

  session_generation:  string;

  accumulated_text:    string;

  latest_reply_token:  string | null;

  line_user_id:        string | null;

  created_at:          string;

  updated_at:          string;

  close_event_timestamp_ms?: number | null;

  close_requested_at?:      string | null;

  close_line_event_id?:     string | null;

  close_finalize_started_at?: string | null;

}



export interface PendingCloseClaim {

  claimed:          boolean;

  reason?:          string;

  session?:         PendingSession;

  admissionCount?:  number;

  ingestCount?:     number;

  stragglerCount?:  number;

}



export interface PendingCloseReadiness {

  ready:            boolean;

  reason?:          string;

  admissionCount?:  number;

  ingestCount?:     number;

  stragglerCount?:  number;

}



export interface PendingSessionLookup {

  session: PendingSession | null;

  reason: "found" | "no_row" | "db_error";

  error?: string;

}



interface PendingRawMessage {

  line_event_id: string;

  raw_text: string | null;

  payload: unknown;

  created_at: string;

}



export interface PendingSessionIngestRow {

  line_event_id:     string;

  line_timestamp_ms: number;

  raw_text:          string | null;

}



// eslint-disable-next-line @typescript-eslint/no-explicit-any

type AnyClient = SupabaseClient<any>;



function newGenerationId(): string {

  return crypto.randomUUID();

}



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

    text:        string,

    replyToken:  string | null,

    lineUserId:  string | null,

    lineEventId?: string,

    lineTimestampMs?: number,

  ): Promise<void> {

    const generation = newGenerationId();

    const now = new Date().toISOString();

    const { error } = await this.supabase.from("pending_sessions").upsert(

      {

        session_key:              sessionKey,

        session_generation:       generation,

        accumulated_text:         text,

        latest_reply_token:       replyToken,

        line_user_id:             lineUserId,

        created_at:               now,

        updated_at:               now,

        close_event_timestamp_ms: null,

        close_requested_at:       null,

        close_line_event_id:      null,

        close_finalize_started_at: null,

      },

      { onConflict: "session_key" },

    );

    if (error) throw new Error(`pending session create failed: ${error.message}`);



    if (lineEventId != null && lineTimestampMs != null) {

      await this.registerIngest(sessionKey, lineEventId, lineTimestampMs, text);

      await this.admit(sessionKey, lineEventId, lineTimestampMs);

    }

  }



  async admit(

    sessionKey:      string,

    lineEventId:     string,

    lineTimestampMs: number,

  ): Promise<void> {

    // eslint-disable-next-line @typescript-eslint/no-explicit-any

    const rpc = (this.supabase as any).rpc?.bind(this.supabase);

    if (!rpc) {

      await admitPendingSessionEventFromTables(this.supabase, sessionKey, lineEventId, lineTimestampMs);

      return;

    }



    const { error } = await rpc("admit_pending_session_event", {

      p_session_key:         sessionKey,

      p_line_event_id:       lineEventId,

      p_line_timestamp_ms:   lineTimestampMs,

    });

    if (error) throw new Error(`pending session admission failed: ${error.message}`);

  }



  async registerIngest(

    sessionKey:      string,

    lineEventId:     string,

    lineTimestampMs: number,

    rawText?:        string,

  ): Promise<void> {

    if (rawText == null || rawText.trim() === "") return;



    // eslint-disable-next-line @typescript-eslint/no-explicit-any

    const rpc = (this.supabase as any).rpc?.bind(this.supabase);

    if (!rpc) {

      await registerPendingSessionIngestFromTables(

        this.supabase,

        sessionKey,

        lineEventId,

        lineTimestampMs,

        rawText,

      );

      return;

    }



    const { error } = await rpc("register_pending_session_ingest", {

      p_session_key:         sessionKey,

      p_line_event_id:       lineEventId,

      p_line_timestamp_ms:   lineTimestampMs,

      p_raw_text:            rawText,

    });

    if (error) throw new Error(`pending session ingest register failed: ${error.message}`);

  }



  async append(

    sessionKey:  string,

    newText:     string,

    replyToken:  string | null,

    lineEventId?: string,

    lineTimestampMs?: number,

    markClose = false,

  ): Promise<PendingSession> {

    // eslint-disable-next-line @typescript-eslint/no-explicit-any

    const rpc = (this.supabase as any).rpc?.bind(this.supabase);

    if (!rpc) {

      throw new Error("pending session append failed: append_pending_session RPC unavailable");

    }



    const { data, error } = await rpc("append_pending_session", {

      p_session_key:        sessionKey,

      p_new_text:           newText,

      p_reply_token:        replyToken,

      p_line_event_id:      lineEventId ?? null,

      p_line_timestamp_ms:  lineTimestampMs ?? null,

      p_mark_close:         markClose,

    });

    if (error) {

      throw new Error(`pending session append failed: ${error.message}`);

    }



    const row = Array.isArray(data) ? data[0] : data;

    if (!row) throw new Error(`pending session not found after append: ${sessionKey}`);

    return row as PendingSession;

  }



  async markClose(

    sessionKey:      string,

    lineEventId:     string,

    lineTimestampMs: number,

    replyToken:      string | null,

    rawText?:        string,

  ): Promise<PendingSession> {

    const { data, error } = await this.supabase

      .from("pending_sessions")

      .update({

        close_event_timestamp_ms: lineTimestampMs,

        close_requested_at:       new Date().toISOString(),

        close_line_event_id:      lineEventId,

        latest_reply_token:       replyToken,

        updated_at:               new Date().toISOString(),

      })

      .eq("session_key", sessionKey)

      .select("*")

      .single();



    if (error || !data) {

      throw new Error(`pending session mark close failed: ${error?.message ?? "no row"}`);

    }



    if (rawText != null) {

      await this.registerIngest(sessionKey, lineEventId, lineTimestampMs, rawText);

    }

    await this.admit(sessionKey, lineEventId, lineTimestampMs);

    return data as PendingSession;

  }



  isClosing(session: PendingSession): boolean {

    return session.close_event_timestamp_ms != null;

  }



  async checkCloseReady(sessionKey: string): Promise<PendingCloseReadiness> {

    // eslint-disable-next-line @typescript-eslint/no-explicit-any

    const rpc = (this.supabase as any).rpc?.bind(this.supabase);

    if (!rpc) {

      return checkPendingCloseReadyFromTables(this.supabase, sessionKey);

    }



    const { data, error } = await rpc("check_pending_close_ready", {

      p_session_key: sessionKey,

    });

    if (error) throw new Error(`check_pending_close_ready failed: ${error.message}`);



    return mapCloseReadiness(data as Record<string, unknown>);

  }



  async claimCloseFinalize(sessionKey: string): Promise<PendingCloseClaim> {

    // eslint-disable-next-line @typescript-eslint/no-explicit-any

    const rpc = (this.supabase as any).rpc?.bind(this.supabase);

    if (!rpc) {

      return claimPendingCloseFinalizeFromTables(this.supabase, sessionKey);

    }



    const { data, error } = await rpc("claim_pending_close_finalize", {

      p_session_key: sessionKey,

    });

    if (error) throw new Error(`claim_pending_close_finalize failed: ${error.message}`);



    const row = data as Record<string, unknown>;

    return {

      claimed:         Boolean(row.claimed),

      reason:          typeof row.reason === "string" ? row.reason : undefined,

      session:         row.session ? (row.session as PendingSession) : undefined,

      admissionCount:  readCount(row, "admission_count"),

      ingestCount:     readCount(row, "ingest_count"),

      stragglerCount:  readCount(row, "straggler_count"),

    };

  }



  async delete(sessionKey: string): Promise<void> {

    const { error } = await this.supabase

      .from("pending_sessions")

      .delete()

      .eq("session_key", sessionKey);

    if (error) throw new Error(`pending session delete failed: ${error.message}`);

  }



  async resetCloseState(sessionKey: string): Promise<void> {

    const { error } = await this.supabase

      .from("pending_sessions")

      .update({

        close_event_timestamp_ms:  null,

        close_requested_at:        null,

        close_line_event_id:       null,

        close_finalize_started_at: null,

        updated_at:                new Date().toISOString(),

      })

      .eq("session_key", sessionKey);

    if (error) throw new Error(`pending session reset close failed: ${error.message}`);

  }



  isExpired(session: PendingSession): boolean {

    return Date.now() - new Date(session.updated_at).getTime() > TIMEOUT_MS;

  }



  expiresAt(session: PendingSession): string {

    return new Date(new Date(session.updated_at).getTime() + TIMEOUT_MS).toISOString();

  }



  async rebuildForFinalization(

    sourceId: string,

    session: PendingSession,

    endEventTimestamp: number,

  ): Promise<string> {

    const fromIngest = await this.rebuildFromIngestLedger(sourceId, session);

    if (fromIngest != null) return fromIngest;

    const fromAccumulated = rebuildFromAccumulatedText(session);

    if (fromAccumulated != null) return fromAccumulated;



    const queryStart = new Date(

      new Date(session.created_at).getTime() - 5 * 60 * 1000,

    ).toISOString();



    const { data, error } = await this.supabase

      .from("raw_messages")

      .select("line_event_id, raw_text, payload, created_at")

      .eq("source_id", sourceId)

      .eq("message_type", "text")

      .gte("created_at", queryStart)

      .order("created_at", { ascending: true });



    if (error) {

      throw new Error(`pending session raw-message rebuild failed: ${error.message}`);

    }



    const header = session.accumulated_text.split("\n")[0]?.trim() ?? "";

    return rebuildPendingSessionText(

      header,

      (data ?? []) as PendingRawMessage[],

      endEventTimestamp,

    );

  }



  async rebuildFromIngestLedger(

    sessionKey: string,

    session: PendingSession,

  ): Promise<string | null> {

    const closeTs = session.close_event_timestamp_ms;

    if (closeTs == null) return null;



    const { data, error } = await this.supabase

      .from("pending_session_ingest")

      .select("line_event_id, line_timestamp_ms, raw_text")

      .eq("session_key", sessionKey)

      .eq("session_generation", session.session_generation);



    if (error) {

      throw new Error(`pending session ingest lookup failed: ${error.message}`);

    }



    const rows = (data ?? []) as PendingSessionIngestRow[];

    if (rows.length === 0) return null;



    const missingText = rows.some((row) => !row.raw_text?.trim());

    if (missingText) return null;



    const rebuilt = rebuildPendingSessionFromIngest(session, rows);

    if (isIngestLedgerSparse(session, rows, rebuilt)) return null;

    return rebuilt;

  }

}



const LEGACY_PARSE_DATE = "2026-01-01";



function readCount(row: Record<string, unknown>, key: string): number | undefined {

  return typeof row[key] === "number" ? row[key] as number : undefined;

}



/** Pre-0042 sessions may have full accumulated_text but a sparse post-deploy ingest ledger. */

export function accumulatedHasLegacyContent(accumulatedText: string): boolean {

  const lines = accumulatedText.split("\n").map((line) => line.trim()).filter(Boolean);

  return lines.length >= 3;

}



export function isIngestLedgerSparse(

  session: PendingSession,

  rows: PendingSessionIngestRow[],

  ingestText: string,

): boolean {

  const header = session.accumulated_text.split("\n")[0]?.trim() ?? "";

  const accumText = session.accumulated_text.trim();

  if (!header || !accumText) return false;



  const accumItems = parseWeighSession(accumText, LEGACY_PARSE_DATE).items.length;

  if (accumItems === 0) return false;



  if (rows.length === 0) return true;



  const ingestItems = parseWeighSession(ingestText, LEGACY_PARSE_DATE).items.length;

  if (ingestItems < accumItems) return true;



  const ingestHasHeader = rows.some((row) => row.raw_text?.trim() === header);

  return !ingestHasHeader;

}



/** Fallback when ingest ledger post-dates migration and omits pre-deploy lines. */

export function rebuildFromAccumulatedText(session: PendingSession): string | null {

  const text = session.accumulated_text.trim();

  if (!text) return null;



  const header = text.split("\n")[0]?.trim() ?? "";

  if (!header) return null;



  const parsed = parseWeighSession(text, LEGACY_PARSE_DATE);

  if (parsed.items.length === 0) return null;



  return text;

}



function mapCloseReadiness(row: Record<string, unknown>): PendingCloseReadiness {

  return {

    ready:           Boolean(row.ready),

    reason:          typeof row.reason === "string" ? row.reason : undefined,

    admissionCount:  readCount(row, "admission_count"),

    ingestCount:     readCount(row, "ingest_count"),

    stragglerCount:  readCount(row, "straggler_count"),

  };

}



export function rebuildPendingSessionFromIngest(

  session: PendingSession,

  rows: PendingSessionIngestRow[],

): string {

  const closeTs = session.close_event_timestamp_ms;

  if (closeTs == null) {

    throw new Error("pending session is not closing");

  }



  const closeEventId = session.close_line_event_id;

  const eligible = rows.filter(

    (row) =>

      row.line_event_id === closeEventId

      || row.line_timestamp_ms <= closeTs,

  );



  const ordered = [...eligible].sort(

    (a, b) =>

      a.line_timestamp_ms - b.line_timestamp_ms

      || a.line_event_id.localeCompare(b.line_event_id),

  );



  const header = session.accumulated_text.split("\n")[0]?.trim() ?? "";

  if (!header) {

    return ordered.map((row) => row.raw_text!.trim()).join("\n");

  }



  let headerIndex = -1;

  for (let index = ordered.length - 1; index >= 0; index -= 1) {

    if (ordered[index].raw_text?.trim() === header) {

      headerIndex = index;

      break;

    }

  }

  if (headerIndex < 0) {

    return ordered.map((row) => row.raw_text!.trim()).join("\n");

  }



  const seen = new Set<string>();

  const texts: string[] = [];

  for (const row of ordered.slice(headerIndex)) {

    if (seen.has(row.line_event_id)) continue;

    seen.add(row.line_event_id);

    texts.push(row.raw_text!.trim());

  }



  return texts.length > 0 ? texts.join("\n") : ordered.map((row) => row.raw_text!.trim()).join("\n");

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

  if (headerIndex < 0) return currentText;



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



async function admitPendingSessionEventFromTables(

  supabase: AnyClient,

  sessionKey: string,

  lineEventId: string,

  lineTimestampMs: number,

): Promise<void> {

  const session = await loadSession(supabase, sessionKey);

  if (!session) return;



  const exists = (await supabase

    .from("pending_session_admission")

    .select("line_event_id")

    .eq("session_generation", session.session_generation)

    .eq("line_event_id", lineEventId)

    .maybeSingle()).data;

  if (exists) return;



  const { error } = await supabase.from("pending_session_admission").insert({

    session_key:         sessionKey,

    session_generation:  session.session_generation,

    line_event_id:       lineEventId,

    line_timestamp_ms:   lineTimestampMs,

    admitted_at:         new Date().toISOString(),

  });

  if (error) throw new Error(`pending session admission insert failed: ${error.message}`);

}



async function registerPendingSessionIngestFromTables(

  supabase: AnyClient,

  sessionKey: string,

  lineEventId: string,

  lineTimestampMs: number,

  rawText: string,

): Promise<void> {

  const session = await loadSession(supabase, sessionKey);

  if (!session) return;



  const existing = (await supabase

    .from("pending_session_ingest")

    .select("*")

    .eq("session_generation", session.session_generation)

    .eq("line_event_id", lineEventId)

    .maybeSingle()).data as Row | null;



  if (existing) {

    existing.line_timestamp_ms = lineTimestampMs;

    existing.raw_text = rawText;

    return;

  }



  const { error } = await supabase.from("pending_session_ingest").insert({

    session_key:         sessionKey,

    session_generation:  session.session_generation,

    line_event_id:       lineEventId,

    line_timestamp_ms:   lineTimestampMs,

    raw_text:            rawText,

    created_at:          new Date().toISOString(),

  });

  if (error) throw new Error(`pending session ingest insert failed: ${error.message}`);

}



type Row = Record<string, unknown>;



async function loadSession(supabase: AnyClient, sessionKey: string): Promise<PendingSession | null> {

  const { data, error } = await supabase

    .from("pending_sessions")

    .select("*")

    .eq("session_key", sessionKey)

    .maybeSingle();

  if (error) throw new Error(`pending session lookup failed: ${error.message}`);

  return data as PendingSession | null;

}



export async function checkPendingCloseReadyFromTables(

  supabase: AnyClient,

  sessionKey: string,

): Promise<PendingCloseReadiness> {

  const session = await loadSession(supabase, sessionKey);

  if (!session?.close_event_timestamp_ms || !session.close_requested_at) {

    return { ready: false, reason: "not_closing" };

  }



  const closeTs = session.close_event_timestamp_ms;

  const closeRequestedAt = session.close_requested_at;

  const generation = session.session_generation;



  const admissions = ((await supabase

    .from("pending_session_admission")

    .select("line_event_id, line_timestamp_ms, admitted_at")

    .eq("session_key", sessionKey)

    .eq("session_generation", generation)).data ?? []) as Array<{

    line_event_id: string;

    line_timestamp_ms: number;

    admitted_at: string;

  }>;



  const ingests = ((await supabase

    .from("pending_session_ingest")

    .select("line_event_id, line_timestamp_ms, raw_text")

    .eq("session_key", sessionKey)

    .eq("session_generation", generation)).data ?? []) as Array<{

    line_event_id: string;

    line_timestamp_ms: number;

    raw_text: string | null;

  }>;



  const eligibleAdmissions = admissions.filter((a) => a.line_timestamp_ms <= closeTs);

  const eligibleIngests = ingests.filter(

    (i) => i.line_timestamp_ms <= closeTs && i.raw_text?.trim(),

  );

  const ingestedIds = new Set(eligibleIngests.map((i) => i.line_event_id));



  const stragglers = eligibleAdmissions.filter(

    (a) => a.admitted_at > closeRequestedAt && !ingestedIds.has(a.line_event_id),

  );



  const ledgerReady = eligibleAdmissions.length > 0

    && eligibleAdmissions.length === eligibleIngests.length

    && stragglers.length === 0;



  const legacyReady = !ledgerReady

    && eligibleAdmissions.length === 0

    && accumulatedHasLegacyContent(session.accumulated_text);



  const ready = ledgerReady || legacyReady;



  return {

    ready,

    reason: ready

      ? legacyReady ? "legacy_accumulated" : "ready"

      : eligibleAdmissions.length === 0

        ? "no_admissions"

        : stragglers.length > 0

          ? "stragglers"

          : "awaiting_ingest",

    admissionCount: eligibleAdmissions.length,

    ingestCount:    eligibleIngests.length,

    stragglerCount: stragglers.length,

  };

}



export async function claimPendingCloseFinalizeFromTables(

  supabase: AnyClient,

  sessionKey: string,

): Promise<PendingCloseClaim> {

  const readiness = await checkPendingCloseReadyFromTables(supabase, sessionKey);

  const session = await loadSession(supabase, sessionKey);



  if (!session) return { claimed: false, reason: "gone" };

  if (!session.close_event_timestamp_ms || !session.close_requested_at) {

    return { claimed: false, reason: "not_closing" };

  }

  if (session.close_finalize_started_at) {

    return { claimed: false, reason: "already_claimed" };

  }

  if (!readiness.ready) {

    return {

      claimed:        false,

      reason:         readiness.reason ?? "not_ready",

      admissionCount: readiness.admissionCount,

      ingestCount:    readiness.ingestCount,

      stragglerCount: readiness.stragglerCount,

    };

  }



  const claimedAt = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabase

    .from("pending_sessions")

    .update({ close_finalize_started_at: claimedAt })

    .eq("session_key", sessionKey)

    .is("close_finalize_started_at", null)

    .select("*")

    .maybeSingle();



  if (updateErr) throw new Error(`pending session claim failed: ${updateErr.message}`);

  if (!updated) return { claimed: false, reason: "already_claimed" };



  return {

    claimed:        true,

    session:        updated as PendingSession,

    admissionCount: readiness.admissionCount,

    ingestCount:    readiness.ingestCount,

  };

}


