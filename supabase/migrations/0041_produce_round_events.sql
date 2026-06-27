-- P2a: immutable produce-round event store.
-- Each physical line of a produce-session LINE message becomes exactly one row.
-- Rows are append-only; updates and deletes are rejected by trigger.
-- Ordering contract: line_timestamp_ms → seq_in_message → line_event_id (never created_at).

CREATE TYPE public.produce_round_event_kind AS ENUM (
  'header', 'date', 'item', 'quantity', 'close_marker', 'unparsed'
);

CREATE TYPE public.produce_round_event_status AS ENUM (
  'parsed', 'needs_review'
);

CREATE TABLE public.produce_round_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id    uuid        NOT NULL REFERENCES public.raw_messages(id),
  line_event_id     text        NOT NULL,
  seq_in_message    integer     NOT NULL CHECK (seq_in_message >= 0),
  line_timestamp_ms bigint      NOT NULL,
  event_kind        public.produce_round_event_kind   NOT NULL,
  event_status      public.produce_round_event_status NOT NULL DEFAULT 'parsed',
  raw_line          text        NOT NULL,
  normalized_line   text        NOT NULL,
  -- txIntent for header events; NULL for all other kinds.
  category          text,
  parsed_payload    jsonb       NOT NULL DEFAULT '{}',
  work_round_id     uuid        REFERENCES public.work_rounds(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- one event per physical line per message
CREATE UNIQUE INDEX produce_round_events_message_seq_key
  ON public.produce_round_events (raw_message_id, seq_in_message);

-- idempotent LINE re-delivery guard
CREATE UNIQUE INDEX produce_round_events_event_seq_key
  ON public.produce_round_events (line_event_id, seq_in_message);

-- deterministic read ordering index
CREATE INDEX produce_round_events_order_idx
  ON public.produce_round_events (line_timestamp_ms ASC, seq_in_message ASC, line_event_id ASC);

-- ── Immutability trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.produce_round_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'produce_round_events rows are immutable (% on id=%)', TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER produce_round_events_no_update
  BEFORE UPDATE OR DELETE ON public.produce_round_events
  FOR EACH ROW EXECUTE FUNCTION public.produce_round_events_immutable();

-- ── Row-level security ────────────────────────────────────────────────────────

ALTER TABLE public.produce_round_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY anon_read_produce_round_events
  ON public.produce_round_events FOR SELECT TO anon USING (true);

-- ── Idempotent bulk insert RPC ────────────────────────────────────────────────
-- Uses ON CONFLICT DO NOTHING with no conflict target so both unique indexes
-- (raw_message_id, seq_in_message) and (line_event_id, seq_in_message) are honored.
-- Never updates existing rows; immutable trigger remains the only update guard.

CREATE OR REPLACE FUNCTION public.insert_produce_round_events_ignore(events jsonb)
RETURNS SETOF public.produce_round_events
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.produce_round_events (
    raw_message_id,
    line_event_id,
    seq_in_message,
    line_timestamp_ms,
    event_kind,
    event_status,
    raw_line,
    normalized_line,
    category,
    parsed_payload,
    work_round_id
  )
  SELECT
    (e->>'raw_message_id')::uuid,
    e->>'line_event_id',
    (e->>'seq_in_message')::integer,
    (e->>'line_timestamp_ms')::bigint,
    (e->>'event_kind')::public.produce_round_event_kind,
    COALESCE(
      (e->>'event_status')::public.produce_round_event_status,
      'parsed'::public.produce_round_event_status
    ),
    e->>'raw_line',
    e->>'normalized_line',
    NULLIF(e->>'category', ''),
    COALESCE(e->'parsed_payload', '{}'::jsonb),
    NULLIF(e->>'work_round_id', '')::uuid
  FROM jsonb_array_elements(events) AS e
  ON CONFLICT DO NOTHING
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.insert_produce_round_events_ignore(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_produce_round_events_ignore(jsonb) TO service_role;
