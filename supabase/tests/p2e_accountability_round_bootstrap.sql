-- Disposable PostgreSQL bootstrap: only the pre-P2E contracts touched by P2E.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.raw_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  line_user_id text,
  raw_text text NOT NULL DEFAULT ''
);

CREATE TABLE public.pending_sessions (
  session_key text PRIMARY KEY,
  session_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  source_type text NOT NULL,
  source_id text NOT NULL,
  line_user_id text NOT NULL,
  opened_line_event_id text NOT NULL,
  line_timestamp_ms bigint NOT NULL,
  command_contract_version integer NOT NULL,
  business_date date NOT NULL,
  transaction_time text NOT NULL,
  transaction_time_source text NOT NULL,
  staff_label text NOT NULL,
  market_label text NOT NULL,
  market_label_normalized text NOT NULL,
  session_kind text NOT NULL,
  initial_transaction_type text NOT NULL,
  declared_transaction_type text,
  additional_opener text,
  entry_origin text NOT NULL,
  status text NOT NULL DEFAULT 'collecting'
);

CREATE TABLE public.produce_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id uuid NOT NULL REFERENCES public.raw_messages(id),
  line_user_id text,
  staff_name text NOT NULL,
  sender_name text,
  transaction_time text,
  session_date date,
  session_title text,
  total_items integer NOT NULL DEFAULT 0,
  parser_errors jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalization_started_at timestamptz,
  finalized_at timestamptz,
  session_kind text NOT NULL DEFAULT 'main',
  declared_transaction_type text,
  ingest_idempotency_key text UNIQUE,
  ingest_source text,
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  replacement_session_id uuid
);

CREATE TABLE public.produce_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.produce_sessions(id),
  item_number integer NOT NULL DEFAULT 1,
  product_name text NOT NULL,
  price_per_unit numeric,
  quantity numeric,
  unit text,
  section text,
  transaction_type text NOT NULL,
  item_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  basis_quantity numeric,
  basis_unit text,
  basis_price numeric
);

CREATE TABLE public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type text NOT NULL CONSTRAINT inventory_movements_movement_type_check
    CHECK (movement_type IN ('PURCHASE_RECEIPT', 'REVERSAL')),
  business_date date NOT NULL,
  source_document_type text NOT NULL,
  source_document_id uuid NOT NULL,
  source_document_version text NOT NULL,
  dedupe_key text NOT NULL,
  reversal_of_movement_id uuid REFERENCES public.inventory_movements(id),
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
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

CREATE TABLE public.digital_white_sheet_cash_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  market_label_normalized text NOT NULL,
  business_date date NOT NULL,
  labor numeric NOT NULL DEFAULT 0,
  location_fee numeric NOT NULL DEFAULT 0,
  bag numeric NOT NULL DEFAULT 0,
  snack numeric NOT NULL DEFAULT 0,
  other numeric NOT NULL DEFAULT 0,
  actual_cash_submitted numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digital_white_sheet_cash_entries_identity_key
    UNIQUE (source_id, market_label_normalized, business_date)
);

CREATE TABLE public.white_sheet_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  market_label_normalized text NOT NULL,
  business_date date NOT NULL,
  event text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.settlement_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_date date NOT NULL,
  settlement_time text NOT NULL,
  staff_name text NOT NULL,
  market_name text NOT NULL,
  money_transfer numeric NOT NULL DEFAULT 0,
  money_cash numeric NOT NULL DEFAULT 0,
  expenses numeric NOT NULL DEFAULT 0,
  labor numeric NOT NULL DEFAULT 0,
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
  work_round_id uuid
);
CREATE UNIQUE INDEX settlement_finalizations_legacy_source_date_key
  ON public.settlement_finalizations (source_id, business_date)
  WHERE work_round_id IS NULL;
CREATE UNIQUE INDEX settlement_finalizations_work_round_key
  ON public.settlement_finalizations (work_round_id);

CREATE TABLE public.transfer_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  business_date date NOT NULL,
  ai_verified_total numeric NOT NULL DEFAULT 0,
  manual_slip_total numeric NOT NULL DEFAULT 0,
  submitted_transfer_total numeric NOT NULL DEFAULT 0,
  CONSTRAINT transfer_reconciliations_source_date_key
    UNIQUE (source_id, business_date)
);

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
    RETURN jsonb_build_object('outcome','idempotent','session_generation',v_row.session_generation);
  END IF;
  IF FOUND AND v_row.status = 'collecting' THEN
    RETURN jsonb_build_object('outcome','conflict','session_generation',v_row.session_generation);
  END IF;
  IF FOUND AND p_expected_session_generation IS DISTINCT FROM v_row.session_generation THEN
    RETURN jsonb_build_object('outcome','conflict','session_generation',v_row.session_generation);
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
    source_type = EXCLUDED.source_type, source_id = EXCLUDED.source_id,
    line_user_id = EXCLUDED.line_user_id,
    opened_line_event_id = EXCLUDED.opened_line_event_id,
    business_date = EXCLUDED.business_date, staff_label = EXCLUDED.staff_label,
    market_label = EXCLUDED.market_label,
    market_label_normalized = EXCLUDED.market_label_normalized,
    session_kind = EXCLUDED.session_kind,
    initial_transaction_type = EXCLUDED.initial_transaction_type,
    declared_transaction_type = EXCLUDED.declared_transaction_type,
    additional_opener = EXCLUDED.additional_opener, status = 'collecting';
  RETURN jsonb_build_object('outcome', CASE WHEN FOUND THEN 'rotated' ELSE 'opened' END,
                            'session_generation', v_generation);
END;
$$;
