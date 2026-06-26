import type { SupabaseClient } from "@supabase/supabase-js";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface PendingSession {
  id:                  string;
  session_key:         string;
  accumulated_text:    string;
  latest_reply_token:  string | null;
  line_user_id:        string | null;
  created_at:          string;
  updated_at:          string;
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
    text:        string,
    replyToken:  string | null,
    lineUserId:  string | null,
  ): Promise<void> {
    const { error } = await this.supabase.from("pending_sessions").upsert(
      {
        session_key:        sessionKey,
        accumulated_text:   text,
        latest_reply_token: replyToken,
        line_user_id:       lineUserId,
        updated_at:         new Date().toISOString(),
      },
      { onConflict: "session_key" },
    );
    if (error) throw new Error(`pending session create failed: ${error.message}`);
  }

  async append(
    sessionKey:  string,
    newText:     string,
    replyToken:  string | null,
  ): Promise<PendingSession> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpc = (this.supabase as any).rpc?.bind(this.supabase);
    if (!rpc) {
      throw new Error("pending session append failed: append_pending_session RPC unavailable");
    }

    const { data, error } = await rpc("append_pending_session", {
      p_session_key:  sessionKey,
      p_new_text:     newText,
      p_reply_token:  replyToken,
    });
    if (error) {
      throw new Error(`pending session append failed: ${error.message}`);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error(`pending session not found after append: ${sessionKey}`);
    return row as PendingSession;
  }

  async delete(sessionKey: string): Promise<void> {
    const { error } = await this.supabase
      .from("pending_sessions")
      .delete()
      .eq("session_key", sessionKey);
    if (error) throw new Error(`pending session delete failed: ${error.message}`);
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
