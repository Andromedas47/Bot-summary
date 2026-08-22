-- Produce Product Code Dictionary — issue ม72 for พุทราจีน.
--
-- Forward-only, catalog-only. No historical produce_transactions / produce_items
-- / produce_sessions row is read, rewritten or backfilled by this migration.
--
-- ม72 is a new stable code, one past the last released ม-code (ม71 = ลิ้นจี่).
-- พุทราจีน is a distinct product from ม25 พุทรา, ม26 พุทราไทย, ม27 พุทรานม and
-- ม28 พุทรานมสด. No alias is introduced between those names.
--
-- 20260818100000 is already on main with later migrations after it, so it
-- cannot be extended. This is a new forward INSERT. The identity guard is not
-- touched: no existing code is renamed, disabled, or reissued.
BEGIN;

-- ── Preflight: fail loudly, mutate nothing until every assumption holds ──────
DO $preflight$
DECLARE
  v_m25 text;
  v_m26 text;
  v_m27 text;
  v_m28 text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.produce_product_codes WHERE product_code = 'ม71'
  ) THEN
    RAISE EXCEPTION 'ม71 does not exist — 20260818100000 is not applied';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.produce_product_codes WHERE product_code = 'ม72'
  ) THEN
    RAISE EXCEPTION
      'produce_product_dictionary_chinese_jujube already applied: ม72 already exists';
  END IF;

  -- Prevents creating a duplicate product identity under a second code.
  IF EXISTS (
    SELECT 1 FROM public.produce_product_codes WHERE canonical_name = 'พุทราจีน'
  ) THEN
    RAISE EXCEPTION
      'พุทราจีน already exists under a different product_code';
  END IF;

  SELECT canonical_name INTO v_m25 FROM public.produce_product_codes WHERE product_code = 'ม25';
  SELECT canonical_name INTO v_m26 FROM public.produce_product_codes WHERE product_code = 'ม26';
  SELECT canonical_name INTO v_m27 FROM public.produce_product_codes WHERE product_code = 'ม27';
  SELECT canonical_name INTO v_m28 FROM public.produce_product_codes WHERE product_code = 'ม28';

  IF v_m25 IS DISTINCT FROM 'พุทรา'
     OR v_m26 IS DISTINCT FROM 'พุทราไทย'
     OR v_m27 IS DISTINCT FROM 'พุทรานม'
     OR v_m28 IS DISTINCT FROM 'พุทรานมสด' THEN
    RAISE EXCEPTION
      'pre-existing พุทรา* codes drifted before insert: ม25=% ม26=% ม27=% ม28=%',
      v_m25, v_m26, v_m27, v_m28;
  END IF;
END;
$preflight$;

-- Ordinary new row, no guard involvement. ON CONFLICT is belt-and-braces: the
-- preflight already refuses a second apply, and the identity guard would refuse
-- an UPDATE of an existing code anyway.
INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ม72', 'ม', 'ผลไม้', 'พุทราจีน', true)
ON CONFLICT (product_code) DO NOTHING;

-- ── Postflight: prove the end state before committing ────────────────────────
DO $postflight$
DECLARE
  v_total   integer;
  v_enabled integer;
  v_mcount  integer;
  v_name    text;
  v_cat     text;
  v_enabled_flag boolean;
  v_m25 text;
  v_m26 text;
  v_m27 text;
  v_m28 text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE code_enabled)
    INTO v_total, v_enabled
    FROM public.produce_product_codes;

  IF v_total <> 263 OR v_enabled <> 263 THEN
    RAISE EXCEPTION
      'produce_product_codes postflight mismatch: % rows / % enabled, expected 263 / 263',
      v_total, v_enabled;
  END IF;

  SELECT count(*) INTO v_mcount
    FROM public.produce_product_codes WHERE category_code = 'ม';
  IF v_mcount <> 72 THEN
    RAISE EXCEPTION 'ม-category count is %, expected 72', v_mcount;
  END IF;

  SELECT canonical_name, category_name, code_enabled
    INTO v_name, v_cat, v_enabled_flag
    FROM public.produce_product_codes WHERE product_code = 'ม72';

  IF v_name IS DISTINCT FROM 'พุทราจีน'
     OR v_cat IS DISTINCT FROM 'ผลไม้'
     OR v_enabled_flag IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'ม72 is % / % / %, expected พุทราจีน / ผลไม้ / true',
      v_name, v_cat, v_enabled_flag;
  END IF;

  SELECT canonical_name INTO v_m25 FROM public.produce_product_codes WHERE product_code = 'ม25';
  SELECT canonical_name INTO v_m26 FROM public.produce_product_codes WHERE product_code = 'ม26';
  SELECT canonical_name INTO v_m27 FROM public.produce_product_codes WHERE product_code = 'ม27';
  SELECT canonical_name INTO v_m28 FROM public.produce_product_codes WHERE product_code = 'ม28';

  IF v_m25 IS DISTINCT FROM 'พุทรา'
     OR v_m26 IS DISTINCT FROM 'พุทราไทย'
     OR v_m27 IS DISTINCT FROM 'พุทรานม'
     OR v_m28 IS DISTINCT FROM 'พุทรานมสด' THEN
    RAISE EXCEPTION
      'pre-existing พุทรา* codes were mutated: ม25=% ม26=% ม27=% ม28=%',
      v_m25, v_m26, v_m27, v_m28;
  END IF;
END;
$postflight$;

COMMIT;
