-- LINE Manual White Sheet session wrapper.
--
-- One session = one LINE source + normalized market + business date. The
-- operator opens with "<market> ส่งใบขาวมือ <date>", sends field lines across
-- one or more messages, then closes with "จบใบขาวมือ" (or cancels with
-- "ยกเลิกใบขาวมือ"). Closing hands off to the existing White Sheet
-- submission path (digital_white_sheet_cash_entries) — this table only tracks
-- the LINE-side accumulation session, never White Sheet arithmetic.
--
-- Nullable numeric columns distinguish "never sent" (NULL) from "explicitly
-- sent as zero" (0), matching the existing WhiteSheetCloseCommand contract
-- (undefined = omitted, number including 0 = explicit).
--
-- Security posture: RLS is enabled with zero client policies (anon/
-- authenticated get nothing regardless of policy — there are none). Only the
-- service-role server client, which reads/writes this table directly (no
-- RPC-only wall), is granted table privileges, and only the ones the service
-- layer actually issues: SELECT/INSERT/UPDATE. No DELETE, no TRUNCATE — the
-- Postgres default public-schema ACL is fully revoked below so RLS is never
-- the only thing standing between anon/authenticated and this table.

CREATE TABLE public.manual_white_sheet_sessions (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id                text        NOT NULL,
  market_label             text        NOT NULL,
  market_label_normalized  text        NOT NULL,
  business_date            date        NOT NULL,
  -- Raw operator-typed DD/MM/BBBB (Buddhist) string, kept only for LINE
  -- reply display fidelity — business_date above is the canonical ISO value.
  business_date_display    text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'open'
                                        CHECK (status IN ('open', 'closing', 'closed', 'cancelled')),

  labor                    numeric(12,2),
  location_fee             numeric(12,2),
  bag                      numeric(12,2),
  snack                    numeric(12,2),
  other_amount             numeric(12,2),
  other_note               text,
  actual_cash_submitted    numeric(12,2),

  -- Which fields the operator explicitly typed during the *current* open
  -- window (reset to '{}' on every fresh open/reopen). Lets the close path
  -- overlay only what was actually edited onto the latest canonical White
  -- Sheet instead of resending every displayed/seeded value — see
  -- buildWhiteSheetCloseCommandFromSession.
  edited_fields             text[]      NOT NULL DEFAULT '{}',

  opened_by_line_user_id   text,
  opened_line_event_id     text        NOT NULL,
  opened_at                timestamptz NOT NULL DEFAULT now(),

  -- Recoverable closing lease: set atomically by claim_manual_white_sheet_
  -- session_close() when status flips to 'closing', cleared by every
  -- transition back out of 'closing' (open, closed, or a fresh reopen).
  -- NULL whenever status is not 'closing' — enforced below.
  closing_started_at       timestamptz,

  closed_by_line_user_id   text,
  closed_line_event_id     text,
  closed_at                timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- One session per source/market/date identity (matches White Sheet identity).
  UNIQUE (source_id, market_label_normalized, business_date),

  CONSTRAINT manual_white_sheet_sessions_source_id_nonblank
    CHECK (btrim(source_id) <> ''),
  CONSTRAINT manual_white_sheet_sessions_market_label_nonblank
    CHECK (btrim(market_label) <> ''),
  CONSTRAINT manual_white_sheet_sessions_market_label_normalized_nonblank
    CHECK (btrim(market_label_normalized) <> ''),
  CONSTRAINT manual_white_sheet_sessions_business_date_display_nonblank
    CHECK (btrim(business_date_display) <> ''),

  CONSTRAINT manual_white_sheet_sessions_labor_nonneg
    CHECK (labor IS NULL OR labor >= 0),
  CONSTRAINT manual_white_sheet_sessions_location_fee_nonneg
    CHECK (location_fee IS NULL OR location_fee >= 0),
  CONSTRAINT manual_white_sheet_sessions_bag_nonneg
    CHECK (bag IS NULL OR bag >= 0),
  CONSTRAINT manual_white_sheet_sessions_snack_nonneg
    CHECK (snack IS NULL OR snack >= 0),
  CONSTRAINT manual_white_sheet_sessions_other_amount_nonneg
    CHECK (other_amount IS NULL OR other_amount >= 0),
  CONSTRAINT manual_white_sheet_sessions_actual_cash_submitted_nonneg
    CHECK (actual_cash_submitted IS NULL OR actual_cash_submitted >= 0),
  CONSTRAINT manual_white_sheet_sessions_other_note_length
    CHECK (other_note IS NULL OR length(other_note) <= 1000),

  CONSTRAINT manual_white_sheet_sessions_edited_fields_known
    CHECK (edited_fields <@ ARRAY[
      'labor', 'location_fee', 'bag', 'snack', 'other', 'actual_cash_submitted'
    ]),

  -- Lifecycle consistency: which timestamp/claim/terminal fields may be
  -- non-NULL is fully determined by status, so every service transition that
  -- sets status must set the matching fields in the *same* UPDATE statement.
  --   open      — no closing lease, no terminal fields.
  --   closing   — lease timestamp present, no terminal fields yet.
  --   closed / cancelled — lease cleared, terminal fields present.
  CONSTRAINT manual_white_sheet_sessions_lifecycle_consistency
    CHECK (
      (status = 'open'
        AND closing_started_at IS NULL
        AND closed_at IS NULL
        AND closed_line_event_id IS NULL)
      OR (status = 'closing'
        AND closing_started_at IS NOT NULL
        AND closed_at IS NULL
        AND closed_line_event_id IS NULL)
      OR (status IN ('closed', 'cancelled')
        AND closing_started_at IS NULL
        AND closed_at IS NOT NULL
        AND closed_line_event_id IS NOT NULL)
    )
);

-- At most one open (or in-flight closing) session per LINE source at a time.
CREATE UNIQUE INDEX manual_white_sheet_sessions_one_open_per_source
  ON public.manual_white_sheet_sessions (source_id)
  WHERE status IN ('open', 'closing');

CREATE INDEX manual_white_sheet_sessions_source_date_idx
  ON public.manual_white_sheet_sessions (source_id, business_date);

CREATE OR REPLACE FUNCTION public.set_manual_white_sheet_session_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_manual_white_sheet_sessions_updated_at
  BEFORE UPDATE ON public.manual_white_sheet_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_manual_white_sheet_session_updated_at();

-- Recoverable closing lease: atomically claims an 'open' session for closing,
-- or reclaims a 'closing' session whose lease has expired (process died
-- after claiming, before finalizing). A fresh (non-expired) 'closing' claim
-- can never be stolen — at most one caller ever wins a given claim window.
-- FOR UPDATE on the single source-scoped row (the partial unique index above
-- guarantees at most one open/closing row per source_id) serializes
-- concurrent close attempts for the same source; only one proceeds past the
-- lock at a time, so exactly one claim ever wins.
CREATE OR REPLACE FUNCTION public.claim_manual_white_sheet_session_close(
  p_source_id     text,
  p_lease_seconds integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.manual_white_sheet_sessions;
BEGIN
  IF btrim(coalesce(p_source_id, '')) = '' THEN
    RAISE EXCEPTION '0059: source_id is required';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN
    RAISE EXCEPTION '0059: lease_seconds must be positive';
  END IF;

  SELECT *
    INTO v_row
    FROM public.manual_white_sheet_sessions
   WHERE source_id = p_source_id
     AND status IN ('open', 'closing')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found', 'session', NULL);
  END IF;

  IF v_row.status = 'closing' THEN
    IF v_row.closing_started_at IS NOT NULL
       AND v_row.closing_started_at <= now() - make_interval(secs => p_lease_seconds) THEN
      -- Stale lease (claimant died before finalizing/reverting) — reclaim.
      UPDATE public.manual_white_sheet_sessions
         SET closing_started_at = now()
       WHERE id = v_row.id
      RETURNING * INTO v_row;
      RETURN jsonb_build_object('claimed', true, 'reason', NULL, 'session', to_jsonb(v_row));
    END IF;
    -- Fresh claim in flight — cannot be stolen.
    RETURN jsonb_build_object('claimed', false, 'reason', 'closing_in_progress', 'session', to_jsonb(v_row));
  END IF;

  -- status = 'open'
  UPDATE public.manual_white_sheet_sessions
     SET status = 'closing',
         closing_started_at = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('claimed', true, 'reason', NULL, 'session', to_jsonb(v_row));
END;
$fn$;

COMMENT ON FUNCTION public.claim_manual_white_sheet_session_close(text, integer) IS
  'Atomic recoverable closing-lease claim for one LINE source: claims an open '
  'session, or reclaims a closing session whose lease has expired. Returns '
  '{claimed, reason, session}. Never depends on an application catch block to '
  'recover a stuck ''closing'' row.';

REVOKE ALL ON FUNCTION public.claim_manual_white_sheet_session_close(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_manual_white_sheet_session_close(text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_manual_white_sheet_session_close(text, integer) TO service_role;

ALTER TABLE public.manual_white_sheet_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role server client (which bypasses RLS)
-- reads/writes this table — same posture as digital_white_sheet_cash_entries.
-- RLS alone does not protect TRUNCATE, so table privileges are revoked and
-- re-granted explicitly below instead of relying on the schema's default ACL.

REVOKE ALL ON TABLE public.manual_white_sheet_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.manual_white_sheet_sessions FROM anon;
REVOKE ALL ON TABLE public.manual_white_sheet_sessions FROM authenticated;
REVOKE ALL ON TABLE public.manual_white_sheet_sessions FROM service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.manual_white_sheet_sessions TO service_role;
