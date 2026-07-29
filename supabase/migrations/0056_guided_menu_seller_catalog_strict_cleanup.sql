-- 0056: strict Guided Menu seller catalog cleanup (Slice 2.5).
-- Apply only after 0055, new code deployment, and at least the 30-minute
-- navigation TTL, with no unexpired legacy seller-less states remaining.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.line_guided_menu_sellers') IS NULL
     OR to_regclass('public.line_guided_menu_seller_aliases') IS NULL
     OR to_regclass('public.line_guided_menu_market_aliases') IS NULL
     OR to_regclass('public.line_guided_menu_seller_markets') IS NULL
     OR to_regclass('public.line_menu_states') IS NULL THEN
    RAISE EXCEPTION '0056: additive Guided Menu 0055 schema is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.line_menu_states
    WHERE expires_at > now()
      AND action_type IN ('choose_market', 'choose_date', 'confirm_open')
      AND NOT (payload ? 'seller_code')
  ) THEN
    RAISE EXCEPTION
      '0056: unexpired legacy seller-less Guided Menu states remain';
  END IF;

  IF (
    SELECT count(*)
    FROM public.line_guided_menu_markets
    WHERE market_code = 'kee'
      AND label = 'ตลาดกี้'
      AND active IS TRUE
  ) <> 1 THEN
    RAISE EXCEPTION
      '0056: kee/ตลาดกี้ differs from the original 0051 baseline';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'public.line_guided_menu_markets'::regclass
      AND conrelid NOT IN (
        'public.line_guided_menu_market_aliases'::regclass,
        'public.line_guided_menu_seller_markets'::regclass
      )
  ) THEN
    RAISE EXCEPTION
      '0056: unexpected foreign-key dependency on Guided Menu markets';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.line_guided_menu_market_aliases
    WHERE market_code = 'kee'
  ) OR EXISTS (
    SELECT 1
    FROM public.line_guided_menu_seller_markets
    WHERE market_code = 'kee'
  ) OR EXISTS (
    SELECT 1
    FROM public.line_menu_states
    WHERE expires_at > now()
      AND payload->>'market_code' = 'kee'
  ) THEN
    RAISE EXCEPTION
      '0056: kee/ตลาดกี้ still has an alias, assignment, or unexpired state';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.guided_menu_payload_valid(
  p_action  text,
  p_payload jsonb
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_keys   text[];
  v_tx     text;
  v_seller text;
  v_market text;
  v_dm     text;
  v_iso    text;
  v_intent text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF (p_payload ? 'staff_label')
     OR (p_payload ? 'seller_label')
     OR (p_payload ? 'market_label') THEN
    RETURN false;
  END IF;

  SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[])
    INTO v_keys
  FROM jsonb_object_keys(p_payload) AS k;

  CASE p_action
    WHEN 'menu_root' THEN
      IF cardinality(v_keys) = 0 THEN
        RETURN true;
      END IF;
      IF v_keys = ARRAY['intent'] THEN
        v_intent := p_payload->>'intent';
        RETURN v_intent = 'cancel';
      END IF;
      RETURN false;

    WHEN 'choose_transaction_type' THEN
      IF v_keys IS DISTINCT FROM ARRAY['transaction_type'] THEN
        RETURN false;
      END IF;
      v_tx := p_payload->>'transaction_type';
      RETURN v_tx IN ('withdraw', 'return', 'damaged_return');

    WHEN 'choose_seller' THEN
      IF v_keys IS DISTINCT FROM ARRAY['seller_code', 'transaction_type'] THEN
        RETURN false;
      END IF;
      v_tx := p_payload->>'transaction_type';
      v_seller := p_payload->>'seller_code';
      RETURN v_tx IN ('withdraw', 'return', 'damaged_return')
        AND coalesce(v_seller, '') ~ '^[a-z0-9_]{1,32}$'
        AND EXISTS (
          SELECT 1
          FROM public.line_guided_menu_sellers s
          WHERE s.seller_code = v_seller
            AND s.active IS TRUE
        );

    WHEN 'choose_market' THEN
      IF v_keys IS DISTINCT FROM
        ARRAY['market_code', 'seller_code', 'transaction_type'] THEN
        RETURN false;
      END IF;
      v_tx := p_payload->>'transaction_type';
      v_seller := p_payload->>'seller_code';
      v_market := p_payload->>'market_code';
      RETURN v_tx IN ('withdraw', 'return', 'damaged_return')
        AND coalesce(v_seller, '') ~ '^[a-z0-9_]{1,32}$'
        AND coalesce(v_market, '') ~ '^[a-z0-9_]{1,32}$'
        AND EXISTS (
          SELECT 1
          FROM public.line_guided_menu_sellers s
          JOIN public.line_guided_menu_seller_markets sm
            ON sm.seller_code = s.seller_code
          JOIN public.line_guided_menu_markets m
            ON m.market_code = sm.market_code
          WHERE s.seller_code = v_seller
            AND m.market_code = v_market
            AND s.active IS TRUE
            AND sm.active IS TRUE
            AND m.active IS TRUE
        );

    WHEN 'choose_date', 'confirm_open' THEN
      v_tx := p_payload->>'transaction_type';
      v_seller := p_payload->>'seller_code';
      v_market := p_payload->>'market_code';
      v_dm := p_payload->>'date_mode';
      v_iso := p_payload->>'iso_date';
      IF v_tx NOT IN ('withdraw', 'return', 'damaged_return')
         OR coalesce(v_seller, '') !~ '^[a-z0-9_]{1,32}$'
         OR coalesce(v_market, '') !~ '^[a-z0-9_]{1,32}$'
         OR NOT EXISTS (
           SELECT 1
           FROM public.line_guided_menu_sellers s
           JOIN public.line_guided_menu_seller_markets sm
             ON sm.seller_code = s.seller_code
           JOIN public.line_guided_menu_markets m
             ON m.market_code = sm.market_code
           WHERE s.seller_code = v_seller
             AND m.market_code = v_market
             AND s.active IS TRUE
             AND sm.active IS TRUE
             AND m.active IS TRUE
         ) THEN
        RETURN false;
      END IF;
      IF v_dm IN ('today', 'yesterday') THEN
        RETURN v_keys IS NOT DISTINCT FROM ARRAY[
          'date_mode', 'market_code', 'seller_code', 'transaction_type'
        ];
      END IF;
      IF v_dm = 'iso' THEN
        RETURN v_keys IS NOT DISTINCT FROM ARRAY[
          'date_mode', 'iso_date', 'market_code', 'seller_code',
          'transaction_type'
        ] AND public.guided_menu_iso_date_valid(v_iso);
      END IF;
      RETURN false;

    WHEN 'view_status', 'request_close', 'confirm_finalize' THEN
      RETURN cardinality(v_keys) = 0;

    ELSE
      RETURN false;
  END CASE;
END;
$fn$;

DO $state_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.line_menu_states
    WHERE expires_at > now()
      AND NOT public.guided_menu_payload_valid(action_type, payload)
  ) THEN
    RAISE EXCEPTION
      '0056: an unexpired Guided Menu state is invalid under strict catalog rules';
  END IF;
END;
$state_guard$;

DO $cleanup_guard$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.line_guided_menu_markets
  WHERE market_code = 'kee'
    AND label = 'ตลาดกี้'
    AND active IS TRUE;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    RAISE EXCEPTION
      '0056: kee/ตลาดกี้ cleanup affected % rows, expected 1',
      v_deleted;
  END IF;
END;
$cleanup_guard$;

REVOKE ALL ON FUNCTION public.guided_menu_payload_valid(text, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guided_menu_payload_valid(text, jsonb)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guided_menu_payload_valid(text, jsonb)
  TO service_role;

DO $postconditions$
BEGIN
  IF public.guided_menu_payload_valid(
    'choose_market',
    '{"transaction_type":"withdraw","market_code":"wat_thung_lanna"}'::jsonb
  ) THEN
    RAISE EXCEPTION '0056: legacy seller-less payload remains valid';
  END IF;

  IF NOT public.guided_menu_payload_valid(
    'choose_market',
    '{
      "transaction_type":"withdraw",
      "seller_code":"ki",
      "market_code":"wat_thung_lanna"
    }'::jsonb
  ) THEN
    RAISE EXCEPTION '0056: reviewed seller-aware payload is invalid';
  END IF;
END;
$postconditions$;

COMMIT;
