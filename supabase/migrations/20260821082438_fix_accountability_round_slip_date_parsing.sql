-- Fix P2E artifact date parsing so user-facing slip_date TEXT is never
-- cast through PostgreSQL DateStyle.
--
-- slip_batches.slip_date stays TEXT. Operators keep typing D/M/BBBB.
-- Unbound artifacts return before any round-date conversion.

BEGIN;

CREATE OR REPLACE FUNCTION public.parse_accountability_artifact_date(p_raw text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_temp
AS $$
DECLARE
  v_text text := pg_catalog.btrim(p_raw);
  v_year integer;
  v_month integer;
  v_day integer;
  v_date date;
BEGIN
  IF v_text = '' THEN
    RAISE EXCEPTION 'P2E: artifact date is invalid'
      USING ERRCODE = '22008';
  END IF;

  IF v_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    v_year := pg_catalog.substr(v_text, 1, 4)::integer;
    v_month := pg_catalog.substr(v_text, 6, 2)::integer;
    v_day := pg_catalog.substr(v_text, 9, 2)::integer;
  ELSIF v_text ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' THEN
    v_day := pg_catalog.split_part(v_text, '/', 1)::integer;
    v_month := pg_catalog.split_part(v_text, '/', 2)::integer;
    v_year := pg_catalog.split_part(v_text, '/', 3)::integer;
  ELSE
    RAISE EXCEPTION 'P2E: artifact date is invalid'
      USING ERRCODE = '22008';
  END IF;

  IF v_year > 2400 THEN
    v_year := v_year - 543;
  END IF;

  IF v_month < 1 OR v_month > 12
     OR v_day < 1 OR v_day > 31 THEN
    RAISE EXCEPTION 'P2E: artifact date is invalid'
      USING ERRCODE = '22008';
  END IF;

  BEGIN
    v_date := pg_catalog.make_date(v_year, v_month, v_day);
  EXCEPTION WHEN datetime_field_overflow OR data_exception THEN
    RAISE EXCEPTION 'P2E: artifact date is invalid'
      USING ERRCODE = '22008';
  END;

  IF pg_catalog.date_part('year', v_date)::integer IS DISTINCT FROM v_year
     OR pg_catalog.date_part('month', v_date)::integer IS DISTINCT FROM v_month
     OR pg_catalog.date_part('day', v_date)::integer IS DISTINCT FROM v_day THEN
    RAISE EXCEPTION 'P2E: artifact date is invalid'
      USING ERRCODE = '22008';
  END IF;

  RETURN v_date;
END;
$$;

COMMENT ON FUNCTION public.parse_accountability_artifact_date(text) IS
  'DateStyle-independent artifact date parser. Slash input is D/M/YYYY; year > 2400 is Buddhist Era.';

REVOKE ALL ON FUNCTION public.parse_accountability_artifact_date(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parse_accountability_artifact_date(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.assert_accountability_round_artifact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row       jsonb := to_jsonb(NEW);
  v_round     public.accountability_rounds%ROWTYPE;
  v_round_id  uuid := NULLIF(v_row->>'accountability_round_id', '')::uuid;
  v_source    text := NULLIF(btrim(v_row->>'source_id'), '');
  v_owner     text := NULLIF(btrim(COALESCE(
    v_row->>'line_user_id',
    v_row->>'opened_by_line_user_id',
    v_row->>'sender_id'
  )), '');
  v_date      date;
  v_seller    text := COALESCE(v_row->>'seller_name', v_row->>'staff_name');
  v_market    text := COALESCE(
    v_row->>'market_label_normalized',
    v_row->>'market_label',
    v_row->>'market_name'
  );
BEGIN
  IF v_round_id IS NULL THEN RETURN NEW; END IF;

  v_date := COALESCE(
    public.parse_accountability_artifact_date(NULLIF(v_row->>'business_date', '')),
    public.parse_accountability_artifact_date(NULLIF(v_row->>'settlement_date', '')),
    public.parse_accountability_artifact_date(NULLIF(v_row->>'slip_date', ''))
  );

  SELECT * INTO v_round
  FROM public.accountability_rounds
  WHERE id = v_round_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P2E: accountability round % does not exist', v_round_id;
  END IF;
  IF TG_OP = 'INSERT' AND v_round.status <> 'open' THEN
    RAISE EXCEPTION 'P2E: accountability round % is not open', v_round_id;
  END IF;
  IF v_source IS NOT NULL AND v_source IS DISTINCT FROM v_round.source_id THEN
    RAISE EXCEPTION 'P2E: artifact source does not match accountability round %', v_round_id;
  END IF;
  IF v_owner IS NOT NULL AND v_owner IS DISTINCT FROM v_round.owner_line_user_id THEN
    RAISE EXCEPTION 'P2E: artifact owner does not match accountability round %', v_round_id;
  END IF;
  IF v_date IS NOT NULL AND v_date IS DISTINCT FROM v_round.business_date THEN
    RAISE EXCEPTION 'P2E: artifact business date does not match accountability round %', v_round_id;
  END IF;
  IF v_seller IS NOT NULL
     AND public.accountability_round_normalize(v_seller)
         IS DISTINCT FROM public.accountability_round_normalize(v_round.seller_label) THEN
    RAISE EXCEPTION 'P2E: artifact seller does not match accountability round %', v_round_id;
  END IF;
  IF v_market IS NOT NULL
     AND public.accountability_round_normalize(v_market)
         IS DISTINCT FROM v_round.market_label_normalized THEN
    RAISE EXCEPTION 'P2E: artifact market does not match accountability round %', v_round_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_accountability_round_artifact()
  FROM PUBLIC, anon, authenticated;

COMMIT;
