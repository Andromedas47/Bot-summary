-- P1 2026-08-22: ม63 human-facing spelling.
--
-- Forward-only, catalog-only. Historical produce_items named มะม่วงจิ้ว are
-- left as recorded evidence. This migration only corrects what ม63's row in
-- public.produce_product_codes says the canonical spelling is, going forward.
--
-- ม63 was seeded (20260818100000) as มะม่วงจิ้ว (mai tho). Shop-floor and
-- operator typing use มะม่วงจิ๋ว (mai ek). Same product, one code — not two
-- identities. Intake accepts both spellings in application code (approved
-- alias). Reporting folds the mai-tho keying via PRODUCT_ALIASES.
--
-- produce_product_codes_identity_guard cannot tell a reviewed spelling
-- correction from a silent identity rewrite. The guard is disabled only for
-- the single UPDATE below, inside this transaction. A RAISE rolls the
-- DISABLE back; there is no committed state in which the guard is left off.
--
-- Idempotent: a database that already has ม63 = มะม่วงจิ๋ว is a no-op.

BEGIN;

DO $preflight$
DECLARE
  v_name text;
  v_category text;
  v_enabled boolean;
  v_tgenabled "char";
BEGIN
  SELECT tgenabled INTO v_tgenabled
    FROM pg_trigger
    WHERE tgrelid = 'public.produce_product_codes'::regclass
      AND tgname = 'produce_product_codes_identity_guard';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'produce_product_codes_identity_guard is missing — refusing to correct ม63 with no identity guard in place';
  END IF;

  IF v_tgenabled <> 'O' THEN
    RAISE EXCEPTION
      'produce_product_codes_identity_guard is in an unexpected state (tgenabled=%), expected O',
      v_tgenabled;
  END IF;

  SELECT canonical_name, category_code, code_enabled
    INTO v_name, v_category, v_enabled
    FROM public.produce_product_codes
    WHERE product_code = 'ม63';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ม63 is missing — refusing to invent a product identity';
  END IF;

  IF v_name IS DISTINCT FROM 'มะม่วงจิ้ว' AND v_name IS DISTINCT FROM 'มะม่วงจิ๋ว' THEN
    RAISE EXCEPTION
      'ม63 canonical_name is %, expected มะม่วงจิ้ว or already มะม่วงจิ๋ว',
      v_name;
  END IF;

  IF v_category IS DISTINCT FROM 'ม' THEN
    RAISE EXCEPTION 'ม63 category_code is %, expected ม', v_category;
  END IF;

  IF v_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ม63 must remain enabled';
  END IF;
END;
$preflight$;

ALTER TABLE public.produce_product_codes DISABLE TRIGGER produce_product_codes_identity_guard;

DO $rename$
DECLARE
  v_rows integer;
  v_name text;
BEGIN
  SELECT canonical_name INTO v_name
    FROM public.produce_product_codes
    WHERE product_code = 'ม63';

  IF v_name = 'มะม่วงจิ๋ว' THEN
    RETURN;
  END IF;

  UPDATE public.produce_product_codes
  SET canonical_name = 'มะม่วงจิ๋ว',
      updated_at = now()
  WHERE product_code = 'ม63'
    AND canonical_name = 'มะม่วงจิ้ว';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'expected to correct exactly 1 row (ม63), corrected %', v_rows;
  END IF;
END;
$rename$;

ALTER TABLE public.produce_product_codes ENABLE TRIGGER produce_product_codes_identity_guard;

DO $postflight$
DECLARE
  v_name text;
  v_enabled boolean;
  v_tgenabled "char";
BEGIN
  SELECT tgenabled INTO v_tgenabled
    FROM pg_trigger
    WHERE tgrelid = 'public.produce_product_codes'::regclass
      AND tgname = 'produce_product_codes_identity_guard';

  IF v_tgenabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION
      'produce_product_codes_identity_guard is not enabled after ม63 spelling correction (tgenabled=%)',
      v_tgenabled;
  END IF;

  SELECT canonical_name, code_enabled INTO v_name, v_enabled
    FROM public.produce_product_codes
    WHERE product_code = 'ม63';

  IF v_name IS DISTINCT FROM 'มะม่วงจิ๋ว' THEN
    RAISE EXCEPTION 'ม63 canonical_name is %, expected มะม่วงจิ๋ว', v_name;
  END IF;
  IF v_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ม63 must remain enabled';
  END IF;
END;
$postflight$;

COMMIT;
