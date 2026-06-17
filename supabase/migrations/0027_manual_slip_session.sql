-- Manual slip sessions: a LINE user opens a session for a business date,
-- sends amount lines across one or more messages, then closes it.
-- Phase 1: one session per source_id + business_date, any status (no reopen).

CREATE TABLE public.manual_slip_sessions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id               text        NOT NULL,
  business_date           date        NOT NULL,
  status                  text        NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at               timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  opened_by_line_user_id  text,
  closed_by_line_user_id  text,
  opened_line_message_id  text        UNIQUE,
  closed_line_message_id  text        UNIQUE,
  UNIQUE (source_id, business_date)
);

-- Individual amount lines sent within a manual slip session.
-- sequence_no is insertion order (not the user's item number).
-- UNIQUE(line_message_id, sequence_no) ensures idempotency on webhook re-delivery.

CREATE TABLE public.manual_slip_entries (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid          NOT NULL REFERENCES public.manual_slip_sessions(id),
  sequence_no      int           NOT NULL,
  raw_line         text          NOT NULL,
  amount           numeric(12,2) NOT NULL,
  line_message_id  text          NOT NULL,
  line_user_id     text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (line_message_id, sequence_no)
);

-- One reconciliation record per source_id + business_date, upserted on each dashboard submit.

CREATE TABLE public.transfer_reconciliations (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                 text          NOT NULL,
  business_date             date          NOT NULL,
  ai_verified_total         numeric(12,2) NOT NULL DEFAULT 0,
  manual_slip_total         numeric(12,2) NOT NULL DEFAULT 0,
  checked_slip_total        numeric(12,2) NOT NULL DEFAULT 0,
  submitted_transfer_total  numeric(12,2) NOT NULL DEFAULT 0,
  difference                numeric(12,2) NOT NULL DEFAULT 0,
  matched                   boolean       NOT NULL DEFAULT false,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (source_id, business_date)
);
