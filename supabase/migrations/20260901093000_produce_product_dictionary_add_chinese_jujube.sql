-- Produce Product Code Dictionary — one new code: ม74 = พุทราจีน.
--
-- Forward-only, catalog-only, additive. No historical produce_transactions /
-- produce_items / produce_sessions row is read, rewritten or backfilled by
-- this migration. No existing product_code row is touched: this is a single
-- ordinary INSERT, one code past the last released ม-code (ม73 = มะม่วงฟ้าลั่น,
-- from 20260827055728). The identity guard installed by 20260813115826
-- (produce_product_codes_identity_guard) is never disabled here: this
-- migration has no rename to make.
--
-- พุทราจีน (Chinese jujube) is a DISTINCT canonical product. It is deliberately
-- NOT folded into, aliased to, or treated as a spelling variant of any existing
-- jujube row:
--
--   ม25 พุทรา        ม26 พุทราไทย
--   ม27 พุทรานม      ม28 พุทรานมสด
--
-- None of those rows is touched, and no application-layer alias is introduced.
-- PRODUCT_ALIASES in src/lib/summary/remaining-fruit.ts folds BUSINESS
-- IDENTITY, not just report labels, so an alias there would silently merge this
-- product's stock and money with a different one. A short form พุทรา would
-- collide with ม25 outright. Absent operator evidence of the kind that
-- justified the ไชมัส→ไซมัส correction in 20260818105651, it stays its own code
-- and its own identity. Canonical spelling only.

BEGIN;

-- ── Preflight: fail loudly, mutate nothing until every assumption holds ──────
DO $preflight$
DECLARE
  v_current_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.produce_product_codes WHERE product_code = 'ม74') THEN
    RAISE EXCEPTION
      'produce_product_dictionary_add_chinese_jujube already applied: ม74 already exists';
  END IF;

  SELECT canonical_name INTO v_current_name
    FROM public.produce_product_codes WHERE product_code = 'ม73';
  IF NOT FOUND OR v_current_name <> 'มะม่วงฟ้าลั่น' THEN
    RAISE EXCEPTION
      'ม73 is not มะม่วงฟ้าลั่น (found %) — 20260827055728 is not applied as expected, refusing to issue ม74',
      coalesce(v_current_name, 'NULL');
  END IF;

  -- Prevents creating a duplicate product identity under a second code.
  IF EXISTS (
    SELECT 1 FROM public.produce_product_codes WHERE canonical_name = 'พุทราจีน'
  ) THEN
    RAISE EXCEPTION 'พุทราจีน already exists under a different product_code';
  END IF;

  -- The four existing jujube identities must be exactly where this migration
  -- believes they are; otherwise the "distinct product" claim is unverified.
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม25') <> 'พุทรา'
     OR (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม26') <> 'พุทราไทย'
     OR (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม27') <> 'พุทรานม'
     OR (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม28') <> 'พุทรานมสด' THEN
    RAISE EXCEPTION
      'the existing jujube rows ม25-ม28 are not as expected — refusing to add a fifth jujube identity blind';
  END IF;
END;
$preflight$;

-- ── The single new row ────────────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING makes a redeploy a no-op rather than an UPDATE (which
-- the identity guard would refuse anyway).
INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ม74', 'ม', 'ผลไม้', 'พุทราจีน', true)
ON CONFLICT (product_code) DO NOTHING;

-- ── Postflight: prove the end state before committing ────────────────────────
DO $postflight$
DECLARE
  v_total    integer;
  v_enabled  integer;
  v_mcount   integer;
  v_m74_name text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE code_enabled)
    INTO v_total, v_enabled
    FROM public.produce_product_codes;

  IF v_total <> 265 OR v_enabled <> 265 THEN
    RAISE EXCEPTION
      'produce_product_codes postflight mismatch: % rows / % enabled, expected 265 / 265',
      v_total, v_enabled;
  END IF;

  SELECT count(*) INTO v_mcount
    FROM public.produce_product_codes WHERE category_code = 'ม';
  IF v_mcount <> 74 THEN
    RAISE EXCEPTION 'ม-category count is %, expected 74', v_mcount;
  END IF;

  SELECT canonical_name INTO v_m74_name
    FROM public.produce_product_codes WHERE product_code = 'ม74';
  IF v_m74_name <> 'พุทราจีน' THEN
    RAISE EXCEPTION 'ม74 canonical_name is %, expected พุทราจีน', v_m74_name;
  END IF;

  -- Untouched neighbours: every existing jujube keeps its own identity. If any
  -- of these moved, this migration merged two products and must not commit.
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม25') <> 'พุทรา' THEN
    RAISE EXCEPTION 'ม25 (พุทรา) moved — this migration must not touch it';
  END IF;
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม26') <> 'พุทราไทย' THEN
    RAISE EXCEPTION 'ม26 (พุทราไทย) moved — this migration must not touch it';
  END IF;
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม27') <> 'พุทรานม' THEN
    RAISE EXCEPTION 'ม27 (พุทรานม) moved — this migration must not touch it';
  END IF;
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม28') <> 'พุทรานมสด' THEN
    RAISE EXCEPTION 'ม28 (พุทรานมสด) moved — this migration must not touch it';
  END IF;
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม73') <> 'มะม่วงฟ้าลั่น' THEN
    RAISE EXCEPTION 'ม73 (มะม่วงฟ้าลั่น) moved — this migration must not touch it';
  END IF;
END;
$postflight$;

COMMIT;
