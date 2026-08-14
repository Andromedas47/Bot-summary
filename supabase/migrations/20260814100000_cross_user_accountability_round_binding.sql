-- A produce accountability round belongs to its business identity, not to the
-- LINE user who created it. Keep the creator for audit, but let another actor
-- in the same source continue the unique open withdrawal round.

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

  -- Replays trust the pending generation's explicit round, but continuations
  -- no longer require that round's creator to be the current LINE actor.
  IF v_pending.accountability_round_id IS NOT NULL THEN
    SELECT * INTO v_round
    FROM public.accountability_rounds
    WHERE id = v_pending.accountability_round_id
    FOR UPDATE;
    IF FOUND
       AND v_round.status = 'open'
       AND v_round.source_type = p_source_type
       AND v_round.source_id = btrim(p_source_id)
       AND v_round.business_date = p_business_date
       AND public.accountability_round_normalize(v_round.seller_label) = v_seller
       AND (
         (p_is_new_round
          AND v_round.owner_line_user_id = btrim(p_line_user_id)
          AND v_round.created_line_event_id = v_creation_key)
         OR
         (NOT p_is_new_round AND EXISTS (
           SELECT 1
           FROM public.produce_transactions t
           WHERE t.accountability_round_id = v_round.id
             AND t.base_transaction_type = 'เบิก'
         ))
       )
    THEN
      IF public.accountability_round_same_market(v_round.market_label_normalized, v_market) THEN
        RETURN jsonb_build_object(
          'outcome', 'already_bound',
          'accountability_round_id', v_round.id,
          'market_label', v_round.market_label
        );
      END IF;
      IF NOT p_is_new_round THEN
        RETURN jsonb_build_object(
          'outcome', 'market_mismatch',
          'accountability_round_id', v_round.id,
          'market_label', v_round.market_label
        );
      END IF;
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
    -- Discovery is business-scoped and accepts only rounds with an active
    -- withdrawal master. Creator identity is deliberately absent.
    SELECT array_agg(r.id ORDER BY r.id) INTO v_candidates
    FROM public.accountability_rounds r
    WHERE r.status = 'open'
      AND r.source_type = p_source_type
      AND r.source_id = btrim(p_source_id)
      AND r.business_date = p_business_date
      AND public.accountability_round_normalize(r.seller_label) = v_seller
      AND public.accountability_round_same_market(r.market_label_normalized, v_market)
      AND EXISTS (
        SELECT 1
        FROM public.produce_transactions t
        WHERE t.accountability_round_id = r.id
          AND t.base_transaction_type = 'เบิก'
      );

    IF v_candidates IS NULL OR array_length(v_candidates, 1) IS NULL THEN
      -- Preserve the existing actionable market-mismatch result only when one
      -- other valid withdrawal round exists for this source/seller/day.
      SELECT array_agg(r.id ORDER BY r.id) INTO v_candidates
      FROM public.accountability_rounds r
      WHERE r.status = 'open'
        AND r.source_type = p_source_type
        AND r.source_id = btrim(p_source_id)
        AND r.business_date = p_business_date
        AND public.accountability_round_normalize(r.seller_label) = v_seller
        AND EXISTS (
          SELECT 1
          FROM public.produce_transactions t
          WHERE t.accountability_round_id = r.id
            AND t.base_transaction_type = 'เบิก'
        );

      IF array_length(v_candidates, 1) = 1 THEN
        SELECT * INTO v_round
        FROM public.accountability_rounds
        WHERE id = v_candidates[1];
        RETURN jsonb_build_object(
          'outcome', 'market_mismatch',
          'accountability_round_id', v_round.id,
          'market_label', v_round.market_label
        );
      END IF;
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

  -- Existing retry cleanup remains creator-scoped. It never retires another
  -- operator's round and never changes round ownership.
  IF p_is_new_round THEN
    UPDATE public.accountability_rounds o
    SET status = 'cancelled',
        closed_at = now(),
        closed_line_event_id = v_creation_key
    WHERE o.status = 'open'
      AND o.id <> v_round_id
      AND o.source_type = p_source_type
      AND o.source_id = btrim(p_source_id)
      AND o.owner_line_user_id = btrim(p_line_user_id)
      AND o.business_date = p_business_date
      AND public.accountability_round_normalize(o.seller_label) = v_seller
      AND public.accountability_round_same_market(o.market_label_normalized, v_market)
      AND starts_with(
            o.created_line_event_id,
            'plaintext:' || btrim(p_session_key) || ':'
          )
      AND o.created_line_event_id <> v_creation_key
      AND NOT EXISTS (
        SELECT 1 FROM public.produce_sessions s
        WHERE s.accountability_round_id = o.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.pending_sessions p
        WHERE p.accountability_round_id = o.id
      );
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'bound',
    'accountability_round_id', v_round_id,
    'market_label', (
      SELECT market_label FROM public.accountability_rounds WHERE id = v_round_id
    )
  );
END;
$$;

COMMENT ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) IS
  'Binds a plain-text pending generation by source, business date, seller and reviewed market identity. '
  'The original LINE owner remains audit metadata; continuation actors may differ. '
  'Zero candidates return no_round and multiple candidates return ambiguous.';

REVOKE ALL ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) TO service_role;
