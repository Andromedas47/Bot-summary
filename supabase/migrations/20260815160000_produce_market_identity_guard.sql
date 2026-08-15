-- Market identity guard: a spelling variant must not mint a second business
-- identity, and an UNREVIEWED variant must not silently mint one either.
--
-- Production evidence, business date 2026-08-14, seller ต้อม, group
-- C98f83da381b20df2829b660845d9b271:
--
--   round 4aa36324-79a1-4ee3-9161-e64b86d81632  market พาซิโอ้  (78 เบิก, 41 คืน, 9 คืนเสีย)
--   round c476e8e7-537b-4c2e-b790-966c6c3d0d70  market พาซีโอ้  (66 เบิก)
--
-- One real market, two accountability rounds, because `พาซิโอ้` is not in the
-- reviewed catalog at all and `พาซีโอ้` therefore could not resolve to it.
-- `accountability_round_same_market` was already catalog-aware (migration
-- 20260811090000) and already correct — it simply had nothing to look up.
--
-- Two changes, both additive:
--
--   1. Reviewed catalog rows. `พาซิโอ้` becomes a canonical market and the two
--      confirmed spellings become its aliases. Insert-if-missing with a drift
--      assertion, exactly as 0055 seeds the rest of the catalog. No seller
--      assignment is created, so the Guided Menu's seller→market navigation is
--      unchanged; the row exists so market IDENTITY can be resolved.
--
--   2. A near-match guard on round CREATION. Discovery already answers
--      `market_mismatch` for a return whose market does not match. Creation had
--      no such check: a withdrawal always minted a round, so the first typo of a
--      market name silently became a second business identity. Now a withdrawal
--      whose market is one character away from an existing open withdrawal round
--      of the same group/date/seller fails closed and NAMES that round's market.
--
-- The guard suggests. It never merges. Two markets the reviewed catalog knows
-- and keeps apart (ต้อม genuinely runs พาซิโอ้ผัก, พาซิโอ้ผลไม้ and
-- พาซิโอ้ทุเรียน in one group) are a decided question and are never guarded.
--
-- Nothing here weakens PR #52: no deferred event, stream lock, finalization
-- barrier or line_event_id identity is touched. Market normalization stays in
-- the business identity layer.
--
-- Forward-only. No historical round is rewritten, merged, cancelled or voided.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.bind_plain_text_accountability_round(text,uuid,text,text,text,date,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'P4A plain-text round binding is missing';
  END IF;
  IF to_regprocedure('public.accountability_round_same_market(text,text)') IS NULL
     OR to_regprocedure('public.accountability_round_market_code(text)') IS NULL THEN
    RAISE EXCEPTION 'reviewed market identity functions are missing (migration 20260811090000 is not applied)';
  END IF;
  IF to_regclass('public.line_guided_menu_markets') IS NULL
     OR to_regclass('public.line_guided_menu_market_aliases') IS NULL THEN
    RAISE EXCEPTION 'guided menu market catalog is missing (migration 0055 is not applied)';
  END IF;
END;
$preflight$;

-- ── 1. Reviewed catalog rows ────────────────────────────────────────────────

INSERT INTO public.line_guided_menu_markets (market_code, label, active)
VALUES ('paseo', 'พาซิโอ้', true)
ON CONFLICT (market_code) DO NOTHING;

INSERT INTO public.line_guided_menu_market_aliases (alias_label, market_code, active)
VALUES
  ('พาซีโอ้', 'paseo', true),
  ('พาสิโอ้', 'paseo', true)
ON CONFLICT (alias_label) DO NOTHING;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.line_guided_menu_markets
    WHERE market_code = 'paseo' AND label = 'พาซิโอ้' AND active IS TRUE
  ) THEN
    RAISE EXCEPTION 'reviewed market paseo/พาซิโอ้ differs from the reviewed baseline';
  END IF;

  IF (
    SELECT count(*) FROM public.line_guided_menu_market_aliases
    WHERE alias_label IN ('พาซีโอ้', 'พาสิโอ้')
      AND market_code = 'paseo'
      AND active IS TRUE
  ) <> 2 THEN
    RAISE EXCEPTION 'reviewed พาซิโอ้ market aliases differ from the reviewed baseline';
  END IF;

  -- The 0055 alias this phase must not disturb, asserted where it is visible.
  IF EXISTS (SELECT 1 FROM public.line_guided_menu_markets WHERE market_code = 'wat_thung_lanna')
     AND NOT EXISTS (
       SELECT 1 FROM public.line_guided_menu_market_aliases
       WHERE alias_label = 'ทุ่งลานนา' AND market_code = 'wat_thung_lanna' AND active IS TRUE
     ) THEN
    RAISE EXCEPTION 'reviewed alias ทุ่งลานนา -> วัดทุ่งลานนา is missing';
  END IF;
END;
$verify$;

-- ── 2. `same_market` becomes an actual boolean ──────────────────────────────

-- It returned NULL — not false — whenever one label resolves to a reviewed
-- market code and the other does not, because the second disjunct evaluates
-- `'paseo' = NULL`. Every caller so far uses it inside WHERE or IF, where NULL
-- and false behave identically, so this is a no-op for all of them.
--
-- The near-match guard below NEGATES it, and `NOT NULL` is NULL, which would
-- have silently disabled the guard in exactly the case it exists for: a known
-- market beside an unreviewed variant. Fix the contract rather than the caller.
CREATE OR REPLACE FUNCTION public.accountability_round_same_market(
  p_left  text,
  p_right text
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    public.accountability_round_normalize(p_left)
      = public.accountability_round_normalize(p_right)
    OR (
      public.accountability_round_market_code(p_left) IS NOT NULL
      AND public.accountability_round_market_code(p_left)
          = public.accountability_round_market_code(p_right)
    ),
    false
  )
$$;

COMMENT ON FUNCTION public.accountability_round_same_market(text, text) IS
  'True when two market labels are provably the same market: identical after '
  'normalization, or both mapped to one reviewed catalog market_code. Never NULL '
  'and never fuzzy — an unprovable pair is false.';

-- ── 3. Near-match detection ─────────────────────────────────────────────────

-- Exactly one character apart after normalization: the transcription-slip
-- distance, and nothing looser. Deliberately NOT a similarity score — this
-- answers "is this worth asking a human about", never "are these the same".
--
-- Labels shorter than three characters are never near-matched: at that length a
-- one-character difference is most of the name.
CREATE OR REPLACE FUNCTION public.accountability_round_market_near_match(
  p_left  text,
  p_right text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  a    text[] := regexp_split_to_array(public.accountability_round_normalize(p_left), '');
  b    text[] := regexp_split_to_array(public.accountability_round_normalize(p_right), '');
  la   integer := coalesce(array_length(a, 1), 0);
  lb   integer := coalesce(array_length(b, 1), 0);
  prev integer[];
  cur  integer[];
  i    integer;
  j    integer;
  cost integer;
BEGIN
  IF la < 3 OR lb < 3 THEN RETURN false; END IF;
  IF abs(la - lb) > 1 THEN RETURN false; END IF;

  prev := ARRAY(SELECT generate_series(0, lb));
  FOR i IN 1 .. la LOOP
    cur := ARRAY[i];
    FOR j IN 1 .. lb LOOP
      cost := CASE WHEN a[i] = b[j] THEN 0 ELSE 1 END;
      cur := cur || least(
        prev[j + 1] + 1,   -- deletion
        cur[j] + 1,        -- insertion
        prev[j] + cost     -- substitution
      );
    END LOOP;
    prev := cur;
  END LOOP;

  RETURN prev[lb + 1] = 1;
END;
$$;

COMMENT ON FUNCTION public.accountability_round_market_near_match(text, text) IS
  'True when two market labels are exactly one character apart after normalization. '
  'A prompt for a human, never a match: nothing binds or merges on this answer.';

-- ── 4. Round binding with the creation-path guard ───────────────────────────

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
  v_near       public.accountability_rounds%ROWTYPE;
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
    -- The near-match guard, before anything is minted.
    --
    -- Skipped entirely when this generation's creation key already resolves: a
    -- replay, an out-of-order redelivery or a second close of the SAME document
    -- must stay idempotent, and re-guarding it would refuse a round this
    -- generation legitimately owns.
    IF NOT EXISTS (
      SELECT 1 FROM public.accountability_rounds
      WHERE created_line_event_id = v_creation_key
    ) THEN
      SELECT * INTO v_near
      FROM public.accountability_rounds r
      WHERE r.status = 'open'
        AND r.source_type = p_source_type
        AND r.source_id = btrim(p_source_id)
        AND r.business_date = p_business_date
        AND public.accountability_round_normalize(r.seller_label) = v_seller
        AND NOT public.accountability_round_same_market(r.market_label_normalized, v_market)
        AND public.accountability_round_market_near_match(r.market_label_normalized, v_market)
        -- Two markets the reviewed catalog knows and keeps apart are already a
        -- decided question. ต้อม runs พาซิโอ้ผัก, พาซิโอ้ผลไม้ and
        -- พาซิโอ้ทุเรียน in one group; asking him to confirm each one daily
        -- would be a confident wrong answer, not a guard.
        AND NOT (
          public.accountability_round_market_code(r.market_label_normalized) IS NOT NULL
          AND public.accountability_round_market_code(v_market) IS NOT NULL
        )
        -- Only a round holding real business content can shadow a new one. An
        -- empty round left behind by a blocked-then-retried withdrawal has
        -- nothing to protect, and the existing retry cleanup below retires it.
        AND EXISTS (
          SELECT 1
          FROM public.produce_transactions t
          WHERE t.accountability_round_id = r.id
            AND t.base_transaction_type = 'เบิก'
        )
      ORDER BY r.created_at, r.id
      LIMIT 1;

      IF FOUND THEN
        RETURN jsonb_build_object(
          'outcome', 'market_near_match',
          'accountability_round_id', v_near.id,
          'market_label', v_near.market_label
        );
      END IF;
    END IF;

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
  'Zero candidates return no_round and multiple candidates return ambiguous. '
  'A withdrawal whose market is one character from an existing open withdrawal round of the same '
  'group/date/seller returns market_near_match and creates nothing — the operator confirms which '
  'market it is. Reviewed catalog markets are never near-matched against each other.';

REVOKE ALL ON FUNCTION public.accountability_round_market_near_match(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accountability_round_market_near_match(text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) TO service_role;

COMMIT;
