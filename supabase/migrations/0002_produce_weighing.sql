-- ─── Produce Weighing Tables ──────────────────────────────────────────────────
-- Records produce-weighing sessions sent via LINE by staff.
-- One session per LINE message; one row per item within that session.

CREATE TABLE produce_sessions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id uuid        NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE,
  line_user_id   text,
  staff_name     text        NOT NULL,
  session_date   date,
  session_title  text,
  total_items    integer     NOT NULL DEFAULT 0,
  parser_errors  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT produce_sessions_raw_message_id_key UNIQUE (raw_message_id)
);

CREATE TABLE produce_items (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid        NOT NULL REFERENCES produce_sessions(id) ON DELETE CASCADE,
  item_number    integer,
  product_name   text        NOT NULL,
  price_per_unit numeric(10,2),
  quantity       numeric(10,3),
  unit           text        CHECK (unit IN ('โล', 'ลูก', 'กล่อง')),
  section        text        NOT NULL DEFAULT 'main',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX produce_sessions_line_user_id_idx ON produce_sessions (line_user_id);
CREATE INDEX produce_sessions_session_date_idx ON produce_sessions (session_date);
CREATE INDEX produce_sessions_staff_name_idx   ON produce_sessions (staff_name);
CREATE INDEX produce_items_session_id_idx      ON produce_items (session_id);
CREATE INDEX produce_items_product_name_idx    ON produce_items (product_name);

-- RLS: anon role gets read-only access (same pattern as other tables)
ALTER TABLE produce_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE produce_items    ENABLE ROW LEVEL SECURITY;

CREATE POLICY anon_read_produce_sessions ON produce_sessions FOR SELECT TO anon USING (true);
CREATE POLICY anon_read_produce_items    ON produce_items    FOR SELECT TO anon USING (true);
