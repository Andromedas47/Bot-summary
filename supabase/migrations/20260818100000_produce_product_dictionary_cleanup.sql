-- Produce Product Code Dictionary — a spelling correction and six new codes.
--
-- Forward-only, catalog-only. No historical produce_transactions / produce_items
-- / produce_sessions row is read, rewritten or backfilled by this migration.
-- Every transaction already recorded against ม54 under the misspelling ไชมัส
-- stays exactly as it was keyed — that history is not touched, not re-labeled,
-- and not re-aggregated here. This migration only changes what ม54's row in
-- public.produce_product_codes SAYS the canonical spelling is, going forward.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What changed and why
-- ─────────────────────────────────────────────────────────────────────────────
-- ม54 was seeded (20260813090000) with canonical_name = 'ไชมัส'. That was a
-- misspelling of the real operational product name, 'ไซมัส' (Shine Muscat
-- grape). Both spellings are attested live in Production in the SAME
-- accountability session on 2026-08-16, at the identical unit (โล) and the
-- identical price (60.00) — 184 uses of ไซมัส against 109 of ไชมัส. That is one
-- product weighed and sold under two keyings by different operators typing the
-- same word by ear, not two products. This migration corrects the dictionary
-- row to the spelling that is actually correct Thai for the product and is
-- already the majority spelling on the floor.
--
-- Six previously-unissued codes (ม63–ม68) are also seeded here, one migration
-- past the last released ม-code (ม62 = แอปเปิ้ล). They are ordinary new
-- dictionary rows — no identity question, no guard bypass, just an INSERT.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the identity guard is bypassed for exactly ONE row, narrowly
-- ─────────────────────────────────────────────────────────────────────────────
-- produce_product_codes_identity_guard (20260813090000) exists to stop a code
-- being silently repointed at a DIFFERENT product — that would rewrite the
-- identity of every transaction already keyed by it. This is not that. This is
-- a reviewed correction of a misspelling of the SAME product, and the guard
-- cannot itself tell the two apart: it sees only "canonical_name changed",
-- never "changed to a correction of the same product" versus "changed to a
-- different product". That distinction is a human judgement call, made once
-- here, reviewed, and scoped to a single UPDATE guarded by preflight assertions
-- before the trigger is touched at all. The trigger is disabled only for the
-- statements between the two ALTER TABLE lines below, inside this one
-- transaction — a RAISE anywhere in this block aborts the whole transaction,
-- so there is no committed state in which the guard is left disabled.
--
-- The pre-dictionary-correction spelling ไชมัส is preserved as a reporting
-- alias in src/lib/summary/remaining-fruit.ts (PRODUCT_ALIASES), which folds
-- both spellings into one identity for reporting, business-fingerprint dedup
-- and P4A return-matching — the same mechanism already used for อะโวคาโด้ →
-- อะโวคาโด. That is a separate, application-level change; nothing here reaches
-- into produce_transactions to apply it retroactively.
BEGIN;

-- ── Preflight: fail loudly, mutate nothing until every assumption holds ──────
DO $preflight$
DECLARE
  v_current_name text;
  v_current_category text;
BEGIN
  SELECT canonical_name, category_code
    INTO v_current_name, v_current_category
    FROM public.produce_product_codes
    WHERE product_code = 'ม54';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ม54 does not exist — 20260813090000 is not applied';
  END IF;

  IF v_current_name = 'ไซมัส' AND EXISTS (
    SELECT 1 FROM public.produce_product_codes WHERE product_code IN
      ('ม63', 'ม64', 'ม65', 'ม66', 'ม67', 'ม68')
  ) THEN
    RAISE EXCEPTION
      'produce_product_dictionary_cleanup already applied: ม54 is already ไซมัส and ม63-ม68 already exist';
  END IF;

  IF v_current_name <> 'ไชมัส' THEN
    RAISE EXCEPTION
      'ม54 canonical_name is % , expected ไชมัส — someone already changed it or the row is in an unexpected state',
      v_current_name;
  END IF;
  IF v_current_category <> 'ม' THEN
    RAISE EXCEPTION 'ม54 category_code is %, expected ม', v_current_category;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.produce_product_codes
    WHERE product_code IN ('ม63', 'ม64', 'ม65', 'ม66', 'ม67', 'ม68')
  ) THEN
    RAISE EXCEPTION 'one or more of ม63-ม68 already exist — refusing to reissue a code';
  END IF;

  -- Prevents creating a duplicate product identity under a second code: none
  -- of the six new canonical names may already exist under ANY product_code.
  IF EXISTS (
    SELECT 1 FROM public.produce_product_codes
    WHERE canonical_name IN (
      'มะม่วงจิ้ว', 'ลูกพีชเล็ก', 'ลูกพีชใหญ่', 'ลูกไหนเขียว', 'ลูกไหนดำ', 'องุ่นคิมสัน'
    )
  ) THEN
    RAISE EXCEPTION
      'one of the six new canonical names already exists under a different product_code';
  END IF;
END;
$preflight$;

-- ── The single reviewed correction ───────────────────────────────────────────
-- Narrowly and temporarily disabling the named trigger, for exactly one
-- UPDATE, inside this transaction. If anything below raises, the whole
-- transaction — including the DISABLE — rolls back, so the guard can never be
-- observed disabled outside this block.
ALTER TABLE public.produce_product_codes DISABLE TRIGGER produce_product_codes_identity_guard;

DO $rename$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.produce_product_codes
  SET canonical_name = 'ไซมัส',
      updated_at = now()
  WHERE product_code = 'ม54'
    AND canonical_name = 'ไชมัส';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'expected to correct exactly 1 row (ม54), corrected %', v_rows;
  END IF;
END;
$rename$;

ALTER TABLE public.produce_product_codes ENABLE TRIGGER produce_product_codes_identity_guard;

-- ── Six new codes, ordinary rows, no guard involvement ───────────────────────
-- ON CONFLICT DO NOTHING makes a redeploy a no-op rather than an UPDATE (which
-- the identity guard would refuse anyway now that it is re-armed above).
INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ม63', 'ม', 'ผลไม้', 'มะม่วงจิ้ว', true),
  ('ม64', 'ม', 'ผลไม้', 'ลูกพีชเล็ก', true),
  ('ม65', 'ม', 'ผลไม้', 'ลูกพีชใหญ่', true),
  ('ม66', 'ม', 'ผลไม้', 'ลูกไหนเขียว', true),
  ('ม67', 'ม', 'ผลไม้', 'ลูกไหนดำ', true),
  ('ม68', 'ม', 'ผลไม้', 'องุ่นคิมสัน', true)
ON CONFLICT (product_code) DO NOTHING;

-- ── Postflight: prove the end state before committing ────────────────────────
DO $postflight$
DECLARE
  v_total   integer;
  v_enabled integer;
  v_mcount  integer;
  v_m54_name text;
  v_tgenabled "char";
BEGIN
  SELECT count(*), count(*) FILTER (WHERE code_enabled)
    INTO v_total, v_enabled
    FROM public.produce_product_codes;

  IF v_total <> 259 OR v_enabled <> 259 THEN
    RAISE EXCEPTION
      'produce_product_codes postflight mismatch: % rows / % enabled, expected 259 / 259',
      v_total, v_enabled;
  END IF;

  SELECT count(*) INTO v_mcount
    FROM public.produce_product_codes WHERE category_code = 'ม';
  IF v_mcount <> 68 THEN
    RAISE EXCEPTION 'ม-category count is %, expected 68', v_mcount;
  END IF;

  SELECT canonical_name INTO v_m54_name
    FROM public.produce_product_codes WHERE product_code = 'ม54';
  IF v_m54_name <> 'ไซมัส' THEN
    RAISE EXCEPTION 'ม54 canonical_name is %, expected ไซมัส', v_m54_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('ม63', 'มะม่วงจิ้ว'),
      ('ม64', 'ลูกพีชเล็ก'),
      ('ม65', 'ลูกพีชใหญ่'),
      ('ม66', 'ลูกไหนเขียว'),
      ('ม67', 'ลูกไหนดำ'),
      ('ม68', 'องุ่นคิมสัน')
    ) AS expected(code, name)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.produce_product_codes p
      WHERE p.product_code = expected.code AND p.canonical_name = expected.name
    )
  ) THEN
    RAISE EXCEPTION 'one or more of ม63-ม68 do not resolve to their expected canonical name';
  END IF;

  -- The guard must be re-armed. Query pg_trigger directly rather than trusting
  -- the ALTER TABLE ... ENABLE statement above ran and was not itself undone.
  SELECT tgenabled INTO v_tgenabled
    FROM pg_trigger
    WHERE tgrelid = 'public.produce_product_codes'::regclass
      AND tgname = 'produce_product_codes_identity_guard';

  IF v_tgenabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION
      'produce_product_codes_identity_guard is not enabled after cleanup (tgenabled=%)',
      v_tgenabled;
  END IF;
END;
$postflight$;

COMMIT;
