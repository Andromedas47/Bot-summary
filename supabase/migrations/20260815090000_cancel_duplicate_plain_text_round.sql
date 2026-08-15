-- Duplicate finalization must not leave an empty open accountability round.
--
-- A plain-text withdrawal binds its round BEFORE finalization: the seller,
-- market and business date only exist once the document is parsed, and P4A
-- needs the round to validate against. When the finalizer then classifies the
-- document as an exact business duplicate, nothing is persisted — but the round
-- minted for that attempt stays open forever.
--
-- Production 2026-08-14, จิ๋ว — ราชพฤก: round fb919686 holds the real
-- withdrawal/return/damaged return, and round bfb2ea7b sits open with 0
-- sessions and 0 transactions because the pending session that created it was
-- classified duplicate. The existing retry cleanup inside
-- bind_plain_text_accountability_round could not reach it: that cleanup is
-- creator-scoped, and the duplicate attempt came from a different LINE user.
--
-- This function is deliberately narrow. It cancels ONE round, identified by the
-- creation key of the exact pending generation that minted it, and only when
-- that round demonstrably holds nothing:
--
--   * no produce_sessions reference it
--   * no produce_transactions reference it
--   * no pending_sessions other than the duplicate generation reference it
--
-- Any of those present and it refuses. A round containing legitimate business
-- data is never cancelled, and a round created by some other flow (the guided
-- menu, another generation) is never even looked at.
--
-- Forward-only. No historical row is rewritten, no produce data is touched.

CREATE OR REPLACE FUNCTION public.cancel_duplicate_plain_text_round(
  p_session_key        text,
  p_session_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_round        public.accountability_rounds%ROWTYPE;
  v_creation_key text :=
    'plaintext:' || btrim(p_session_key) || ':' || p_session_generation::text;
BEGIN
  IF p_session_key IS NULL OR btrim(p_session_key) = '' OR p_session_generation IS NULL THEN
    RAISE EXCEPTION 'P4A: invalid duplicate round cancellation identity';
  END IF;

  SELECT * INTO v_round
  FROM public.accountability_rounds
  WHERE created_line_event_id = v_creation_key
  FOR UPDATE;

  IF NOT FOUND THEN
    -- The generation never minted a round (a continuation, or a guided round).
    RETURN jsonb_build_object('outcome', 'no_round');
  END IF;

  IF v_round.status <> 'open' THEN
    RETURN jsonb_build_object(
      'outcome', 'not_open',
      'accountability_round_id', v_round.id,
      'status', v_round.status
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.produce_sessions s
    WHERE s.accountability_round_id = v_round.id
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'has_produce_sessions',
      'accountability_round_id', v_round.id
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.produce_transactions t
    WHERE t.accountability_round_id = v_round.id
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'has_transactions',
      'accountability_round_id', v_round.id
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pending_sessions p
    WHERE p.accountability_round_id = v_round.id
      AND NOT (p.session_key = p_session_key
               AND p.session_generation = p_session_generation)
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'shared_with_other_generation',
      'accountability_round_id', v_round.id
    );
  END IF;

  UPDATE public.accountability_rounds
  SET status = 'cancelled',
      closed_at = now(),
      closed_line_event_id = v_creation_key || ':duplicate'
  WHERE id = v_round.id;

  RETURN jsonb_build_object(
    'outcome', 'cancelled',
    'accountability_round_id', v_round.id
  );
END;
$$;

COMMENT ON FUNCTION public.cancel_duplicate_plain_text_round(text, uuid) IS
  'Cancels the empty accountability round a duplicate plain-text generation minted. '
  'Refuses whenever the round holds produce sessions, produce transactions, or any '
  'other pending generation. Never touches a round it did not mint.';

REVOKE ALL ON FUNCTION public.cancel_duplicate_plain_text_round(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_duplicate_plain_text_round(text, uuid)
  TO service_role;
