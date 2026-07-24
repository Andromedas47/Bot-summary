-- Persist authoritative market attribution on slip evidences for market-scoped
-- verified-transfer totals (Digital White Sheet).
--
-- market_label comes from slip_batches.market_name at attach time (operator slip-
-- session header). market_label_normalized uses trim + Unicode NFC — equivalent
-- to the application path displayMarketName(...).normalize("NFC").trim() for
-- slip-session header market names, which are already isolated market tokens.
--
-- Rows with no batch, a batch with NULL market_name, or otherwise unrecoverable
-- market remain NULL (intentionally unresolved — never guessed).

ALTER TABLE public.slip_evidences
  ADD COLUMN market_label            text,
  ADD COLUMN market_label_normalized text;

COMMENT ON COLUMN public.slip_evidences.market_label IS
  'Raw market name copied from slip_batches.market_name when evidence is attached.';
COMMENT ON COLUMN public.slip_evidences.market_label_normalized IS
  'Normalized market identity for White Sheet financial scoping. NULL means unresolved.';

CREATE INDEX slip_evidences_market_lookup_idx
  ON public.slip_evidences (source_id, market_label_normalized)
  WHERE market_label_normalized IS NOT NULL;

-- Backfill only when authoritative batch metadata exists.
UPDATE public.slip_evidences se
SET
  market_label            = btrim(b.market_name),
  market_label_normalized = btrim(normalize(btrim(b.market_name), NFC))
FROM public.slip_batches b
WHERE se.batch_id = b.id
  AND b.market_name IS NOT NULL
  AND btrim(b.market_name) <> '';

-- Replace attach RPC so new evidences inherit market from the parent batch.
CREATE OR REPLACE FUNCTION public.attach_evidence_to_slip_batch(
  p_batch_id    uuid,
  p_evidence_id uuid
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_index   integer;
  v_market_label  text;
  v_market_norm   text;
BEGIN
  SELECT btrim(b.market_name)
  INTO v_market_label
  FROM public.slip_batches b
  WHERE b.id = p_batch_id;

  IF v_market_label IS NOT NULL AND btrim(v_market_label) <> '' THEN
    v_market_norm := btrim(normalize(btrim(v_market_label), NFC));
  ELSE
    v_market_label := NULL;
    v_market_norm  := NULL;
  END IF;

  UPDATE public.slip_batches
  SET image_count   = image_count + 1,
      last_image_at = now()
  WHERE id = p_batch_id AND status IN ('collecting', 'closing')
  RETURNING image_count INTO v_batch_index;

  IF v_batch_index IS NULL THEN
    RAISE EXCEPTION 'slip_batch % not found or not in collecting/closing status', p_batch_id;
  END IF;

  UPDATE public.slip_evidences
  SET batch_id                = p_batch_id,
      batch_index             = v_batch_index,
      market_label            = v_market_label,
      market_label_normalized = v_market_norm
  WHERE id = p_evidence_id;

  RETURN v_batch_index;
END;
$$;
