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
    await this.supabase.from("pending_sessions").upsert(
      {
        session_key:        sessionKey,
        accumulated_text:   text,
        latest_reply_token: replyToken,
        line_user_id:       lineUserId,
        updated_at:         new Date().toISOString(),
      },
      { onConflict: "session_key" },
    );
  }

  async append(
    sessionKey:  string,
    newText:     string,
    replyToken:  string | null,
  ): Promise<PendingSession> {
    const { data: current } = await this.supabase
      .from("pending_sessions")
      .select("accumulated_text")
      .eq("session_key", sessionKey)
      .single();

    const combined = current
      ? `${(current as { accumulated_text: string }).accumulated_text}\n${newText}`
      : newText;

    const { data, error } = await this.supabase
      .from("pending_sessions")
      .update({
        accumulated_text:   combined,
        latest_reply_token: replyToken,
        updated_at:         new Date().toISOString(),
      })
      .eq("session_key", sessionKey)
      .select()
      .single();

    if (error) throw new Error(`pending session append failed: ${error.message}`);
    return data as PendingSession;
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
