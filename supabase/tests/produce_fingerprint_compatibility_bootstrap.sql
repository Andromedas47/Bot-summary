-- Minimal schema for exercising try_finalize_pending_generation in isolation.
--
-- The function is self-contained: it reads and writes only the tables below and
-- calls no other function. Every column here is one the function actually
-- touches, so a drift in the real schema shows up as a psql error rather than
-- as a silently different code path.
--
-- Disposable test databases only. Never run against Production.

CREATE TABLE public.pending_sessions (
  session_key                    text PRIMARY KEY,
  session_generation             uuid NOT NULL,
  line_user_id                   text,
  ingest_revision                integer NOT NULL DEFAULT 0,
  expected_item_count            integer,
  terminalized                   boolean NOT NULL DEFAULT false,
  next_attempt_at                timestamptz DEFAULT now(),
  close_event_timestamp_ms       bigint,
  close_requested_at             timestamptz,
  close_deadline_at              timestamptz,
  close_session_generation       uuid,
  finalize_hold_until            timestamptz,
  finalize_confirmed_at          timestamptz,
  entry_origin                   text,
  finalization_started_at        timestamptz,
  finalized_at                   timestamptz,
  finalization_status            text,
  finalization_error             jsonb,
  finalized_produce_session_id   uuid
  -- runtime_environment is added by migration 0061, applied on top of this.
);

CREATE TABLE public.imported_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash     text NOT NULL UNIQUE,
  transaction_date date,
  staff_name       text NOT NULL DEFAULT '',
  market_name      text NOT NULL DEFAULT '',
  transaction_type text NOT NULL DEFAULT '',
  raw_text         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.raw_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_processed boolean NOT NULL DEFAULT false,
  processed_at timestamptz
);

CREATE TABLE public.produce_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id            uuid,
  line_user_id              text,
  staff_name                text,
  sender_name               text,
  transaction_time          text,
  session_date              date,
  session_title             text,
  total_items               integer,
  parser_errors             jsonb,
  finalization_started_at   timestamptz,
  finalized_at              timestamptz,
  session_kind              text,
  declared_transaction_type text,
  ingest_idempotency_key    text UNIQUE,
  ingest_source             text
);

CREATE TABLE public.produce_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES public.produce_sessions(id),
  item_number      integer,
  product_name     text,
  price_per_unit   numeric,
  quantity         numeric,
  unit             text,
  section          text,
  transaction_type text,
  item_hash        text,
  basis_quantity   numeric,
  basis_unit       text,
  basis_price      numeric
);

-- Columns beyond the finalizer's own INSERT exist because 0061 also reissues
-- claim_due_produce_notifications over this table.
CREATE TABLE public.produce_session_notifications (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produce_session_id                uuid NOT NULL REFERENCES public.produce_sessions(id),
  session_key                       text,
  session_generation                uuid,
  source_id                         text,
  correlation_id                    text,
  notification_payload              text,
  notification_status               text NOT NULL DEFAULT 'pending',
  notification_retryable            boolean NOT NULL DEFAULT true,
  notification_attempt_count        integer NOT NULL DEFAULT 0,
  notification_cycle_attempt_count  integer NOT NULL DEFAULT 0,
  next_notification_attempt_at      timestamptz NOT NULL DEFAULT now(),
  last_notification_attempt_at      timestamptz,
  sending_started_at                timestamptz,
  updated_at                        timestamptz NOT NULL DEFAULT now()
  -- runtime_environment is added by migration 0061.
);

CREATE TABLE public.produce_notification_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.produce_session_notifications(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
