-- Atomic concatenation for pending_sessions to prevent the read-modify-write
-- race condition in append() when two messages arrive for the same session_key
-- within the same millisecond window.
CREATE OR REPLACE FUNCTION append_pending_session(
  p_session_key  TEXT,
  p_new_text     TEXT,
  p_reply_token  TEXT
)
RETURNS SETOF pending_sessions
LANGUAGE sql
AS $$
  UPDATE pending_sessions
  SET
    accumulated_text   = accumulated_text || E'\n' || p_new_text,
    latest_reply_token = p_reply_token,
    updated_at         = now()
  WHERE session_key = p_session_key
  RETURNING *;
$$;
