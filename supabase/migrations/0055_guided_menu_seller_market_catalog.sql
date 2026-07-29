-- 0055: Guided Menu seller + seller-market catalog (Slice 2.5).
-- No Produce/session writes. Only explicitly reviewed catalog rows are seeded.

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

REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_sellers FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_sellers TO service_role;

REVOKE ALL ON TABLE public.line_guided_menu_seller_aliases FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_seller_aliases FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_seller_aliases FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_seller_aliases TO service_role;

REVOKE ALL ON TABLE public.line_guided_menu_market_aliases FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_market_aliases FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_market_aliases FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_market_aliases TO service_role;

REVOKE ALL ON TABLE public.line_guided_menu_seller_markets FROM PUBLIC;
REVOKE ALL ON TABLE public.line_guided_menu_seller_markets FROM anon, authenticated;
REVOKE ALL ON TABLE public.line_guided_menu_seller_markets FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_guided_menu_seller_markets TO service_role;

-- 0051's ตลาดกี้ row was based on malformed history, not a genuine market.
DELETE FROM public.line_guided_menu_markets
WHERE market_code = 'kee';

-- Deterministic reviewed catalog. Conflict updates are guarded so rerunning
-- the seed DML is a no-op when values already match.
INSERT INTO public.line_guided_menu_markets
  (market_code, label, active)
VALUES
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
  ('rot_re', 'รถเร่', true)
ON CONFLICT (market_code) DO UPDATE
SET label = EXCLUDED.label,
    active = EXCLUDED.active,
    updated_at = now()
WHERE (line_guided_menu_markets.label, line_guided_menu_markets.active)
  IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.active);

INSERT INTO public.line_guided_menu_sellers
  (seller_code, label, active, sort_order)
VALUES
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
  ('nang', 'นาง', true, 160)
ON CONFLICT (seller_code) DO UPDATE
SET label = EXCLUDED.label,
    active = EXCLUDED.active,
    sort_order = EXCLUDED.sort_order,
    updated_at = now()
WHERE (
  line_guided_menu_sellers.label,
  line_guided_menu_sellers.active,
  line_guided_menu_sellers.sort_order
) IS DISTINCT FROM (
  EXCLUDED.label,
  EXCLUDED.active,
  EXCLUDED.sort_order
);

INSERT INTO public.line_guided_menu_seller_aliases
  (alias_label, seller_code, active)
VALUES
  ('กี่', 'ki', true),
  ('โอ', 'ohm', true),
  ('ดำ', 'phi_dam', true)
ON CONFLICT (alias_label) DO UPDATE
SET seller_code = EXCLUDED.seller_code,
    active = EXCLUDED.active,
    updated_at = now()
WHERE (
  line_guided_menu_seller_aliases.seller_code,
  line_guided_menu_seller_aliases.active
) IS DISTINCT FROM (
  EXCLUDED.seller_code,
  EXCLUDED.active
);

INSERT INTO public.line_guided_menu_market_aliases
  (alias_label, market_code, active)
VALUES
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
  ('ทรัพย์พัน2', 'sap_phun', true)
ON CONFLICT (alias_label) DO UPDATE
SET market_code = EXCLUDED.market_code,
    active = EXCLUDED.active,
    updated_at = now()
WHERE (
  line_guided_menu_market_aliases.market_code,
  line_guided_menu_market_aliases.active
) IS DISTINCT FROM (
  EXCLUDED.market_code,
  EXCLUDED.active
);

INSERT INTO public.line_guided_menu_seller_markets
  (seller_code, market_code, active, sort_order)
VALUES
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
  ('pa_lee', 'paseo_vegetable', true, 20)
ON CONFLICT (seller_code, market_code) DO UPDATE
SET active = EXCLUDED.active,
    sort_order = EXCLUDED.sort_order,
    updated_at = now()
WHERE (
  line_guided_menu_seller_markets.active,
  line_guided_menu_seller_markets.sort_order
) IS DISTINCT FROM (
  EXCLUDED.active,
  EXCLUDED.sort_order
);

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
