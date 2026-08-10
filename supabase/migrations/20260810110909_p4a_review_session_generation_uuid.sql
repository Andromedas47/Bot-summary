-- P4A Production repair: pending_sessions has used UUID generations since
-- 0042, but the validation-review audit was created with bigint identity.
-- Production had no review rows before this migration. Refuse rather than
-- inventing a UUID mapping if that precondition ever stops being true.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.produce_entry_validation_reviews LIMIT 1) THEN
    RAISE EXCEPTION
      'P4A: validation review generation migration requires an empty audit table';
  END IF;

  PERFORM 1
  FROM pg_attribute
  WHERE attrelid = 'public.produce_entry_validation_reviews'::regclass
    AND attname = 'session_generation'
    AND NOT attisdropped
    AND format_type(atttypid, atttypmod) = 'bigint';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P4A: expected validation review generation bigint';
  END IF;
END $$;

DROP FUNCTION public.record_produce_validation_review(
  text, bigint, uuid, text, date, text, text, jsonb, text, text
);
DROP FUNCTION public.confirm_produce_validation_review(
  text, bigint, text, text, text
);

ALTER TABLE public.produce_entry_validation_reviews
  DROP CONSTRAINT produce_entry_validation_reviews_session_generation_check,
  ALTER COLUMN session_generation TYPE uuid
    USING session_generation::text::uuid;

COMMENT ON COLUMN public.produce_entry_validation_reviews.session_generation IS
  'Exact pending_sessions UUID generation shared by guided and plain-text P4A sessions.';

CREATE FUNCTION public.record_produce_validation_review(
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
  v_row public.produce_entry_validation_reviews;
BEGIN
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
    SELECT * INTO v_row
    FROM public.produce_entry_validation_reviews
    WHERE session_key = p_session_key
      AND session_generation = p_session_generation
      AND validation_digest = p_validation_digest;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'confirmed', v_row.confirmed_at IS NOT NULL,
    'presented_line_event_id', v_row.presented_line_event_id
  );
END;
$$;

CREATE FUNCTION public.confirm_produce_validation_review(
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
  v_row public.produce_entry_validation_reviews;
BEGIN
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

  IF v_row.presented_line_event_id = p_line_event_id THEN
    RETURN jsonb_build_object('status', 'same_event', 'id', v_row.id);
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

REVOKE ALL ON FUNCTION public.record_produce_validation_review(
  text, uuid, uuid, text, date, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_produce_validation_review(
  text, uuid, uuid, text, date, text, text, jsonb, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_produce_validation_review(
  text, uuid, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_produce_validation_review(
  text, uuid, text, text, text
) TO service_role;
