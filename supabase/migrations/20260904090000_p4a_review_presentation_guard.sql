-- P1 hotfix: evolve the P4A append-only guard to know the delivery transition.
--
-- THE REGRESSION
-- --------------
-- 20260901090000 split presentation into two durable facts: a review EXISTS
-- (recorded) and a review WAS DELIVERED (presented_delivered_at, stamped only
-- after the LINE push landed). mark_produce_validation_review(s)_presented
-- legitimately UPDATEs presented_delivered_at and presented_line_event_id.
--
-- But the append-only guard trigger produce_entry_validation_guard_update(),
-- installed by 20260810070313, still knew exactly one legal mutation: an
-- unconfirmed row acquiring its confirmation. Every delivery stamp therefore
-- raised, because on that UPDATE:
--   * presented_line_event_id changes   -> 'only the confirmation columns may be set'
--   * NEW.confirmed_at is still NULL     -> 'confirmation cannot be cleared'
-- The row's presented_delivered_at stayed NULL forever, confirm_ returned
-- not_presented, and the operator saw the same unknown-product review on every
-- close. This is the production loop UAT found after PR #117.
--
-- THE FIX
-- -------
-- The guard now recognizes exactly the two forward transitions the state
-- machine allows on an unconfirmed row, and default-denies everything else:
--
--   (A) DELIVERY   presented_delivered_at NULL -> non-null, once. The presenting
--                  event id may be REBOUND here (and only here) to the event
--                  that actually delivered the review - never later. Delivery
--                  must not confirm.
--   (B) CONFIRM    confirmed_at NULL -> non-null, only on an already-delivered
--                  row, and it may not touch the delivery proof or any identity
--                  field.
--
-- A confirmed row stays immutable; business identity and presentation
-- provenance stay immutable; delivery proof and confirmation can never be
-- cleared. Forward-only: this replaces the function body and touches no data.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.produce_entry_validation_guard_update()') IS NULL THEN
    RAISE EXCEPTION '20260904090000: produce_entry_validation_guard_update is missing; apply P4A (20260810070313) first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'produce_entry_validation_reviews'
      AND column_name = 'presented_delivered_at'
  ) THEN
    RAISE EXCEPTION '20260904090000: presented_delivered_at is missing; apply the presentation-delivery migration (20260901090000) first';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.produce_entry_validation_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A confirmed review is terminal: nothing about it may change, ever.
  IF OLD.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'P4A: a confirmed validation review is immutable';
  END IF;

  -- Business identity and presentation provenance are immutable on every
  -- transition. presented_line_event_id and presented_delivered_at are the ONLY
  -- non-confirmation columns a transition may move, so they are handled below,
  -- not here.
  IF NEW.id                         IS DISTINCT FROM OLD.id
     OR NEW.session_key             IS DISTINCT FROM OLD.session_key
     OR NEW.session_generation      IS DISTINCT FROM OLD.session_generation
     OR NEW.accountability_round_id IS DISTINCT FROM OLD.accountability_round_id
     OR NEW.validation_digest       IS DISTINCT FROM OLD.validation_digest
     OR NEW.business_date           IS DISTINCT FROM OLD.business_date
     OR NEW.market_label            IS DISTINCT FROM OLD.market_label
     OR NEW.staff_label             IS DISTINCT FROM OLD.staff_label
     OR NEW.exceptions              IS DISTINCT FROM OLD.exceptions
     OR NEW.presented_by_line_user_id IS DISTINCT FROM OLD.presented_by_line_user_id
     OR NEW.presented_at            IS DISTINCT FROM OLD.presented_at THEN
    RAISE EXCEPTION 'P4A: validation review business identity is immutable';
  END IF;

  -- (A) DELIVERY: the first and only stamp of delivery proof. The presenting
  -- event id may be rebound to the event that actually delivered the review;
  -- delivery must not confirm anything.
  IF OLD.presented_delivered_at IS NULL
     AND NEW.presented_delivered_at IS NOT NULL
     AND NEW.presented_line_event_id IS NOT NULL
     AND btrim(NEW.presented_line_event_id) <> ''
     AND NEW.confirmed_at IS NULL
     AND NEW.confirmed_by_line_user_id IS NOT DISTINCT FROM OLD.confirmed_by_line_user_id
     AND NEW.confirmed_line_event_id IS NOT DISTINCT FROM OLD.confirmed_line_event_id THEN
    RETURN NEW;
  END IF;

  -- (B) CONFIRM: legal only after delivery, and it may not alter the delivery
  -- proof or the presenting event.
  IF OLD.presented_delivered_at IS NOT NULL
     AND NEW.presented_delivered_at IS NOT DISTINCT FROM OLD.presented_delivered_at
     AND NEW.presented_line_event_id IS NOT DISTINCT FROM OLD.presented_line_event_id
     AND NEW.confirmed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Everything else is refused, with the specific reason where one is clear.
  IF OLD.presented_delivered_at IS NOT NULL
     AND NEW.presented_delivered_at IS NULL THEN
    RAISE EXCEPTION 'P4A: presentation delivery proof cannot be cleared';
  END IF;

  IF OLD.presented_delivered_at IS NULL
     AND NEW.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'P4A: validation review must be presented before confirmation';
  END IF;

  RAISE EXCEPTION 'P4A: update is not a permitted validation review transition';
END;
$$;

COMMENT ON FUNCTION public.produce_entry_validation_guard_update() IS
  'Append-only P4A state guard: permits one delivery-proof transition (presented_delivered_at NULL->set, event id rebindable once), then one confirmation transition; confirmed reviews, audit identity, presentation provenance, delivery proof and confirmation are all immutable/unclearable.';

COMMIT;
