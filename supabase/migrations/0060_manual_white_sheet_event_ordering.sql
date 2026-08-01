-- Durable per-source ordering for concurrent LINE webhook requests.
--
-- raw_messages remains the idempotency/audit ledger. This queue is the
-- ordered processing ledger: receive_order is allocated when the event is
-- persisted, so workers never use request start time or LINE event IDs for
-- ordering. Gaps are harmless (duplicates and failed inserts can consume no
-- queue row); a failed event explicitly unblocks later events.

CREATE SEQUENCE public.line_webhook_receive_order_seq AS bigint;

CREATE TABLE public.line_webhook_event_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_event_id   text NOT NULL UNIQUE,
  source_id       text NOT NULL,
  raw_message_id  uuid NOT NULL UNIQUE REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  receive_order   bigint NOT NULL DEFAULT nextval('public.line_webhook_receive_order_seq'),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  error_message   text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  processing_attempts   integer NOT NULL DEFAULT 0
                        CHECK (processing_attempts >= 0),
  completed_at    timestamptz,
  CONSTRAINT line_webhook_event_queue_source_nonblank CHECK (btrim(source_id) <> ''),
  CONSTRAINT line_webhook_event_queue_order_positive CHECK (receive_order > 0),
  CONSTRAINT line_webhook_event_queue_processing_lease CHECK (
    status <> 'processing'
    OR (processing_started_at IS NOT NULL AND processing_attempts > 0)
  ),
  CONSTRAINT line_webhook_event_queue_terminal_error CHECK (
    status <> 'failed' OR (error_message IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX line_webhook_event_queue_source_order_idx
  ON public.line_webhook_event_queue (source_id, receive_order);

-- Persist the raw event and its ordering row in one transaction. Retrying an
-- already inserted raw event repairs a missing queue row instead of dropping it.
CREATE OR REPLACE FUNCTION public.receive_line_webhook_event(
  p_line_event_id text,
  p_destination text,
  p_event_type text,
  p_source_type text,
  p_source_id text,
  p_user_id text,
  p_message_id text,
  p_message_type text,
  p_raw_text text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_raw_id uuid;
  v_inserted boolean;
BEGIN
  WITH inserted AS (
    INSERT INTO public.raw_messages (
      line_event_id, destination, event_type, source_type, source_id,
      user_id, message_id, message_type, raw_text, payload
    ) VALUES (
      p_line_event_id, p_destination, p_event_type::public.line_event_type,
      p_source_type::public.line_source_type, p_source_id, p_user_id,
      p_message_id, NULLIF(p_message_type, '')::public.line_message_type,
      p_raw_text, p_payload
    )
    ON CONFLICT (line_event_id) DO NOTHING
    RETURNING id
  )
  SELECT id, true INTO v_raw_id, v_inserted FROM inserted
  UNION ALL
  SELECT id, false FROM public.raw_messages
   WHERE line_event_id = p_line_event_id
  LIMIT 1;

  INSERT INTO public.line_webhook_event_queue(line_event_id, source_id, raw_message_id)
  VALUES (p_line_event_id, p_source_id, v_raw_id)
  ON CONFLICT (line_event_id) DO NOTHING;

  RETURN jsonb_build_object('raw_message_id', v_raw_id, 'duplicate', NOT v_inserted);
END;
$fn$;

ALTER TABLE public.line_webhook_event_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.line_webhook_event_queue FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_webhook_event_queue TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.line_webhook_receive_order_seq TO service_role;

-- Claim only the earliest pending event whose earlier events are terminal.
-- A crashed worker's processing row becomes claimable again after a fixed
-- five-minute database-time lease; a fresh processing row remains the barrier.
-- FOR UPDATE SKIP LOCKED lets different LINE sources run concurrently while
-- the NOT EXISTS barrier prevents a close from overtaking pending/processing
-- fields for the same source.
CREATE OR REPLACE FUNCTION public.claim_line_webhook_event(
  p_source_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.line_webhook_event_queue;
BEGIN
  SELECT q.* INTO v_row
    FROM public.line_webhook_event_queue q
   WHERE q.source_id = p_source_id
     AND (
       q.status = 'pending'
       OR (
         q.status = 'processing'
         AND q.processing_started_at <= now() - interval '5 minutes'
       )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.line_webhook_event_queue earlier
        WHERE earlier.source_id = q.source_id
          AND earlier.receive_order < q.receive_order
          AND earlier.status IN ('pending', 'processing')
     )
   ORDER BY q.receive_order
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.line_webhook_event_queue
     SET status = 'processing',
         processing_started_at = now(),
         processing_attempts = processing_attempts + 1
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'queue_id', v_row.id,
    'line_event_id', v_row.line_event_id,
    'source_id', v_row.source_id,
    'raw_message_id', v_row.raw_message_id,
    'receive_order', v_row.receive_order
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.complete_line_webhook_event(
  p_raw_message_id uuid,
  p_status         text,
  p_error_message  text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_status NOT IN ('processed', 'failed') THEN
    RAISE EXCEPTION '0060: invalid terminal queue status %', p_status;
  END IF;

  UPDATE public.line_webhook_event_queue
     SET status = p_status,
         error_message = CASE WHEN p_status = 'failed' THEN COALESCE(NULLIF(btrim(p_error_message), ''), 'event processing failed') ELSE NULL END,
         completed_at = now()
   WHERE raw_message_id = p_raw_message_id
     AND status = 'processing';

  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_line_webhook_event(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_line_webhook_event(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receive_line_webhook_event(text, text, text, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_line_webhook_event(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_line_webhook_event(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.receive_line_webhook_event(text, text, text, text, text, text, text, text, text, jsonb) TO service_role;
