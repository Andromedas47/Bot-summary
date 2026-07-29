-- 0055: Guided Menu seller + seller-market catalog (Slice 2.5).
-- No Produce/session writes. Existing 0051 markets are reused unchanged.

DO $$
BEGIN
  IF to_regclass('public.line_guided_menu_markets') IS NULL
     OR to_regclass('public.line_menu_states') IS NULL THEN
    RAISE EXCEPTION '0055: required Guided Menu 0051 tables are missing';
  END IF;
END $$;

CREATE TABLE public.line_guided_menu_sellers (
  seller_code text PRIMARY KEY,
  label       text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_guided_menu_sellers_code_format
    CHECK (seller_code ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT line_guided_menu_sellers_label_nonblank
    CHECK (btrim(label) <> '')
);

CREATE TABLE public.line_guided_menu_seller_markets (
  seller_code text NOT NULL,
  market_code text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_code, market_code),
  CONSTRAINT line_guided_menu_seller_markets_seller_fk
    FOREIGN KEY (seller_code)
    REFERENCES public.line_guided_menu_sellers (seller_code),
  CONSTRAINT line_guided_menu_seller_markets_market_fk
    FOREIGN KEY (market_code)
    REFERENCES public.line_guided_menu_markets (market_code)
);

COMMENT ON TABLE public.line_guided_menu_sellers IS
  'Authoritative seller catalog for Guided Menu seller selection.';
COMMENT ON TABLE public.line_guided_menu_seller_markets IS
  'Authoritative allowed seller-market assignments for Guided Menu.';

ALTER TABLE public.line_guided_menu_sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_guided_menu_seller_markets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_sellers TO service_role;

REVOKE ALL ON TABLE public.line_guided_menu_seller_markets FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_seller_markets FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_seller_markets FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_seller_markets TO service_role;

-- Seller rows are deliberately omitted pending the business confirmations in
-- docs/guided-menu-slice-2.5-catalog-review.md. Never seed historical text
-- without explicit review.

ALTER TABLE public.line_menu_states
  DROP CONSTRAINT line_menu_states_action_type_allowed;
ALTER TABLE public.line_menu_states
  ADD CONSTRAINT line_menu_states_action_type_allowed
  CHECK (action_type IN (
    'menu_root',
    'choose_transaction_type',
    'choose_seller',
    'choose_market',
    'choose_date',
    'confirm_open',
    'view_status',
    'request_close',
    'confirm_finalize'
  ));

ALTER TABLE public.line_menu_states
  DROP CONSTRAINT line_menu_states_payload_no_trusted_labels;
ALTER TABLE public.line_menu_states
  ADD CONSTRAINT line_menu_states_payload_no_trusted_labels
  CHECK (
    NOT (payload ? 'staff_label')
    AND NOT (payload ? 'seller_label')
    AND NOT (payload ? 'market_label')
  );

CREATE OR REPLACE FUNCTION public.guided_menu_payload_valid(
  p_action  text,
  p_payload jsonb
) RETURNS boolean
LANGUAGE plpgsql
STABLE
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
        AND v_seller ~ '^[a-z0-9_]{1,32}$'
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
        AND v_seller ~ '^[a-z0-9_]{1,32}$'
        AND v_market ~ '^[a-z0-9_]{1,32}$'
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
         OR v_seller !~ '^[a-z0-9_]{1,32}$'
         OR v_market !~ '^[a-z0-9_]{1,32}$'
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
        RETURN v_keys IS NOT DISTINCT FROM
          ARRAY['date_mode', 'market_code', 'seller_code', 'transaction_type'];
      END IF;
      IF v_dm = 'iso' THEN
        IF v_keys IS DISTINCT FROM ARRAY[
          'date_mode',
          'iso_date',
          'market_code',
          'seller_code',
          'transaction_type'
        ] THEN
          RETURN false;
        END IF;
        RETURN public.guided_menu_iso_date_valid(v_iso);
      END IF;
      RETURN false;

    WHEN 'view_status', 'request_close', 'confirm_finalize' THEN
      RETURN cardinality(v_keys) = 0;

    ELSE
      RETURN false;
  END CASE;
END;
$fn$;
