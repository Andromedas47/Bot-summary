-- Migration 0022: atomic get-or-create for slip batches
--
-- Replaces the TypeScript-level SELECT + INSERT pattern with a single
-- serialized database function.  pg_advisory_xact_lock prevents two
-- concurrent webhook requests for the same source/sender from both
-- returning is_new_batch = true and sending duplicate acknowledgements.
--
-- The advisory lock key is derived from source_id + sender_id so only
-- requests that share the same sender are serialized; unrelated senders
-- run fully in parallel.
--
-- The lock is transaction-scoped and released automatically when
-- PostgREST commits the RPC transaction.

CREATE OR REPLACE FUNCTION public.get_or_create_slip_batch(
  p_source_id     text,
  p_source_type   text,
  p_sender_id     text,           -- NULL = room / anonymous source
  p_quiet_seconds integer DEFAULT 20
) RETURNS TABLE(batch_id uuid, is_new_batch boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_id uuid;
  v_is_new   boolean := false;
  v_cutoff   timestamptz;
BEGIN
  -- Serialize concurrent calls that share the same source + sender.
  -- hashtext() is deterministic for a given Postgres instance.
  -- Casting int4 → bigint is safe and matches pg_advisory_xact_lock's signature.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_source_id || '|' || coalesce(p_sender_id, ''))::bigint
  );

  v_cutoff := now() - (p_quiet_seconds || ' seconds')::interval;

  -- Find the most recent collecting batch within the quiet window.
  IF p_sender_id IS NOT NULL THEN
    SELECT id INTO v_batch_id
    FROM   public.slip_batches
    WHERE  source_id     = p_source_id
      AND  sender_id     = p_sender_id
      AND  status        = 'collecting'
      AND  last_image_at >= v_cutoff
    ORDER  BY last_image_at DESC
    LIMIT  1;
  ELSE
    SELECT id INTO v_batch_id
    FROM   public.slip_batches
    WHERE  source_id     = p_source_id
      AND  sender_id     IS NULL
      AND  status        = 'collecting'
      AND  last_image_at >= v_cutoff
    ORDER  BY last_image_at DESC
    LIMIT  1;
  END IF;

  -- No active batch found — create a new one.
  IF v_batch_id IS NULL THEN
    INSERT INTO public.slip_batches (
      source_id, source_type, sender_id,
      status, first_image_at, last_image_at, image_count
    ) VALUES (
      p_source_id, p_source_type, p_sender_id,
      'collecting', now(), now(), 0
    )
    RETURNING id INTO v_batch_id;

    v_is_new := true;
  END IF;

  RETURN QUERY SELECT v_batch_id, v_is_new;
END;
$$;
