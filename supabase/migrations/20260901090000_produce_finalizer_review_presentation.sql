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
  'recorded but NOT yet shown - it must not be confirmable. Written ONLY by '
  'mark_produce_validation_review_presented, and only after the LINE reply or '
  'push actually succeeded. Recording a review never sets it: the delivery is a '
  'separate call that can fail.';

-- NO BACKFILL, deliberately.
--
-- An earlier draft set presented_delivered_at = presented_at for every existing
-- row, on the theory that the webhook records and replies in one request. That
-- is not provable: the LINE reply is a separate network call that is caught and
-- logged, so a historical row may have been recorded and never shown. Stamping
-- delivery across all of them would manufacture evidence that a human being saw
-- financial exceptions they may never have seen.
--
-- Existing rows therefore stay NULL and are re-presented before anything can
-- confirm them. Rows that were already confirmed keep confirmed_at, which
-- records their historical outcome, and confirm_ returns already_confirmed
-- before it ever reaches the delivery check — so no past decision is disturbed.

-- ── 2) Recording a review NEVER claims it was delivered ──────────────────────
--
-- Recording is a database write; delivering is a LINE call that happens later
-- and can fail. The webhook's reply is caught and logged, so "we wrote the row"
-- is not evidence that anyone saw it. Only
-- mark_produce_validation_review_presented, called AFTER a successful reply or
-- push, may stamp delivery.

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
    presented_by_line_user_id, presented_line_event_id
  )
  VALUES (
    p_session_key, p_session_generation, p_accountability_round_id, p_validation_digest,
    p_business_date, p_market_label, p_staff_label, p_exceptions,
    p_line_user_id, p_line_event_id
  )
  ON CONFLICT ON CONSTRAINT produce_entry_validation_reviews_identity DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Existing row: return it untouched. Delivery state and confirmation state
    -- both belong to other functions.
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

-- ── 3) One recorder, not two ────────────────────────────────────────────────
--
-- An earlier draft added a separate record_finalizer_validation_review that
-- inserted the row WITHOUT delivery proof, while the webhook recorder stamped
-- delivery inline. Now that recording never claims delivery, the two are the
-- same operation and a second copy could only drift from the first. The
-- finalizer calls record_produce_validation_review above and passes its stable
-- synthetic token as the presenting event id.

-- ── 4) Delivery proof, recorded only after the push landed ───────────────────

-- One LINE message may present SEVERAL review rows: the whole-review row plus
-- one row per risky subunit item (#109 confirms those individually, by their
-- own digests). Delivery proof for that message is therefore a set, and it must
-- be all-or-nothing — a half-marked message would leave some exceptions
-- confirmable and others not, from a single thing the operator saw once.
--
-- Every requested digest must already exist for this generation. A digest that
-- does not is a caller bug, not something to partially apply, so the whole call
-- refuses.
CREATE OR REPLACE FUNCTION public.mark_produce_validation_reviews_presented(
  p_session_key             text,
  p_session_generation      uuid,
  p_validation_digests      text[],
  p_presented_line_event_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_terminalized boolean;
  v_requested    integer;
  v_found        integer;
  v_marked       integer;
BEGIN
  IF p_validation_digests IS NULL OR array_length(p_validation_digests, 1) IS NULL THEN
    RETURN jsonb_build_object('status', 'no_digests', 'marked', 0);
  END IF;

  IF p_presented_line_event_id IS NULL OR btrim(p_presented_line_event_id) = '' THEN
    RETURN jsonb_build_object('status', 'invalid_presentation_event', 'marked', 0);
  END IF;

  -- LOCK ORDER: pending_sessions before produce_entry_validation_reviews.
  SELECT terminalized INTO v_terminalized
  FROM public.pending_sessions
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
  FOR UPDATE;

  IF v_terminalized THEN
    RETURN jsonb_build_object('status', 'terminalized', 'marked', 0);
  END IF;

  SELECT count(DISTINCT d) INTO v_requested
  FROM unnest(p_validation_digests) AS d;

  -- Lock the target rows first. FOR UPDATE cannot be combined with an
  -- aggregate, so the lock and the count are separate statements; the count
  -- below is stable because this transaction now holds those row locks.
  PERFORM 1
  FROM public.produce_entry_validation_reviews r
  WHERE r.session_key = p_session_key
    AND r.session_generation = p_session_generation
    AND r.validation_digest = ANY (p_validation_digests)
  FOR UPDATE;

  SELECT count(*) INTO v_found
  FROM public.produce_entry_validation_reviews r
  WHERE r.session_key = p_session_key
    AND r.session_generation = p_session_generation
    AND r.validation_digest = ANY (p_validation_digests);

  IF v_found <> v_requested THEN
    -- Refuse the whole message rather than proving delivery for a subset.
    RETURN jsonb_build_object(
      'status', 'unknown_digest', 'marked', 0,
      'requested', v_requested, 'found', v_found
    );
  END IF;

  -- Idempotent: an already-delivered row keeps its original presenting event.
  WITH updated AS (
    UPDATE public.produce_entry_validation_reviews r
    SET presented_delivered_at = now(),
        presented_line_event_id = p_presented_line_event_id
    WHERE r.session_key = p_session_key
      AND r.session_generation = p_session_generation
      AND r.validation_digest = ANY (p_validation_digests)
      AND r.presented_delivered_at IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_marked FROM updated;

  RETURN jsonb_build_object(
    'status', 'presented',
    'marked', v_marked,
    'requested', v_requested
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_produce_validation_review_presented(
  p_session_key             text,
  p_session_generation      uuid,
  p_validation_digest       text,
  p_presented_line_event_id text
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
    RETURN jsonb_build_object(
      'status', 'already_presented',
      'presented_line_event_id', v_row.presented_line_event_id
    );
  END IF;

  IF p_presented_line_event_id IS NULL OR btrim(p_presented_line_event_id) = '' THEN
    RETURN jsonb_build_object('status', 'invalid_presentation_event');
  END IF;

  -- presented_line_event_id is REBOUND to the event that actually delivered.
  --
  -- Close #1 records the row and its reply fails, so the row carries Close #1's
  -- id but was never shown. Close #2 re-presents successfully. If the id stayed
  -- Close #1's, a duplicate delivery of Close #2 would look like a distinct
  -- later event and self-confirm content shown exactly once. The stored
  -- identity must always be the one that caused the PROVEN presentation.
  UPDATE public.produce_entry_validation_reviews
  SET presented_delivered_at = now(),
      presented_line_event_id = p_presented_line_event_id
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'status', 'presented',
    'id', v_row.id,
    'presented_line_event_id', v_row.presented_line_event_id
  );
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


COMMENT ON FUNCTION public.mark_produce_validation_review_presented(text, uuid, text, text) IS
  'Records proof that this exact review reached the operator. Called only after a '
  'successful LINE push. Refuses a terminalized generation.';


COMMENT ON FUNCTION public.mark_produce_validation_reviews_presented(text, uuid, text[], text) IS
  'Delivery proof for ONE LINE message that presented several review rows - the '
  'whole review plus its per-item subunit rows. All-or-nothing: an unknown digest '
  'refuses the whole call rather than half-authorizing a single message.';

REVOKE ALL ON FUNCTION public.mark_produce_validation_reviews_presented(text, uuid, text[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_produce_validation_reviews_presented(text, uuid, text[], text)
  TO service_role;

REVOKE ALL ON FUNCTION public.mark_produce_validation_review_presented(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_produce_validation_review_presented(text, uuid, text, text)
  TO service_role;

COMMIT;
