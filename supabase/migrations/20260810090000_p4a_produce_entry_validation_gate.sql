-- P4A: produce entry validation gate — review/override audit.
--
-- Additive and read-only towards every existing contract. This file adds ONE
-- append-only audit table plus the two SECURITY DEFINER RPCs that write it.
--
-- It writes no produce row, no inventory movement, no cost line and no
-- profitability snapshot, and it changes no existing view, function or
-- constraint. An old app that knows nothing about this table keeps working
-- unchanged: the gate is enforced in the application layer, so the table is
-- pure provenance for a decision the operator already made explicitly.
--
-- What is audited here is exactly one class of decision: a return line whose
-- price is not among the withdrawal prices known for the same round, product
-- and unit, which the operator confirmed as an intentional price change.
-- Recording that confirmation means "this data entry is deliberate". It does
-- NOT certify money attribution — P1/P2/P3 accounting keeps its own
-- INCOMPLETE/CERTIFIED semantics and is untouched by this file.

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'accountability_rounds', 'pending_sessions', 'produce_sessions', 'produce_items'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'P4A: required table public.% is missing', v_table;
    END IF;
  END LOOP;
END $$;

-- ── Review / override audit ─────────────────────────────────────────────────

CREATE TABLE public.produce_entry_validation_reviews (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Session identity, the same pair every produce contract keys on. Not a
  -- descriptive tuple: two rounds may share market, seller and date.
  session_key               text        NOT NULL
    CHECK (length(btrim(session_key)) > 0),
  session_generation        bigint      NOT NULL CHECK (session_generation > 0),

  -- Economic identity when the session carries one. NULL is legacy/unbound and
  -- is never inferred from descriptive fields.
  accountability_round_id   uuid        REFERENCES public.accountability_rounds(id),

  -- Immutable fingerprint of the exact exception set that was shown to the
  -- operator. A session whose content changed produces a different digest, so
  -- a confirmation can never silently approve data nobody looked at.
  validation_digest         text        NOT NULL CHECK (validation_digest ~ '^[0-9a-f]{64}$'),

  -- Descriptive provenance. Reporting/audit only — never a join key.
  business_date             date,
  market_label              text,
  -- The seller/market worker the round belongs to.
  staff_label               text,

  -- The exceptions exactly as presented: entered price, the withdrawal prices
  -- known at validation time, product, unit, quantity.
  exceptions                jsonb       NOT NULL
    CHECK (jsonb_typeof(exceptions) = 'array' AND jsonb_array_length(exceptions) > 0),

  -- The data-entry actor who was shown the review. Distinct from staff_label:
  -- the person typing into LINE is often not the seller.
  presented_by_line_user_id text        NOT NULL
    CHECK (length(btrim(presented_by_line_user_id)) > 0),
  presented_line_event_id   text        NOT NULL
    CHECK (length(btrim(presented_line_event_id)) > 0),
  presented_at              timestamptz NOT NULL DEFAULT now(),

  -- Set exactly once, by the explicit confirmation. NULL means the exceptions
  -- were shown and never acknowledged — such a session must not finalize.
  confirmed_at              timestamptz,
  confirmed_by_line_user_id text        CHECK (
    confirmed_by_line_user_id IS NULL OR length(btrim(confirmed_by_line_user_id)) > 0
  ),
  confirmed_line_event_id   text        CHECK (
    confirmed_line_event_id IS NULL OR length(btrim(confirmed_line_event_id)) > 0
  ),

  CONSTRAINT produce_entry_validation_reviews_confirm_actor_pair CHECK (
    (confirmed_at IS NULL) = (confirmed_by_line_user_id IS NULL)
  ),
  CONSTRAINT produce_entry_validation_reviews_confirm_event_pair CHECK (
    (confirmed_at IS NULL) = (confirmed_line_event_id IS NULL)
  ),

  -- Idempotency: one row per (session generation, exception set). A duplicate
  -- LINE delivery of the same close or the same confirmation collapses onto it.
  CONSTRAINT produce_entry_validation_reviews_identity
    UNIQUE (session_key, session_generation, validation_digest)
);

CREATE INDEX produce_entry_validation_reviews_round_idx
  ON public.produce_entry_validation_reviews (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;

CREATE INDEX produce_entry_validation_reviews_pending_idx
  ON public.produce_entry_validation_reviews (business_date)
  WHERE confirmed_at IS NULL;

COMMENT ON TABLE public.produce_entry_validation_reviews IS
  'P4A append-only audit of produce entry validation exceptions that require an explicit human acknowledgement (price differing from the round''s withdrawal prices). Data-entry approval only; never a financial certification.';

-- ── Append-only guards ──────────────────────────────────────────────────────

CREATE FUNCTION public.produce_entry_validation_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'P4A: produce_entry_validation_reviews is append-only';
END;
$$;

-- The single legal mutation: an unconfirmed row acquiring its confirmation.
-- Every other column, and re-confirmation of an already confirmed row, is
-- rejected — the audit records what happened, not what someone later wished.
CREATE FUNCTION public.produce_entry_validation_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'P4A: a confirmed validation review is immutable';
  END IF;
  IF NEW.id                        IS DISTINCT FROM OLD.id
     OR NEW.session_key            IS DISTINCT FROM OLD.session_key
     OR NEW.session_generation     IS DISTINCT FROM OLD.session_generation
     OR NEW.accountability_round_id IS DISTINCT FROM OLD.accountability_round_id
     OR NEW.validation_digest      IS DISTINCT FROM OLD.validation_digest
     OR NEW.business_date          IS DISTINCT FROM OLD.business_date
     OR NEW.market_label           IS DISTINCT FROM OLD.market_label
     OR NEW.staff_label            IS DISTINCT FROM OLD.staff_label
     OR NEW.exceptions             IS DISTINCT FROM OLD.exceptions
     OR NEW.presented_by_line_user_id IS DISTINCT FROM OLD.presented_by_line_user_id
     OR NEW.presented_line_event_id   IS DISTINCT FROM OLD.presented_line_event_id
     OR NEW.presented_at           IS DISTINCT FROM OLD.presented_at THEN
    RAISE EXCEPTION 'P4A: only the confirmation columns may be set';
  END IF;
  IF NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'P4A: confirmation cannot be cleared';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER produce_entry_validation_reviews_no_delete
  BEFORE DELETE ON public.produce_entry_validation_reviews
  FOR EACH ROW EXECUTE FUNCTION public.produce_entry_validation_forbid_delete();

CREATE TRIGGER produce_entry_validation_reviews_guard_update
  BEFORE UPDATE ON public.produce_entry_validation_reviews
  FOR EACH ROW EXECUTE FUNCTION public.produce_entry_validation_guard_update();

-- ── Writers ─────────────────────────────────────────────────────────────────

-- Record the exception set that was presented. Idempotent: the same digest
-- arriving twice (duplicate LINE delivery, a retried close) returns the
-- existing row untouched, including its confirmation state.
CREATE FUNCTION public.record_produce_validation_review(
  p_session_key             text,
  p_session_generation      bigint,
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

  -- presented_line_event_id lets the caller tell a genuine second press from a
  -- duplicate delivery of the very event that created the row.
  RETURN jsonb_build_object(
    'id', v_row.id,
    'confirmed', v_row.confirmed_at IS NOT NULL,
    'confirmed_at', v_row.confirmed_at,
    'presented_line_event_id', v_row.presented_line_event_id
  );
END;
$$;

-- Acknowledge a presented exception set. The digest is part of the lookup, so
-- a confirmation can only ever apply to the exact session generation and
-- exception set it was issued for: a stale press finds nothing and is refused.
CREATE FUNCTION public.confirm_produce_validation_review(
  p_session_key        text,
  p_session_generation bigint,
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

  UPDATE public.produce_entry_validation_reviews
  SET confirmed_at              = now(),
      confirmed_by_line_user_id = p_line_user_id,
      confirmed_line_event_id   = p_line_event_id
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('status', 'confirmed', 'id', v_row.id);
END;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────
-- Production carries broad default ACLs, so REVOKE precedes every GRANT.

ALTER TABLE public.produce_entry_validation_reviews ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.produce_entry_validation_reviews
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.produce_entry_validation_reviews TO service_role;

REVOKE ALL ON FUNCTION public.produce_entry_validation_forbid_delete()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.produce_entry_validation_guard_update()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.record_produce_validation_review(
  text, bigint, uuid, text, date, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_produce_validation_review(
  text, bigint, uuid, text, date, text, text, jsonb, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_produce_validation_review(
  text, bigint, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_produce_validation_review(
  text, bigint, text, text, text
) TO service_role;
