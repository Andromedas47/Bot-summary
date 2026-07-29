-- 0055: additive Guided Menu seller + seller-market catalog (Slice 2.5).
-- Compatibility phase: legacy seller-less 0051 navigation remains valid until
-- the 30-minute navigation TTL has drained and strict migration 0056 is applied.
-- No Produce/session writes. Only explicitly reviewed catalog rows are seeded.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.line_guided_menu_markets') IS NULL
     OR to_regclass('public.line_menu_states') IS NULL
     OR to_regprocedure(
       'public.guided_menu_payload_valid(text,jsonb)'
     ) IS NULL
     OR to_regprocedure(
       'public.consume_line_menu_state(text,text,text,text,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION '0055: required Guided Menu 0051 schema is missing';
  END IF;

  IF (
    SELECT count(*)
    FROM public.line_guided_menu_markets
    WHERE market_code = 'kee'
      AND label = 'ตลาดกี้'
      AND active IS TRUE
  ) <> 1 THEN
    RAISE EXCEPTION
      '0055: kee/ตลาดกี้ differs from the reviewed 0051 baseline';
  END IF;
END;
$preflight$;

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

CREATE TABLE public.line_guided_menu_seller_aliases (
  alias_label text PRIMARY KEY,
  seller_code text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_guided_menu_seller_aliases_label_nonblank
    CHECK (btrim(alias_label) <> ''),
  CONSTRAINT line_guided_menu_seller_aliases_seller_fk
    FOREIGN KEY (seller_code)
    REFERENCES public.line_guided_menu_sellers (seller_code)
);

CREATE TABLE public.line_guided_menu_market_aliases (
  alias_label text PRIMARY KEY,
  market_code text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_guided_menu_market_aliases_label_nonblank
    CHECK (btrim(alias_label) <> ''),
  CONSTRAINT line_guided_menu_market_aliases_market_fk
    FOREIGN KEY (market_code)
    REFERENCES public.line_guided_menu_markets (market_code)
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
COMMENT ON TABLE public.line_guided_menu_seller_aliases IS
  'Reviewed historical seller labels mapped to canonical sellers.';
COMMENT ON TABLE public.line_guided_menu_market_aliases IS
  'Reviewed historical market labels mapped to canonical markets.';
COMMENT ON TABLE public.line_guided_menu_seller_markets IS
  'Authoritative allowed seller-market assignments for Guided Menu.';

ALTER TABLE public.line_guided_menu_sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_guided_menu_seller_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_guided_menu_market_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_guided_menu_seller_markets ENABLE ROW LEVEL SECURITY;

-- Neutralize broad Production-like default ACLs before exact grants.
REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_sellers
  TO service_role;

REVOKE ALL ON TABLE public.line_guided_menu_seller_aliases FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_seller_aliases
  FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_seller_aliases FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_seller_aliases
  TO service_role;

REVOKE ALL ON TABLE public.line_guided_menu_market_aliases FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_market_aliases
  FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_market_aliases FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_market_aliases
  TO service_role;

REVOKE ALL ON TABLE public.line_guided_menu_seller_markets FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_seller_markets
  FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_seller_markets FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_seller_markets
  TO service_role;

-- BEGIN REVIEWED CATALOG SEEDS
-- Temporary baselines let insert-if-missing stay deterministic while any
-- Production-managed drift fails the migration instead of being overwritten.
CREATE TEMP TABLE _gm55_markets (
  market_code text PRIMARY KEY,
  label text NOT NULL,
  active boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO _gm55_markets VALUES
  ('ratchaphruek', 'ราชพฤกษ์', true),
  ('chaloem_72', 'เฉลิมฯ72', true),
  ('wat_thung_lanna', 'วัดทุ่งลานนา', true),
  ('paseo_vegetable', 'พาซิโอ้ผัก', true),
  ('wat_taklam', 'วัดตะกล่ำ', true),
  ('paseo_fruit', 'พาซิโอ้ผลไม้', true),
  ('wihan', 'วิหาร', true),
  ('paseo_durian', 'พาซิโอ้ทุเรียน', true),
  ('liap_duan', 'เลียบด่วน', true),
  ('sap_phun', 'ทรัพย์พัน', true),
  ('seven_front', 'หน้าเซเวน', true),
  ('rot_re', 'รถเร่', true);

CREATE TEMP TABLE _gm55_sellers (
  seller_code text PRIMARY KEY,
  label text NOT NULL,
  active boolean NOT NULL,
  sort_order integer NOT NULL
) ON COMMIT DROP;

INSERT INTO _gm55_sellers VALUES
  ('ki', 'กี้', true, 10),
  ('ohm', 'โอม', true, 20),
  ('jiew', 'จิ๋ว', true, 30),
  ('noi', 'น้อย', true, 40),
  ('tan', 'แทน', true, 50),
  ('tom', 'ต้อม', true, 60),
  ('wut', 'วุฒิ', true, 70),
  ('kwan', 'ขวัญ', true, 80),
  ('mint', 'มิ้น', true, 90),
  ('phi_dam', 'พี่ดำ', true, 100),
  ('pla', 'ปลา', true, 110),
  ('toey', 'เต้ย', true, 120),
  ('nu_lek', 'หนูเล็ก', true, 130),
  ('ja', 'จ๋า', true, 140),
  ('pa_lee', 'ป้าลี', true, 150),
  ('nang', 'นาง', true, 160);

CREATE TEMP TABLE _gm55_seller_aliases (
  alias_label text PRIMARY KEY,
  seller_code text NOT NULL,
  active boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO _gm55_seller_aliases VALUES
  ('กี่', 'ki', true),
  ('โอ', 'ohm', true),
  ('ดำ', 'phi_dam', true);

CREATE TEMP TABLE _gm55_market_aliases (
  alias_label text PRIMARY KEY,
  market_code text NOT NULL,
  active boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO _gm55_market_aliases VALUES
  ('ตลาด72', 'chaloem_72', true),
  ('เฉลิม72', 'chaloem_72', true),
  ('พาชิโอ้ทุเรียน', 'paseo_durian', true),
  ('พาสิโอ้ทุเรียน', 'paseo_durian', true),
  ('พาชิโอ้ ทุเรียน', 'paseo_durian', true),
  ('พาชิโอ้ผลไม้', 'paseo_fruit', true),
  ('พาชิโอ้ ผลไม้', 'paseo_fruit', true),
  ('ตลาดพาซิโอ้ผลไม้', 'paseo_fruit', true),
  ('พาสิโอ้ผลไม้', 'paseo_fruit', true),
  ('พาชิโอ้ผัก', 'paseo_vegetable', true),
  ('พาสิโอ้ผัก', 'paseo_vegetable', true),
  ('ตลาดราชพฤก', 'ratchaphruek', true),
  ('ตลาดราชพฤกษ์', 'ratchaphruek', true),
  ('ราชพฤก', 'ratchaphruek', true),
  ('เลียบทางด่วน', 'liap_duan', true),
  ('วัดตะกลํ่า', 'wat_taklam', true),
  ('ตลาดทุ่งลานนา', 'wat_thung_lanna', true),
  ('ตลาดวัดทุ่งลานนา', 'wat_thung_lanna', true),
  ('ทุ่งลานนา', 'wat_thung_lanna', true),
  ('หน้าเซเว่น', 'seven_front', true),
  ('ทรัพย์พัน2', 'sap_phun', true);

CREATE TEMP TABLE _gm55_assignments (
  seller_code text NOT NULL,
  market_code text NOT NULL,
  active boolean NOT NULL,
  sort_order integer NOT NULL,
  PRIMARY KEY (seller_code, market_code)
) ON COMMIT DROP;

INSERT INTO _gm55_assignments VALUES
  ('ki', 'wat_thung_lanna', true, 10),
  ('ki', 'wat_taklam', true, 20),
  ('ki', 'wihan', true, 30),
  ('ohm', 'paseo_fruit', true, 10),
  ('ohm', 'paseo_vegetable', true, 20),
  ('jiew', 'rot_re', true, 10),
  ('noi', 'wat_taklam', true, 10),
  ('noi', 'sap_phun', true, 20),
  ('noi', 'liap_duan', true, 30),
  ('noi', 'seven_front', true, 40),
  ('tan', 'wihan', true, 10),
  ('tan', 'liap_duan', true, 20),
  ('tan', 'paseo_durian', true, 30),
  ('tom', 'paseo_vegetable', true, 10),
  ('tom', 'paseo_durian', true, 20),
  ('tom', 'paseo_fruit', true, 30),
  ('wut', 'ratchaphruek', true, 10),
  ('wut', 'wat_taklam', true, 20),
  ('kwan', 'chaloem_72', true, 10),
  ('mint', 'chaloem_72', true, 10),
  ('phi_dam', 'chaloem_72', true, 10),
  ('phi_dam', 'paseo_fruit', true, 20),
  ('phi_dam', 'ratchaphruek', true, 30),
  ('phi_dam', 'wihan', true, 40),
  ('phi_dam', 'wat_thung_lanna', true, 50),
  ('phi_dam', 'liap_duan', true, 60),
  ('phi_dam', 'sap_phun', true, 70),
  ('pla', 'ratchaphruek', true, 10),
  ('toey', 'chaloem_72', true, 10),
  ('toey', 'wihan', true, 20),
  ('toey', 'wat_thung_lanna', true, 30),
  ('nu_lek', 'seven_front', true, 10),
  ('nu_lek', 'paseo_fruit', true, 20),
  ('pa_lee', 'paseo_fruit', true, 10),
  ('pa_lee', 'paseo_vegetable', true, 20);

INSERT INTO public.line_guided_menu_markets (market_code, label, active)
SELECT market_code, label, active
FROM _gm55_markets
ON CONFLICT (market_code) DO NOTHING;

INSERT INTO public.line_guided_menu_sellers
  (seller_code, label, active, sort_order)
SELECT seller_code, label, active, sort_order
FROM _gm55_sellers
ON CONFLICT (seller_code) DO NOTHING;

INSERT INTO public.line_guided_menu_seller_aliases
  (alias_label, seller_code, active)
SELECT alias_label, seller_code, active
FROM _gm55_seller_aliases
ON CONFLICT (alias_label) DO NOTHING;

INSERT INTO public.line_guided_menu_market_aliases
  (alias_label, market_code, active)
SELECT alias_label, market_code, active
FROM _gm55_market_aliases
ON CONFLICT (alias_label) DO NOTHING;

INSERT INTO public.line_guided_menu_seller_markets
  (seller_code, market_code, active, sort_order)
SELECT seller_code, market_code, active, sort_order
FROM _gm55_assignments
ON CONFLICT (seller_code, market_code) DO NOTHING;

DO $seed_validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM _gm55_markets expected
    JOIN public.line_guided_menu_markets actual USING (market_code)
    WHERE (actual.label, actual.active)
      IS DISTINCT FROM (expected.label, expected.active)
  ) THEN
    RAISE EXCEPTION '0055: reviewed market baseline drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _gm55_sellers expected
    JOIN public.line_guided_menu_sellers actual USING (seller_code)
    WHERE (actual.label, actual.active, actual.sort_order)
      IS DISTINCT FROM
        (expected.label, expected.active, expected.sort_order)
  ) THEN
    RAISE EXCEPTION '0055: reviewed seller baseline drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _gm55_seller_aliases expected
    JOIN public.line_guided_menu_seller_aliases actual USING (alias_label)
    WHERE (actual.seller_code, actual.active)
      IS DISTINCT FROM (expected.seller_code, expected.active)
  ) THEN
    RAISE EXCEPTION '0055: reviewed seller alias baseline drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _gm55_market_aliases expected
    JOIN public.line_guided_menu_market_aliases actual USING (alias_label)
    WHERE (actual.market_code, actual.active)
      IS DISTINCT FROM (expected.market_code, expected.active)
  ) THEN
    RAISE EXCEPTION '0055: reviewed market alias baseline drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _gm55_assignments expected
    JOIN public.line_guided_menu_seller_markets actual
      USING (seller_code, market_code)
    WHERE (actual.active, actual.sort_order)
      IS DISTINCT FROM (expected.active, expected.sort_order)
  ) THEN
    RAISE EXCEPTION '0055: reviewed seller-market baseline drift';
  END IF;
END;
$seed_validation$;
-- END REVIEWED CATALOG SEEDS

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
      v_tx := p_payload->>'transaction_type';
      v_seller := p_payload->>'seller_code';
      v_market := p_payload->>'market_code';
      IF v_tx NOT IN ('withdraw', 'return', 'damaged_return')
         OR coalesce(v_market, '') !~ '^[a-z0-9_]{1,32}$'
         OR NOT EXISTS (
           SELECT 1
           FROM public.line_guided_menu_markets m
           WHERE m.market_code = v_market
             AND m.active IS TRUE
         ) THEN
        RETURN false;
      END IF;
      IF v_keys = ARRAY['market_code', 'transaction_type'] THEN
        RETURN true;
      END IF;
      IF v_keys IS DISTINCT FROM
        ARRAY['market_code', 'seller_code', 'transaction_type'] THEN
        RETURN false;
      END IF;
      RETURN coalesce(v_seller, '') ~ '^[a-z0-9_]{1,32}$'
        AND EXISTS (
          SELECT 1
          FROM public.line_guided_menu_sellers s
          JOIN public.line_guided_menu_seller_markets sm
            ON sm.seller_code = s.seller_code
          WHERE s.seller_code = v_seller
            AND sm.market_code = v_market
            AND s.active IS TRUE
            AND sm.active IS TRUE
        );

    WHEN 'choose_date', 'confirm_open' THEN
      v_tx := p_payload->>'transaction_type';
      v_seller := p_payload->>'seller_code';
      v_market := p_payload->>'market_code';
      v_dm := p_payload->>'date_mode';
      v_iso := p_payload->>'iso_date';
      IF v_tx NOT IN ('withdraw', 'return', 'damaged_return')
         OR coalesce(v_market, '') !~ '^[a-z0-9_]{1,32}$'
         OR NOT EXISTS (
           SELECT 1
           FROM public.line_guided_menu_markets m
           WHERE m.market_code = v_market
             AND m.active IS TRUE
         ) THEN
        RETURN false;
      END IF;
      IF p_payload ? 'seller_code' THEN
        IF coalesce(v_seller, '') !~ '^[a-z0-9_]{1,32}$'
           OR NOT EXISTS (
             SELECT 1
             FROM public.line_guided_menu_sellers s
             JOIN public.line_guided_menu_seller_markets sm
               ON sm.seller_code = s.seller_code
             WHERE s.seller_code = v_seller
               AND sm.market_code = v_market
               AND s.active IS TRUE
               AND sm.active IS TRUE
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
      END IF;
      IF v_dm IN ('today', 'yesterday') THEN
        RETURN v_keys IS NOT DISTINCT FROM
          ARRAY['date_mode', 'market_code', 'transaction_type'];
      END IF;
      IF v_dm = 'iso' THEN
        RETURN v_keys IS NOT DISTINCT FROM ARRAY[
          'date_mode', 'iso_date', 'market_code', 'transaction_type'
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

CREATE OR REPLACE FUNCTION public.consume_line_menu_state(
  p_token_hash     text,
  p_line_event_id  text,
  p_line_user_id   text,
  p_source_type    text,
  p_source_id      text,
  p_session_key    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_hash   text;
  v_event  text;
  v_user   text;
  v_stype  text;
  v_sid    text;
  v_skey   text;
  v_row    public.line_menu_states%ROWTYPE;
BEGIN
  v_hash  := btrim(coalesce(p_token_hash, ''));
  v_event := btrim(coalesce(p_line_event_id, ''));
  v_user  := btrim(coalesce(p_line_user_id, ''));
  v_stype := btrim(coalesce(p_source_type, ''));
  v_sid   := btrim(coalesce(p_source_id, ''));
  v_skey  := NULLIF(btrim(coalesce(p_session_key, '')), '');

  IF v_hash !~ '^[0-9a-f]{64}$'
     OR length(v_event) = 0
     OR length(v_user) = 0
     OR length(v_stype) = 0
     OR length(v_sid) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  SELECT * INTO v_row
  FROM public.line_menu_states
  WHERE token_hash = v_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  IF v_row.line_user_id IS DISTINCT FROM v_user
     OR v_row.source_type IS DISTINCT FROM v_stype
     OR v_row.source_id IS DISTINCT FROM v_sid
     OR v_row.session_key IS DISTINCT FROM v_skey
     OR now() >= v_row.expires_at THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  -- Revalidate before both the update trigger and same-event replay.
  IF NOT public.guided_menu_payload_valid(
    v_row.action_type,
    v_row.payload
  ) THEN
    RETURN jsonb_build_object('status', 'invalid_or_expired');
  END IF;

  IF v_row.consumed_at IS NOT NULL THEN
    IF v_row.consumed_line_event_id IS NOT DISTINCT FROM v_event THEN
      RETURN jsonb_build_object(
        'status', 'replay',
        'action_type', v_row.action_type,
        'payload', v_row.payload,
        'result', v_row.result
      );
    END IF;
    RETURN jsonb_build_object('status', 'already_consumed');
  END IF;

  UPDATE public.line_menu_states
  SET
    consumed_at            = now(),
    consumed_line_event_id = v_event,
    updated_at             = now()
  WHERE token_hash = v_hash
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'status', 'consumed',
    'action_type', v_row.action_type,
    'payload', v_row.payload
  );
END;
$fn$;

COMMENT ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) IS
  'SECURITY INVOKER. Revalidates current catalog before first consume and replay.';

REVOKE ALL ON FUNCTION public.guided_menu_payload_valid(text, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guided_menu_payload_valid(text, jsonb)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guided_menu_payload_valid(text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_line_menu_state(
  text, text, text, text, text, text
) TO service_role;

DO $postconditions$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_class c
    WHERE c.oid IN (
      'public.line_guided_menu_sellers'::regclass,
      'public.line_guided_menu_seller_aliases'::regclass,
      'public.line_guided_menu_market_aliases'::regclass,
      'public.line_guided_menu_seller_markets'::regclass
    )
      AND c.relrowsecurity
  ) <> 4 THEN
    RAISE EXCEPTION '0055: catalog RLS postcondition failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.line_guided_menu_seller_aliases
    WHERE alias_label = 'ป้าลีนาง'
  ) OR EXISTS (
    SELECT 1
    FROM public.line_guided_menu_market_aliases
    WHERE alias_label IN ('พาสิโอ้', 'ผัก', 'ผลไม้', 'ทุเรียน')
  ) OR EXISTS (
    SELECT 1
    FROM public.line_guided_menu_markets
    WHERE label IN ('วิหารหลวงปู่โต', 'ทรัพย์เจริญ')
  ) THEN
    RAISE EXCEPTION '0055: rejected or unconfirmed catalog label present';
  END IF;
END;
$postconditions$;

COMMIT;
