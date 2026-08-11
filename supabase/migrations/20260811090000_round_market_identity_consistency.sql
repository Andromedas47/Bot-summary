-- Market identity consistency for plain-text accountability round binding.
--
-- Production evidence (business date 2026-08-10, round
-- d96d2898-43f7-4eeb-9477-5e8b942da477): a withdrawal opened under `ทุ่งลานนา`
-- and its good/damaged returns opened under `วัดทุ่งลานนา` landed in the SAME
-- round carrying TWO market labels. Those two labels are not a typo — the
-- reviewed catalog already records `ทุ่งลานนา` as an active alias of the
-- canonical market `วัดทุ่งลานนา` (line_guided_menu_market_aliases, migration
-- 0055) — but bind_plain_text_accountability_round compared normalized LABELS,
-- so the alias failed both trust paths, returned `no_round`, and the pre-cutover
-- caller degraded to `unbound`. `pending_sessions.accountability_round_id` still
-- carried the withdrawal's round, and
-- propagate_produce_session_accountability_round reattached it silently.
--
-- Additive only. No new table, no new column, no data change, no backfill. Two
-- changes to one existing RPC:
--
--   1. Market equality becomes catalog-aware. Two labels are the same market
--      only when the REVIEWED catalog maps both to one market_code. No fuzzy
--      matching, no substring matching, no similarity score — a label the
--      catalog does not know keeps today's exact-normalized-equality rule.
--   2. A new `market_mismatch` outcome. When every other identity attribute
--      matches an open round but the market resolves to a DIFFERENT market, the
--      operator is told which market the round belongs to instead of receiving
--      the misleading "no withdrawal round found". Still fail-closed: nothing
--      is bound, nothing is persisted, nothing is rewritten.
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.bind_plain_text_accountability_round(text,uuid,text,text,text,date,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'P4A plain-text round binding is missing';
  END IF;
  IF to_regclass('public.line_guided_menu_markets') IS NULL
     OR to_regclass('public.line_guided_menu_market_aliases') IS NULL THEN
    RAISE EXCEPTION 'guided menu market catalog is missing (migration 0055 is not applied)';
  END IF;
END $$;

-- The reviewed canonical market code for a label, or NULL when the catalog does
-- not know it. Canonical labels win over aliases: an alias row can never
-- override an active market's own label.
CREATE OR REPLACE FUNCTION public.accountability_round_market_code(p_label text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (
      SELECT m.market_code
      FROM public.line_guided_menu_markets m
      WHERE m.active
        AND public.accountability_round_normalize(m.label)
            = public.accountability_round_normalize(p_label)
      ORDER BY m.market_code
      LIMIT 1
    ),
    (
      SELECT a.market_code
      FROM public.line_guided_menu_market_aliases a
      JOIN public.line_guided_menu_markets m ON m.market_code = a.market_code
      WHERE a.active
        AND m.active
        AND public.accountability_round_normalize(a.alias_label)
            = public.accountability_round_normalize(p_label)
      ORDER BY a.market_code
      LIMIT 1
    )
  )
$$;

COMMENT ON FUNCTION public.accountability_round_market_code(text) IS
  'Reviewed canonical market_code for a market label (canonical label first, then '
  'active alias). NULL when the catalog does not cover the label. Never fuzzy.';

-- Same market only when normalized labels match exactly, or the reviewed
-- catalog maps BOTH labels to one code. Two unknown labels are never merged.
CREATE OR REPLACE FUNCTION public.accountability_round_same_market(
  p_left  text,
  p_right text
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.accountability_round_normalize(p_left)
         = public.accountability_round_normalize(p_right)
    OR (
      public.accountability_round_market_code(p_left) IS NOT NULL
      AND public.accountability_round_market_code(p_left)
          = public.accountability_round_market_code(p_right)
    )
$$;

COMMENT ON FUNCTION public.accountability_round_same_market(text, text) IS
  'True when two market labels are provably the same market: identical after '
  'normalization, or both mapped to one reviewed catalog market_code.';

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
  v_other      public.accountability_rounds%ROWTYPE;
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
       -- A new withdrawal may only reuse the round IT created. Anything else
       -- carried over from the previous generation is a different economic
       -- cycle and must not absorb this one.
       AND (NOT p_is_new_round OR v_round.created_line_event_id = v_creation_key)
    THEN
      -- The market is the one attribute an operator retypes every message, so
      -- it is checked last and answered precisely: an alias of the same
      -- reviewed market continues the round; a genuinely different market is
      -- refused by name rather than reported as a missing withdrawal.
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
      AND public.accountability_round_same_market(market_label_normalized, v_market);

    IF v_candidates IS NULL OR array_length(v_candidates, 1) IS NULL THEN
      -- Nothing for THIS market. Before reporting a missing withdrawal, look
      -- for an open round of the same seller/day whose market is different:
      -- naming the round's market is the actionable answer, and it is the
      -- production failure this migration exists to stop.
      --
      -- Exactly one such round, or nothing is named. One LINE group legitimately
      -- runs several markets for one seller (Production: ต้อม runs พาชิโอ้,
      -- พาชิโอ้ผลไม้ and พาชิโอ้ทุเรียน in one group), and pointing at an
      -- arbitrary one of them would be a confident wrong answer.
      SELECT * INTO v_other
      FROM public.accountability_rounds
      WHERE status = 'open'
        AND source_type = p_source_type
        AND source_id = btrim(p_source_id)
        AND owner_line_user_id = btrim(p_line_user_id)
        AND business_date = p_business_date
        AND public.accountability_round_normalize(seller_label) = v_seller
      ORDER BY created_at
      LIMIT 1;
      IF FOUND AND (
        SELECT count(*) FROM public.accountability_rounds
        WHERE status = 'open'
          AND source_type = p_source_type
          AND source_id = btrim(p_source_id)
          AND owner_line_user_id = btrim(p_line_user_id)
          AND business_date = p_business_date
          AND public.accountability_round_normalize(seller_label) = v_seller
      ) = 1 THEN
        RETURN jsonb_build_object(
          'outcome', 'market_mismatch',
          'accountability_round_id', v_other.id,
          'market_label', v_other.market_label
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
  'Binds one plain-text pending generation to a P2E accountability round. A main '
  'withdrawal creates one (idempotent per generation); every other document kind '
  'resolves an existing open round and fails closed on zero, multiple, or '
  'different-market candidates. Market equality is the reviewed catalog''s, never fuzzy.';

REVOKE ALL ON FUNCTION public.accountability_round_market_code(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accountability_round_same_market(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accountability_round_market_code(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.accountability_round_same_market(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_plain_text_accountability_round(
  text, uuid, text, text, text, date, text, text, text, boolean
) TO service_role;

COMMIT;
