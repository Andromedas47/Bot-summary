-- P4A completion: let a plain-text produce session join a P2E accountability
-- round.
--
-- Additive only. One SECURITY DEFINER RPC, no new table, no new column, no
-- backfill. `accountability_rounds` stays the single owner of round identity
-- and `pending_sessions.accountability_round_id` stays the durable binding, so
-- `propagate_produce_session_accountability_round` (P2E) still carries the UUID
-- onto the finalized produce session with no change of its own.
--
-- The guided flow keeps using open_accountability_round_produce_session: that
-- RPC OPENS the pending session itself, so it cannot be pointed at a plain-text
-- row that already exists. This function is its counterpart for a row that is
-- already there — same table, same normalization, same identity checks, same
-- "initial withdrawal creates, everything else resolves" rule.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.accountability_rounds') IS NULL THEN
    RAISE EXCEPTION 'P4A: accountability_rounds is missing (P2E is not applied)';
  END IF;
  IF to_regprocedure('public.accountability_round_normalize(text)') IS NULL THEN
    RAISE EXCEPTION 'P4A: accountability_round_normalize is missing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.bind_plain_text_accountability_round(
  p_session_key             text,
  p_session_generation      uuid,
  p_source_type             text,
  p_source_id               text,
  p_line_user_id            text,
  p_business_date           date,
  p_seller_label            text,
  p_market_label            text,
  p_market_label_normalized text,
  p_is_new_round            boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_pending    public.pending_sessions%ROWTYPE;
  v_round      public.accountability_rounds%ROWTYPE;
  v_candidates uuid[];
  v_round_id   uuid;
  v_seller     text := public.accountability_round_normalize(p_seller_label);
  v_market     text := public.accountability_round_normalize(p_market_label_normalized);
  -- Creation is idempotent per pending GENERATION, not per LINE event: closing
  -- twice after a P4A block must reuse one round, while a genuinely new
  -- generation (a second withdrawal) must mint a new one. created_line_event_id
  -- is already UNIQUE, so it carries that key. The value is a namespaced
  -- synthetic key and never claims to be a real LINE event id.
  v_creation_key text :=
    'plaintext:' || btrim(p_session_key) || ':' || p_session_generation::text;
BEGIN
  IF p_session_key IS NULL OR btrim(p_session_key) = ''
     OR p_session_generation IS NULL
     OR p_source_type NOT IN ('user', 'group', 'room')
     OR p_source_id IS NULL OR btrim(p_source_id) = ''
     OR p_line_user_id IS NULL OR btrim(p_line_user_id) = ''
     OR p_business_date IS NULL
     OR v_seller = '' OR v_market = '' THEN
    RAISE EXCEPTION 'P4A: invalid plain-text round binding identity';
  END IF;

  -- Serializes concurrent binds for the same generation, and is the only
  -- statement that decides this generation is ours to bind.
  SELECT * INTO v_pending
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_pending.source_id IS DISTINCT FROM btrim(p_source_id)
     OR v_pending.line_user_id IS DISTINCT FROM btrim(p_line_user_id) THEN
    RETURN jsonb_build_object('outcome', 'identity_mismatch');
  END IF;

  -- Trust 1: the binding this row already carries. It survives create() and
  -- replaceGeneration() because neither writer touches the column, which is
  -- what lets a return inherit its own withdrawal's round without any
  -- descriptive lookup at all.
  IF v_pending.accountability_round_id IS NOT NULL THEN
    SELECT * INTO v_round
    FROM public.accountability_rounds
    WHERE id = v_pending.accountability_round_id
    FOR UPDATE;
    IF FOUND
       AND v_round.status = 'open'
       AND v_round.source_type = p_source_type
       AND v_round.source_id = btrim(p_source_id)
       AND v_round.owner_line_user_id = btrim(p_line_user_id)
       AND v_round.business_date = p_business_date
       AND public.accountability_round_normalize(v_round.seller_label) = v_seller
       AND v_round.market_label_normalized = v_market
       -- A new withdrawal may only reuse the round IT created. Anything else
       -- carried over from the previous generation is a different economic
       -- cycle and must not absorb this one.
       AND (NOT p_is_new_round OR v_round.created_line_event_id = v_creation_key)
    THEN
      RETURN jsonb_build_object(
        'outcome', 'already_bound',
        'accountability_round_id', v_round.id
      );
    END IF;
  END IF;

  IF p_is_new_round THEN
    INSERT INTO public.accountability_rounds (
      source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized,
      created_line_event_id
    ) VALUES (
      p_source_type, btrim(p_source_id), btrim(p_line_user_id), p_business_date,
      v_seller, public.accountability_round_normalize(p_market_label), v_market,
      v_creation_key
    )
    ON CONFLICT (created_line_event_id) DO NOTHING;

    SELECT * INTO v_round
    FROM public.accountability_rounds
    WHERE created_line_event_id = v_creation_key
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'P4A: plain-text round creation key % did not resolve', v_creation_key;
    END IF;
    IF v_round.source_type IS DISTINCT FROM p_source_type
       OR v_round.source_id IS DISTINCT FROM btrim(p_source_id)
       OR v_round.owner_line_user_id IS DISTINCT FROM btrim(p_line_user_id)
       OR v_round.business_date IS DISTINCT FROM p_business_date
       OR public.accountability_round_normalize(v_round.seller_label) IS DISTINCT FROM v_seller
       OR v_round.market_label_normalized IS DISTINCT FROM v_market THEN
      RAISE EXCEPTION 'P4A: plain-text round creation key was reused with different attributes';
    END IF;
    IF v_round.status <> 'open' THEN
      RAISE EXCEPTION 'P4A: plain-text round creation key belongs to a terminal round';
    END IF;
    v_round_id := v_round.id;
  ELSE
    -- Trust 2: discovery. Descriptive fields select a candidate; they never
    -- become the identity. Exactly one candidate, or nothing happens.
    SELECT array_agg(id) INTO v_candidates
    FROM public.accountability_rounds
    WHERE status = 'open'
      AND source_type = p_source_type
      AND source_id = btrim(p_source_id)
      AND owner_line_user_id = btrim(p_line_user_id)
      AND business_date = p_business_date
      AND public.accountability_round_normalize(seller_label) = v_seller
      AND market_label_normalized = v_market;

    IF v_candidates IS NULL OR array_length(v_candidates, 1) IS NULL THEN
      RETURN jsonb_build_object('outcome', 'no_round');
    END IF;
    IF array_length(v_candidates, 1) > 1 THEN
      RETURN jsonb_build_object('outcome', 'ambiguous');
    END IF;
    v_round_id := v_candidates[1];
    PERFORM 1 FROM public.accountability_rounds WHERE id = v_round_id FOR UPDATE;
  END IF;

  UPDATE public.pending_sessions
  SET accountability_round_id = v_round_id
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P4A: plain-text pending generation could not be bound';
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'bound',
    'accountability_round_id', v_round_id
  );
END;
$$;

COMMENT ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) IS
  'Binds one plain-text pending generation to a P2E accountability round. A main '
  'withdrawal creates one (idempotent per generation); every other document kind '
  'resolves an existing open round and fails closed on zero or multiple candidates.';

REVOKE ALL ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) TO service_role;

COMMIT;
