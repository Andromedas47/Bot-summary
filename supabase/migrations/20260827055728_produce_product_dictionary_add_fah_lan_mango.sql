-- Produce Product Code Dictionary — one new code: ม73 = มะม่วงฟ้าลั่น.
--
-- Forward-only, catalog-only, additive. No historical produce_transactions /
-- produce_items / produce_sessions row is read, rewritten or backfilled by
-- this migration. No existing product_code row is touched: this is a single
-- ordinary INSERT, one code past the last released ม-code (ม72 = มะม่วงแก้วขมิ้น,
-- from 20260824090000). The identity guard installed by 20260813090000
-- (produce_product_codes_identity_guard) is never disabled here — unlike
-- 20260818100000, this migration has no rename to make.
--
-- มะม่วงฟ้าลั่น (Fah Lan mango) is a distinct canonical product, not a
-- spelling or a size/color variant of any existing mango entry. It is not
-- folded into มะม่วงจิ้ว (ม63), มะม่วงงาช้าง (ม32), มหาชนก (ม35),
-- มะม่วงแก้วขมิ้น (ม72), or any other ม-row: none of those rows are touched,
-- and no application-layer alias is introduced for it — PRODUCT_ALIASES in
-- src/lib/summary/remaining-fruit.ts folds business identity, not just report
-- labels. Short forms ฟ้าลั่น and มะม่วง would collide with other products
-- (or with an unregistered generic mango), and there is no repository or
-- operator evidence of the kind that justified the ไชมัส→ไซมัส correction or
-- the เขียวมรกต short-form fold in 20260818100000. Absent that evidence, it
-- stays its own code and its own identity. Canonical spelling only.
BEGIN;

-- ── Preflight: fail loudly, mutate nothing until every assumption holds ──────
DO $preflight$
DECLARE
  v_current_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.produce_product_codes WHERE product_code = 'ม73') THEN
    RAISE EXCEPTION
      'produce_product_dictionary_add_fah_lan_mango already applied: ม73 already exists';
  END IF;

  SELECT canonical_name INTO v_current_name
    FROM public.produce_product_codes WHERE product_code = 'ม72';
  IF NOT FOUND OR v_current_name <> 'มะม่วงแก้วขมิ้น' THEN
    RAISE EXCEPTION
      'ม72 is not มะม่วงแก้วขมิ้น (found %) — 20260824090000 is not applied as expected, refusing to issue ม73',
      coalesce(v_current_name, 'NULL');
  END IF;

  -- Prevents creating a duplicate product identity under a second code.
  IF EXISTS (
    SELECT 1 FROM public.produce_product_codes WHERE canonical_name = 'มะม่วงฟ้าลั่น'
  ) THEN
    RAISE EXCEPTION 'มะม่วงฟ้าลั่น already exists under a different product_code';
  END IF;
END;
$preflight$;

-- ── The single new row ────────────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING makes a redeploy a no-op rather than an UPDATE (which
-- the identity guard would refuse anyway).
INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ม73', 'ม', 'ผลไม้', 'มะม่วงฟ้าลั่น', true)
ON CONFLICT (product_code) DO NOTHING;

-- ── Postflight: prove the end state before committing ────────────────────────
DO $postflight$
DECLARE
  v_total    integer;
  v_enabled  integer;
  v_mcount   integer;
  v_m73_name text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE code_enabled)
    INTO v_total, v_enabled
    FROM public.produce_product_codes;

  IF v_total <> 264 OR v_enabled <> 264 THEN
    RAISE EXCEPTION
      'produce_product_codes postflight mismatch: % rows / % enabled, expected 264 / 264',
      v_total, v_enabled;
  END IF;

  SELECT count(*) INTO v_mcount
    FROM public.produce_product_codes WHERE category_code = 'ม';
  IF v_mcount <> 73 THEN
    RAISE EXCEPTION 'ม-category count is %, expected 73', v_mcount;
  END IF;

  SELECT canonical_name INTO v_m73_name
    FROM public.produce_product_codes WHERE product_code = 'ม73';
  IF v_m73_name <> 'มะม่วงฟ้าลั่น' THEN
    RAISE EXCEPTION 'ม73 canonical_name is %, expected มะม่วงฟ้าลั่น', v_m73_name;
  END IF;

  -- Untouched neighbors: the mango codes this product must never be confused
  -- with keep their own unchanged identities.
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม72') <> 'มะม่วงแก้วขมิ้น' THEN
    RAISE EXCEPTION 'ม72 (มะม่วงแก้วขมิ้น) moved — this migration must not touch it';
  END IF;
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม63') <> 'มะม่วงจิ้ว' THEN
    RAISE EXCEPTION 'ม63 (มะม่วงจิ้ว) moved — this migration must not touch it';
  END IF;
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม35') <> 'มหาชนก' THEN
    RAISE EXCEPTION 'ม35 (มหาชนก) moved — this migration must not touch it';
  END IF;
END;
$postflight$;

COMMIT;
