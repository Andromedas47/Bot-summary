-- Central daily selling price (BR-01): one price per product + unit +
-- business_date, global across markets. Replaces withdrawal-lot/FIFO pricing
-- as the trusted source for Digital White Sheet expected sales.
--
-- Identity: (product_key, unit_key, business_date). product_key/unit_key are
-- the SAME canonical strings the application already produces via
-- normalizeProductName() and resolveUnitQuantity(...).unit (see
-- src/lib/white-sheet/pricing.ts) — never computed independently in SQL, so
-- the price identity can never silently diverge from the item-grouping
-- identity used to compute sold quantity.
--
-- Money is stored as an integer number of satang (1 baht = 100 satang) —
-- never numeric/float — per BR-01/Phase 2. No floating-point financial
-- storage.
--
-- central_selling_prices holds only the CURRENT price per identity; the
-- UNIQUE constraint is the DB-enforced guarantee that at most one current
-- price exists per (product_key, unit_key, business_date) — market is
-- deliberately NOT part of this identity (BR-01: price is global across
-- markets).
--
-- central_selling_price_corrections is an append-only audit log: one row per
-- "set" or "correction", recording previous value (NULL for the first set),
-- new value, actor, reason, and timestamp (BR-04/BR-05). Rows are never
-- updated or deleted.
--
-- set_central_selling_price(...) performs the read-lock/upsert/audit-insert
-- atomically in one transaction (via SELECT ... FOR UPDATE), so concurrent
-- corrections cannot race past each other and the UNIQUE constraint is the
-- final backstop against two concurrent "first sets" both succeeding.

CREATE TABLE public.central_selling_prices (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key    text        NOT NULL,
  unit_key       text        NOT NULL,
  business_date  date        NOT NULL,
  price_satang   integer     NOT NULL CHECK (price_satang >= 0),
  set_by         text        NOT NULL,
  set_reason     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_key, unit_key, business_date)
);

COMMENT ON TABLE public.central_selling_prices IS
  'Current central selling price per product+unit+business_date, global across markets (BR-01). '
  'One row per identity — corrections update this row in place; history lives in '
  'central_selling_price_corrections.';

CREATE INDEX central_selling_prices_date_idx
  ON public.central_selling_prices (business_date);

CREATE TABLE public.central_selling_price_corrections (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  price_id               uuid        NOT NULL REFERENCES public.central_selling_prices(id),
  product_key            text        NOT NULL,
  unit_key               text        NOT NULL,
  business_date          date        NOT NULL,
  previous_price_satang  integer,
  new_price_satang       integer     NOT NULL CHECK (new_price_satang >= 0),
  actor                  text        NOT NULL,
  reason                 text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.central_selling_price_corrections IS
  'Append-only audit trail for every central price set/correction (BR-04). Never updated or deleted.';

CREATE INDEX central_selling_price_corrections_price_id_idx
  ON public.central_selling_price_corrections (price_id, created_at);

CREATE OR REPLACE FUNCTION public.set_central_selling_price(
  p_product_key   text,
  p_unit_key      text,
  p_business_date date,
  p_price_satang  integer,
  p_actor         text,
  p_reason        text
) RETURNS public.central_selling_prices
LANGUAGE plpgsql
AS $$
DECLARE
  v_row      public.central_selling_prices;
  v_previous integer;
BEGIN
  IF p_product_key IS NULL OR btrim(p_product_key) = '' THEN
    RAISE EXCEPTION 'product_key must not be empty';
  END IF;
  IF p_unit_key IS NULL OR btrim(p_unit_key) = '' THEN
    RAISE EXCEPTION 'unit_key must not be empty';
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF p_price_satang IS NULL OR p_price_satang < 0 THEN
    RAISE EXCEPTION 'price_satang must be a non-negative integer';
  END IF;

  SELECT * INTO v_row
  FROM public.central_selling_prices
  WHERE product_key = p_product_key
    AND unit_key = p_unit_key
    AND business_date = p_business_date
  FOR UPDATE;

  IF FOUND THEN
    v_previous := v_row.price_satang;
    UPDATE public.central_selling_prices
    SET price_satang = p_price_satang,
        set_by       = p_actor,
        set_reason   = p_reason,
        updated_at   = now()
    WHERE id = v_row.id
    RETURNING * INTO v_row;
  ELSE
    v_previous := NULL;
    INSERT INTO public.central_selling_prices
      (product_key, unit_key, business_date, price_satang, set_by, set_reason)
    VALUES
      (p_product_key, p_unit_key, p_business_date, p_price_satang, p_actor, p_reason)
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO public.central_selling_price_corrections
    (price_id, product_key, unit_key, business_date, previous_price_satang, new_price_satang, actor, reason)
  VALUES
    (v_row.id, p_product_key, p_unit_key, p_business_date, v_previous, p_price_satang, p_actor, p_reason);

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.set_central_selling_price IS
  'Atomically sets or corrects the central selling price for one identity and records an audit row. '
  'SELECT ... FOR UPDATE serializes concurrent corrections on an existing row; the UNIQUE constraint '
  'on central_selling_prices is the backstop preventing two concurrent first-sets for a new identity.';

-- seed_central_selling_price(...): the BR-01 seed rule. The first valid
-- withdrawal of a business date establishes the central price automatically
-- — this function NEVER overwrites an existing price (unlike
-- set_central_selling_price, which is the admin correction path). It always
-- returns the row that is authoritative after the call: on a fresh identity
-- that is the just-inserted row; on an identity that already has a price,
-- that is the unchanged existing row (which may differ from p_price_satang
-- — the caller detects this by comparing the two and treats it as a price
-- conflict requiring admin resolution).
--
-- INSERT ... ON CONFLICT DO NOTHING is what makes the race case (two first
-- withdrawals for the same identity landing concurrently) safe without any
-- explicit row lock: Postgres resolves the unique-index conflict atomically,
-- so exactly one caller's INSERT wins and the other observes NOT FOUND.
CREATE OR REPLACE FUNCTION public.seed_central_selling_price(
  p_product_key   text,
  p_unit_key      text,
  p_business_date date,
  p_price_satang  integer,
  p_actor         text,
  p_reason        text
) RETURNS public.central_selling_prices
LANGUAGE plpgsql
AS $$
DECLARE
  v_row public.central_selling_prices;
BEGIN
  IF p_product_key IS NULL OR btrim(p_product_key) = '' THEN
    RAISE EXCEPTION 'product_key must not be empty';
  END IF;
  IF p_unit_key IS NULL OR btrim(p_unit_key) = '' THEN
    RAISE EXCEPTION 'unit_key must not be empty';
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF p_price_satang IS NULL OR p_price_satang < 0 THEN
    RAISE EXCEPTION 'price_satang must be a non-negative integer';
  END IF;

  INSERT INTO public.central_selling_prices
    (product_key, unit_key, business_date, price_satang, set_by, set_reason)
  VALUES
    (p_product_key, p_unit_key, p_business_date, p_price_satang, p_actor, p_reason)
  ON CONFLICT (product_key, unit_key, business_date) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    INSERT INTO public.central_selling_price_corrections
      (price_id, product_key, unit_key, business_date, previous_price_satang, new_price_satang, actor, reason)
    VALUES
      (v_row.id, p_product_key, p_unit_key, p_business_date, NULL, p_price_satang, p_actor, p_reason);
    RETURN v_row;
  END IF;

  SELECT * INTO v_row
  FROM public.central_selling_prices
  WHERE product_key = p_product_key
    AND unit_key = p_unit_key
    AND business_date = p_business_date;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.seed_central_selling_price IS
  'BR-01 seed rule: establishes the central price from the first valid withdrawal of a business date. '
  'Never overwrites an existing price — always returns the authoritative row so the caller can detect '
  'a conflict (returned price differs from the price it attempted to seed).';
