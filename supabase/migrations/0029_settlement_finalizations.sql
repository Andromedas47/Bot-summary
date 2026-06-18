-- Idempotency/state-machine table for the combined settlement finalizer.
-- One row per (source_id, business_date); status drives the lifecycle.
-- line_retry_key is set once on INSERT and reused on every retry so LINE's
-- X-Line-Retry-Key deduplicates delivery even when the DB update fails.

CREATE TABLE public.settlement_finalizations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       text        NOT NULL,
  business_date   date        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous')),
  line_retry_key  uuid        NOT NULL DEFAULT gen_random_uuid(),
  finalized_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  message_sent_at timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, business_date)
);
