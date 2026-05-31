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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export class PendingSessionService {
  constructor(private readonly supabase: AnyClient) {}

  async get(sessionKey: string): Promise<PendingSession | null> {
    const { data } = await this.supabase
      .from("pending_sessions")
      .select("*")
      .eq("session_key", sessionKey)
      .maybeSingle();
    return (data as PendingSession) ?? null;
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
    const { data, error } = await (this.supabase as any).rpc("append_pending_session", {
      p_session_key:  sessionKey,
      p_new_text:     newText,
      p_reply_token:  replyToken,
    });
    if (error) throw new Error(`pending session append failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error(`pending session not found for append: ${sessionKey}`);
    return row as PendingSession;
  }

  async delete(sessionKey: string): Promise<void> {
    await this.supabase
      .from("pending_sessions")
      .delete()
      .eq("session_key", sessionKey);
  }

  isExpired(session: PendingSession): boolean {
    return Date.now() - new Date(session.updated_at).getTime() > TIMEOUT_MS;
  }
}
