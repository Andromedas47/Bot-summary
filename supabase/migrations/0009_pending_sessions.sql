-- Accumulates multi-message LINE sessions until a SESSION_END marker is received.
-- session_key = groupId (group chats) or userId (DMs).
-- Rows are deleted after successful finalization or on timeout reset (30 min).

CREATE TABLE pending_sessions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key         text        NOT NULL UNIQUE,
  accumulated_text    text        NOT NULL DEFAULT '',
  latest_reply_token  text,
  line_user_id        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_sessions_updated_at_idx ON pending_sessions (updated_at);

ALTER TABLE pending_sessions ENABLE ROW LEVEL SECURITY;
