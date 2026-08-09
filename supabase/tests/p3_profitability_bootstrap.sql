-- Disposable-PostgreSQL bootstrap for the P3 profitability suite.
--
-- Applied AFTER 0053 + 0054 (which own the real inventory quantity and value
-- ledgers) and BEFORE 20260808105001 (P2E), which alters every table below.
--
-- It creates only the produce / pricing / white-sheet / settlement / slip
-- objects that P2E and P3 read, at the shape their owning migrations give them.
-- Replaying 0002 -> 0049 verbatim would test those migrations rather than P3,
-- which is the same convention purchase_capture_slice_b_bootstrap.sql and
-- p2e_accountability_round_bootstrap.sql already follow. Every column is cited
-- to its owning migration so a drift shows up as a diff, not a surprise.
--
--   produce_sessions / produce_items          0002 + 0006 + 0033 + 0036 + 0037
--   produce_transactions{,_all} views         0037:83-137, verbatim
--   pending_sessions                          0009 + 0031 + 0034 + 0049
--   slip_batches / slip_evidences             0021 + 0027
--   manual_slip_sessions                      0027
--   manual_white_sheet_note_sessions          0059
--   digital_white_sheet_cash_entries          0038 + 0043
--   white_sheet_lifecycle_events              0043
--   settlement_entries                        0007 + 0008 + 0014 + 0015 + 0028
--   settlement_finalizations                  0029
--   transfer_reconciliations                  0027 + 0058
--   central_selling_prices                    0040
--   open_or_rotate_guided_produce_structured_session  0049 (behavioural stub)

-- purchase_capture_slice_b_bootstrap.sql:50-53 already declares raw_messages as
-- an id-only FK target, so the extra columns the produce views need are added
-- rather than assumed.
CREATE TABLE IF NOT EXISTS public.raw_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.raw_messages ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.raw_messages ADD COLUMN IF NOT EXISTS source_id    text;
ALTER TABLE public.raw_messages ADD COLUMN IF NOT EXISTS line_user_id text;
ALTER TABLE public.raw_messages ADD COLUMN IF NOT EXISTS raw_text     text NOT NULL DEFAULT '';

CREATE TABLE public.pending_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key             text NOT NULL UNIQUE,
  session_generation      uuid NOT NULL DEFAULT gen_random_uuid(),
  accumulated_text        text NOT NULL DEFAULT '',
  source_type             text NOT NULL,
  source_id               text NOT NULL,
  line_user_id            text NOT NULL,
  opened_line_event_id    text NOT NULL,
  line_timestamp_ms       bigint NOT NULL,
  command_contract_version integer NOT NULL,
  business_date           date NOT NULL,
  transaction_time        text NOT NULL,
  transaction_time_source text NOT NULL,
  staff_label             text NOT NULL,
  market_label            text NOT NULL,
  market_label_normalized text NOT NULL,
  session_kind            text NOT NULL,
  initial_transaction_type text NOT NULL,
  declared_transaction_type text,
  additional_opener       text,
  entry_origin            text NOT NULL,
  status                  text NOT NULL DEFAULT 'collecting',
  -- 0034_produce_notification_delivery.sql:11-14
  finalization_status     text NOT NULL DEFAULT 'pending'
    CHECK (finalization_status IN ('pending', 'processing', 'failed_closed', 'duplicate', 'finalized'))
);

CREATE TABLE public.produce_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id            uuid NOT NULL REFERENCES public.raw_messages(id),
  line_user_id              text,
  staff_name                text NOT NULL,
  sender_name               text,
  transaction_time          text,
  session_date              date,
  session_title             text,
  total_items               integer NOT NULL DEFAULT 0,
  parser_errors             jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  finalization_started_at   timestamptz,
  finalized_at              timestamptz,
  -- 0036_additional_produce_entries.sql:51-57
  session_kind              text NOT NULL DEFAULT 'main'
    CHECK (session_kind IN ('main', 'additional')),
  declared_transaction_type text,
  ingest_idempotency_key    text UNIQUE,
  ingest_source             text,
  -- 0037_produce_session_void.sql:44-48
  voided_at                 timestamptz,
  voided_by                 text,
  void_reason               text,
  replacement_session_id    uuid
);

CREATE TABLE public.produce_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES public.produce_sessions(id),
  item_number      integer NOT NULL DEFAULT 1,
  product_name     text NOT NULL,
  -- 0002_produce_weighing.sql:24-26
  price_per_unit   numeric(10,2),
  quantity         numeric(10,3),
  unit             text,
  section          text NOT NULL DEFAULT 'main',
  -- 0006_transaction_type.sql:3-4
  transaction_type text NOT NULL DEFAULT 'เบิก',
  item_hash        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- 0033_produce_basis_pricing.sql:34-36
  basis_quantity   numeric(10,3),
  basis_unit       text,
  basis_price      numeric(10,2)
);

-- Verbatim from 0037_produce_session_void.sql:83-137. P3's accountable
-- quantities are read through these views, and a simplified stand-in would test
-- a view this repository does not have. P2E replaces both to append
-- accountability_round_id.
CREATE OR REPLACE VIEW public.produce_transactions_all AS
SELECT
  pi.id, pi.item_number, pi.product_name, pi.price_per_unit, pi.quantity,
  CASE
    WHEN pi.basis_quantity IS NOT NULL AND pi.basis_price IS NOT NULL
         AND pi.basis_quantity <> 0 AND pi.quantity IS NOT NULL
    THEN ROUND(pi.quantity * pi.basis_price / pi.basis_quantity, 2)
    WHEN pi.quantity IS NOT NULL AND pi.price_per_unit IS NOT NULL
    THEN pi.quantity * pi.price_per_unit
    ELSE NULL
  END AS total_amount,
  pi.unit, pi.section, pi.transaction_type, pi.item_hash,
  pi.created_at AS item_created_at,
  ps.id AS session_id, ps.session_date AS transaction_date,
  ps.transaction_time, COALESCE(ps.session_title, '') AS market_name,
  ps.staff_name, ps.sender_name, ps.created_at AS session_created_at,
  ps.raw_message_id, rm.raw_text AS source_message,
  pi.basis_quantity, pi.basis_unit, pi.basis_price,
  CASE WHEN pi.basis_quantity IS NOT NULL THEN 'basis' ELSE 'unit' END AS pricing_mode,
  CASE pi.transaction_type
    WHEN 'เบิกเพิ่ม' THEN 'เบิก'
    WHEN 'ชั่งคืนเพิ่ม' THEN 'คืน'
    WHEN 'คืนเสียเพิ่ม' THEN 'คืนเสีย'
    ELSE pi.transaction_type
  END AS base_transaction_type,
  ps.session_kind, ps.declared_transaction_type,
  ps.voided_at, ps.voided_by, ps.void_reason, ps.replacement_session_id
FROM public.produce_items pi
JOIN public.produce_sessions ps ON ps.id = pi.session_id
LEFT JOIN public.raw_messages rm ON rm.id = ps.raw_message_id;

CREATE OR REPLACE VIEW public.produce_transactions AS
SELECT * FROM public.produce_transactions_all WHERE voided_at IS NULL;

-- 0040_central_selling_prices.sql:32-43. price_satang is an INTEGER on purpose.
CREATE TABLE public.central_selling_prices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key   text NOT NULL,
  unit_key      text NOT NULL,
  business_date date NOT NULL,
  price_satang  integer NOT NULL CHECK (price_satang >= 0),
  set_by        text,
  set_reason    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_key, unit_key, business_date)
);

CREATE TABLE public.slip_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  source_type text,
  sender_id text,
  status text NOT NULL DEFAULT 'collecting',
  first_image_at timestamptz NOT NULL DEFAULT now(),
  last_image_at timestamptz NOT NULL DEFAULT now(),
  image_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  summary_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  header_text text,
  seller_name text,
  market_name text,
  slip_date date,
  batch_type text NOT NULL DEFAULT 'market',
  finalized_at timestamptz,
  closing_at timestamptz
);

CREATE TABLE public.slip_evidences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id uuid NOT NULL REFERENCES public.raw_messages(id),
  line_message_id text NOT NULL UNIQUE,
  source_id text NOT NULL,
  source_type text NOT NULL,
  line_user_id text,
  storage_bucket text NOT NULL DEFAULT 'slips',
  storage_path text NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'UPLOADED',
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  batch_id uuid REFERENCES public.slip_batches(id),
  batch_index integer,
  market_label text,
  market_label_normalized text
);

CREATE TABLE public.manual_slip_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  business_date date NOT NULL,
  market_label text,
  market_key text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  opened_by_line_user_id text,
  closed_by_line_user_id text,
  opened_line_message_id text,
  closed_line_message_id text,
  UNIQUE (source_id, business_date, market_key)
);

CREATE TABLE public.manual_white_sheet_note_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  market_label text NOT NULL,
  market_label_normalized text NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'open',
  labor numeric,
  location_fee numeric,
  bag numeric,
  snack numeric,
  other_amount numeric,
  other_note text,
  actual_cash numeric,
  opened_by_line_user_id text,
  opened_line_event_id text NOT NULL,
  closed_by_line_user_id text,
  closed_line_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- 0038:21-55 money columns are numeric(12,2) BAHT, not satang; 0043:14-16 adds
-- the finalization gate. P3 multiplies by 100, which is exact at this scale.
CREATE TABLE public.digital_white_sheet_cash_entries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id               text NOT NULL,
  market_label_normalized text NOT NULL,
  business_date           date NOT NULL,
  labor                   numeric(12,2) NOT NULL DEFAULT 0 CHECK (labor >= 0),
  location_fee            numeric(12,2) NOT NULL DEFAULT 0 CHECK (location_fee >= 0),
  bag                     numeric(12,2) NOT NULL DEFAULT 0 CHECK (bag >= 0),
  snack                   numeric(12,2) NOT NULL DEFAULT 0 CHECK (snack >= 0),
  other                   numeric(12,2) NOT NULL DEFAULT 0 CHECK (other >= 0),
  other_note              text,
  actual_cash_submitted   numeric(12,2) NOT NULL DEFAULT 0 CHECK (actual_cash_submitted >= 0),
  finalized_at            timestamptz,
  finalized_by            text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digital_white_sheet_cash_entries_identity_key
    UNIQUE (source_id, market_label_normalized, business_date)
);

CREATE TABLE public.white_sheet_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  market_label_normalized text NOT NULL,
  business_date date NOT NULL,
  event text NOT NULL CHECK (event IN ('finalized', 'reopened')),
  actor text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Production has these legacy overloads before P2E EXPAND. CONTRACT removes
-- them after the UUID-aware replacements exist.
CREATE FUNCTION public.finalize_white_sheet_cash_entry(
  p_source_id text, p_market_label_normalized text, p_business_date date, p_actor text
) RETURNS public.digital_white_sheet_cash_entries
LANGUAGE plpgsql AS $$
DECLARE v_row public.digital_white_sheet_cash_entries;
BEGIN
  UPDATE public.digital_white_sheet_cash_entries
  SET finalized_at = now(), finalized_by = btrim(p_actor)
  WHERE source_id = p_source_id
    AND market_label_normalized = p_market_label_normalized
    AND business_date = p_business_date
    AND finalized_at IS NULL
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'no SUBMITTED White Sheet entry found'; END IF;
  INSERT INTO public.white_sheet_lifecycle_events (
    source_id, market_label_normalized, business_date, event, actor
  ) VALUES (v_row.source_id, v_row.market_label_normalized, v_row.business_date, 'finalized', btrim(p_actor));
  RETURN v_row;
END;
$$;

CREATE FUNCTION public.reopen_white_sheet_cash_entry(
  p_source_id text, p_market_label_normalized text, p_business_date date,
  p_actor text, p_reason text
) RETURNS public.digital_white_sheet_cash_entries
LANGUAGE plpgsql AS $$
DECLARE v_row public.digital_white_sheet_cash_entries;
BEGIN
  UPDATE public.digital_white_sheet_cash_entries
  SET finalized_at = NULL, finalized_by = NULL
  WHERE source_id = p_source_id
    AND market_label_normalized = p_market_label_normalized
    AND business_date = p_business_date
    AND finalized_at IS NOT NULL
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'no FINALIZED White Sheet entry found'; END IF;
  INSERT INTO public.white_sheet_lifecycle_events (
    source_id, market_label_normalized, business_date, event, actor, reason
  ) VALUES (v_row.source_id, v_row.market_label_normalized, v_row.business_date, 'reopened', btrim(p_actor), btrim(p_reason));
  RETURN v_row;
END;
$$;

CREATE TABLE public.settlement_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_date date NOT NULL,
  settlement_time text NOT NULL DEFAULT '',
  staff_name text NOT NULL DEFAULT '',
  market_name text NOT NULL DEFAULT '',
  money_transfer numeric(12,2) NOT NULL DEFAULT 0,
  money_cash numeric(12,2) NOT NULL DEFAULT 0,
  expenses numeric(12,2) NOT NULL DEFAULT 0,
  labor numeric(12,2) NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_entries_settlement_date_settlement_time_staff_na_key
    UNIQUE (settlement_date, settlement_time, staff_name, market_name)
);

CREATE TABLE public.settlement_finalizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  work_round_id uuid,
  finalized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settlement_finalizations_legacy_source_date_key
  ON public.settlement_finalizations (source_id, business_date)
  WHERE work_round_id IS NULL;

CREATE TABLE public.transfer_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  business_date date NOT NULL,
  ai_verified_total numeric(12,2) NOT NULL DEFAULT 0,
  manual_slip_total numeric(12,2) NOT NULL DEFAULT 0,
  checked_slip_total numeric(12,2) NOT NULL DEFAULT 0,
  submitted_transfer_total numeric(12,2) NOT NULL DEFAULT 0,
  difference numeric(12,2) NOT NULL DEFAULT 0,
  matched boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_reconciliations_source_date_key
    UNIQUE (source_id, business_date)
);

-- Behavioural stub of the 0049 guided open RPC. P2E's preflight requires this
-- exact 19-argument signature and wraps it; the wrapper is what P3's fixtures
-- call to create real rounds, so the stub must actually rotate generations.
CREATE OR REPLACE FUNCTION public.open_or_rotate_guided_produce_structured_session(
  p_session_key text, p_source_type text, p_source_id text, p_line_user_id text,
  p_opened_line_event_id text, p_line_timestamp_ms bigint,
  p_command_contract_version integer, p_business_date date,
  p_transaction_time text, p_transaction_time_source text, p_staff_label text,
  p_market_label text, p_market_label_normalized text, p_session_kind text,
  p_initial_transaction_type text, p_declared_transaction_type text DEFAULT NULL,
  p_additional_opener text DEFAULT NULL, p_expected_session_generation uuid DEFAULT NULL,
  p_entry_origin text DEFAULT 'structured_menu'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.pending_sessions%ROWTYPE; v_generation uuid;
BEGIN
  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = p_session_key FOR UPDATE;
  IF FOUND AND v_row.opened_line_event_id = p_opened_line_event_id THEN
    RETURN jsonb_build_object('outcome', 'idempotent', 'session_generation', v_row.session_generation);
  END IF;
  v_generation := gen_random_uuid();
  INSERT INTO public.pending_sessions (
    session_key, session_generation, source_type, source_id, line_user_id,
    opened_line_event_id, line_timestamp_ms, command_contract_version,
    business_date, transaction_time, transaction_time_source, staff_label,
    market_label, market_label_normalized, session_kind,
    initial_transaction_type, declared_transaction_type, additional_opener,
    entry_origin, status
  ) VALUES (
    p_session_key, v_generation, p_source_type, p_source_id, p_line_user_id,
    p_opened_line_event_id, p_line_timestamp_ms, p_command_contract_version,
    p_business_date, p_transaction_time, p_transaction_time_source, p_staff_label,
    p_market_label, p_market_label_normalized, p_session_kind,
    p_initial_transaction_type, p_declared_transaction_type, p_additional_opener,
    p_entry_origin, 'collecting'
  ) ON CONFLICT (session_key) DO UPDATE SET
    session_generation = EXCLUDED.session_generation,
    opened_line_event_id = EXCLUDED.opened_line_event_id,
    session_kind = EXCLUDED.session_kind,
    initial_transaction_type = EXCLUDED.initial_transaction_type,
    declared_transaction_type = EXCLUDED.declared_transaction_type,
    additional_opener = EXCLUDED.additional_opener,
    status = 'collecting';
  RETURN jsonb_build_object(
    'outcome', CASE WHEN FOUND THEN 'rotated' ELSE 'opened' END,
    'session_generation', v_generation
  );
END;
$$;
