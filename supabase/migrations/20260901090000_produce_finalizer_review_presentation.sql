-- Durable presentation state for a review the FINALIZER discovers.
--
-- THE PROTOCOL FLAW
-- -----------------
-- 20260831120000 let the finalizer park a generation whose document grew past
-- the close boundary into review-required territory, and push the review to
-- the operator. But runProduceFinalizeGate is deliberately READ ONLY: it never
-- presents and never confirms. So the exact review the operator was shown was
-- never persisted as a presented review.
--
-- The operator then needed THREE closes, not two:
--
--   close #1  -> boundary; a late pre-close item changes the document
--               finalizer pushes a review, holds — nothing persisted
--   close #2  -> records that review for the FIRST time, treats itself as the
--               presentation, does not confirm
--   close #3  -> finally confirms
--
-- WHY NOT JUST PERSIST IT BEFORE PUSHING
-- --------------------------------------
-- A LINE push is not transactional with PostgreSQL. Recording a review as
-- "presented" before the push is known to have landed would let the NEXT close
-- confirm content the operator never saw. That is an unauthorized approval of
-- financial data, which is worse than an extra close.
--
-- So presentation is split into two durable facts:
--
--   the review EXISTS            — recorded, digest- and generation-bound
--   the review WAS DELIVERED     — presented_delivered_at, set only after the
--                                  LINE push actually succeeded
--
-- A review may only be confirmed once delivery is proven. Every failure window
-- therefore fails safe:
--
--   record ok, hold fails        -> no delivery proof, nothing can confirm it;
--                                   a changed document computes a new digest
--                                   anyway, so the row cannot approve it
--   hold ok, push fails          -> no delivery proof; the next close
--                                   re-presents (and marks delivery itself)
--                                   rather than confirming unseen content
--   push ok, mark fails          -> no delivery proof; the operator is shown it
--                                   again. Never treated as proven.
--   finalizer retries            -> the identity constraint collapses the same
--                                   digest to one row; a changed document is a
--                                   different digest and a different row
--   redelivery of the presenting
--   event                        -> presented_line_event_id still refuses
--                                   self-confirmation (20260831120000)
--   terminalized generation      -> every entry point below takes the
--                                   pending_sessions row lock first
--
-- LOCK ORDER is unchanged and enforced everywhere:
--   public.pending_sessions BEFORE public.produce_entry_validation_reviews.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.produce_entry_validation_reviews') IS NULL THEN
    RAISE EXCEPTION '20260901090000: produce_entry_validation_reviews is missing; apply P4A first';
  END IF;
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION '20260901090000: public.pending_sessions is missing';
  END IF;
  IF to_regprocedure(
       'public.confirm_produce_validation_review(text,uuid,text,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      '20260901090000: confirm_produce_validation_review is missing; apply 20260831120000 first';
  END IF;
END;
$preflight$;

-- ── 1) Delivery proof ────────────────────────────────────────────────────────

ALTER TABLE public.produce_entry_validation_reviews
  ADD COLUMN IF NOT EXISTS presented_delivered_at timestamptz;

COMMENT ON COLUMN public.produce_entry_validation_reviews.presented_delivered_at IS
  'When this exact review was proven to have reached the operator. NULL means '
  'recorded but NOT yet shown - it must not be confirmable. Set by the webhook '
  'the moment it replies with the review, and by the finalizer only AFTER its '
  'LINE push succeeded.';

-- Backfill, one time. Every pre-existing review was created by the webhook
-- close gate, which records and replies with it in the same request: delivery
-- was proven by construction for all of them. Treating them as undelivered
-- would strand real, already-shown reviews.
UPDATE public.produce_entry_validation_reviews
SET presented_delivered_at = presented_at
WHERE presented_delivered_at IS NULL;

-- ── 2) Webhook path: recording IS presenting ─────────────────────────────────
-- Unchanged semantics, plus delivery proof. The webhook replies with the review
-- in the same request, so recording it and showing it are the same act. When
-- the row already exists but was never delivered (the finalizer recorded it and
-- its push failed), this re-presentation is what finally proves delivery.

CREATE OR REPLACE FUNCTION public.record_produce_validation_review(
  p_session_key             text,
  p_session_generation      uuid,
  p_accountability_round_id uuid,
  p_validation_digest       text,
  p_business_date           date,
  p_market_label            text,
  p_staff_label             text,
  p_exceptions              jsonb,
  p_line_user_id            text,
  p_line_event_id           text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row          public.produce_entry_validation_reviews;
  v_terminalized boolean;
BEGIN
  -- LOCK ORDER: pending_sessions before produce_entry_validation_reviews.
  SELECT terminalized INTO v_terminalized
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
  FOR UPDATE;

  IF v_terminalized THEN
    RETURN jsonb_build_object('status', 'terminalized', 'confirmed', false);
  END IF;

  INSERT INTO public.produce_entry_validation_reviews (
    session_key, session_generation, accountability_round_id, validation_digest,
    business_date, market_label, staff_label, exceptions,
    presented_by_line_user_id, presented_line_event_id, presented_delivered_at
  )
  VALUES (
    p_session_key, p_session_generation, p_accountability_round_id, p_validation_digest,
    p_business_date, p_market_label, p_staff_label, p_exceptions,
    p_line_user_id, p_line_event_id, now()
  )
  ON CONFLICT ON CONSTRAINT produce_entry_validation_reviews_identity DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Existing row. If the finalizer recorded it and never proved delivery,
    -- THIS reply is the delivery. Confirmation state is never touched.
    UPDATE public.produce_entry_validation_reviews r
    SET presented_delivered_at = now()
    WHERE r.session_key = p_session_key
      AND r.session_generation = p_session_generation
      AND r.validation_digest = p_validation_digest
      AND r.presented_delivered_at IS NULL;

    SELECT * INTO v_row
    FROM public.produce_entry_validation_reviews
    WHERE session_key = p_session_key
      AND session_generation = p_session_generation
      AND validation_digest = p_validation_digest;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'confirmed', v_row.confirmed_at IS NOT NULL,
    'confirmed_at', v_row.confirmed_at,
    'presented_line_event_id', v_row.presented_line_event_id,
    'presented_delivered', v_row.presented_delivered_at IS NOT NULL
  );
END;
$$;

-- ── 3) Finalizer path: record WITHOUT claiming delivery ──────────────────────

CREATE OR REPLACE FUNCTION public.record_finalizer_validation_review(
  p_session_key             text,
  p_session_generation      uuid,
  p_accountability_round_id uuid,
  p_validation_digest       text,
  p_business_date           date,
  p_market_label            text,
  p_staff_label             text,
  p_exceptions              jsonb,
  p_line_user_id            text,
  p_presentation_token      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row          public.produce_entry_validation_reviews;
  v_terminalized boolean;
BEGIN
  SELECT terminalized INTO v_terminalized
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
  FOR UPDATE;

  IF v_terminalized THEN
    RETURN jsonb_build_object('status', 'terminalized', 'confirmed', false);
  END IF;

  -- presented_delivered_at is deliberately left NULL: this row exists, but
  -- nothing has shown it to anyone yet.
  INSERT INTO public.produce_entry_validation_reviews (
    session_key, session_generation, accountability_round_id, validation_digest,
    business_date, market_label, staff_label, exceptions,
    presented_by_line_user_id, presented_line_event_id
  )
  VALUES (
    p_session_key, p_session_generation, p_accountability_round_id, p_validation_digest,
    p_business_date, p_market_label, p_staff_label, p_exceptions,
    p_line_user_id, p_presentation_token
  )
  ON CONFLICT ON CONSTRAINT produce_entry_validation_reviews_identity DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row
    FROM public.produce_entry_validation_reviews
    WHERE session_key = p_session_key
      AND session_generation = p_session_generation
      AND validation_digest = p_validation_digest;
  END IF;

  RETURN jsonb_build_object(
    'status', 'recorded',
    'id', v_row.id,
    'confirmed', v_row.confirmed_at IS NOT NULL,
    'presented_line_event_id', v_row.presented_line_event_id,
    'presented_delivered', v_row.presented_delivered_at IS NOT NULL
  );
END;
$$;

-- ── 4) Delivery proof, recorded only after the push landed ───────────────────

CREATE OR REPLACE FUNCTION public.mark_produce_validation_review_presented(
  p_session_key        text,
  p_session_generation uuid,
  p_validation_digest  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row          public.produce_entry_validation_reviews;
  v_terminalized boolean;
BEGIN
  SELECT terminalized INTO v_terminalized
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
  FOR UPDATE;

  IF v_terminalized THEN
    RETURN jsonb_build_object('status', 'terminalized');
  END IF;

  SELECT * INTO v_row
  FROM public.produce_entry_validation_reviews
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
    AND validation_digest = p_validation_digest
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_row.presented_delivered_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_presented');
  END IF;

  UPDATE public.produce_entry_validation_reviews
  SET presented_delivered_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('status', 'presented', 'id', v_row.id);
END;
$$;

-- ── 5) A review nobody has seen cannot be confirmed ──────────────────────────

CREATE OR REPLACE FUNCTION public.confirm_produce_validation_review(
  p_session_key        text,
  p_session_generation uuid,
  p_validation_digest  text,
  p_line_user_id       text,
  p_line_event_id      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row          public.produce_entry_validation_reviews;
  v_terminalized boolean;
BEGIN
  SELECT terminalized INTO v_terminalized
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
  FOR UPDATE;

  IF v_terminalized THEN
    RETURN jsonb_build_object('status', 'terminalized');
  END IF;

  SELECT * INTO v_row
  FROM public.produce_entry_validation_reviews
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
    AND validation_digest = p_validation_digest
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_row.confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_confirmed',
      'id', v_row.id,
      'confirmed_by_line_user_id', v_row.confirmed_by_line_user_id
    );
  END IF;

  -- The operator cannot approve what was never shown to them. A recorded but
  -- undelivered review (finalizer recorded it, its push failed) must be
  -- re-presented before anything may confirm it.
  IF v_row.presented_delivered_at IS NULL THEN
    RETURN jsonb_build_object('status', 'not_presented');
  END IF;

  -- A confirmation must never be the very event that presented the set.
  IF p_line_event_id IS NOT NULL
     AND v_row.presented_line_event_id IS NOT DISTINCT FROM p_line_event_id THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  UPDATE public.produce_entry_validation_reviews
  SET confirmed_at              = now(),
      confirmed_by_line_user_id = p_line_user_id,
      confirmed_line_event_id   = p_line_event_id
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('status', 'confirmed', 'id', v_row.id);
END;
$$;

COMMENT ON FUNCTION public.record_finalizer_validation_review(
  text, uuid, uuid, text, date, text, text, jsonb, text, text
) IS
  'Records the review the finalizer discovered after the close boundary, WITHOUT '
  'claiming it was shown. presented_delivered_at stays NULL until the LINE push '
  'is proven, so nothing can confirm it in the meantime.';

COMMENT ON FUNCTION public.mark_produce_validation_review_presented(text, uuid, text) IS
  'Records proof that this exact review reached the operator. Called only after a '
  'successful LINE push. Refuses a terminalized generation.';

REVOKE ALL ON FUNCTION public.record_finalizer_validation_review(
  text, uuid, uuid, text, date, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_finalizer_validation_review(
  text, uuid, uuid, text, date, text, text, jsonb, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.mark_produce_validation_review_presented(text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_produce_validation_review_presented(text, uuid, text)
  TO service_role;

COMMIT;
