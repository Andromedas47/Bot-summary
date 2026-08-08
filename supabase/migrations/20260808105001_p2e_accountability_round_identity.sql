-- P2E: generated accountability-round identity. Additive mixed-version gate:
-- old writers keep NULL; new writers bind explicit UUIDs. No legacy inference.

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'pending_sessions', 'produce_sessions', 'inventory_movements',
    'slip_batches', 'slip_evidences', 'manual_slip_sessions',
    'manual_white_sheet_note_sessions', 'digital_white_sheet_cash_entries',
    'white_sheet_lifecycle_events', 'settlement_entries',
    'settlement_finalizations', 'transfer_reconciliations'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'P2E: required table public.% is missing', v_table;
    END IF;
  END LOOP;
  IF to_regprocedure(
    'public.open_or_rotate_guided_produce_structured_session(text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,text,text,uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'P2E: guided structured open RPC is missing';
  END IF;
END $$;

CREATE TABLE public.accountability_rounds (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type              text        NOT NULL CHECK (source_type IN ('user', 'group', 'room')),
  source_id                text        NOT NULL CHECK (length(btrim(source_id)) > 0),
  owner_line_user_id       text        NOT NULL CHECK (length(btrim(owner_line_user_id)) > 0),
  business_date            date        NOT NULL,
  seller_label             text        NOT NULL CHECK (length(btrim(seller_label)) > 0),
  market_label             text        NOT NULL CHECK (length(btrim(market_label)) > 0),
  market_label_normalized  text        NOT NULL CHECK (length(btrim(market_label_normalized)) > 0),
  status                   text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'cancelled')),
  created_line_event_id    text        NOT NULL UNIQUE
    CHECK (length(btrim(created_line_event_id)) > 0),
  closed_line_event_id     text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  closed_at                timestamptz,
  CONSTRAINT accountability_rounds_close_shape CHECK (
    (status = 'open' AND closed_at IS NULL AND closed_line_event_id IS NULL)
    OR (status IN ('closed', 'cancelled') AND closed_at IS NOT NULL)
  ),
  CONSTRAINT accountability_rounds_identity_source_owner_key
    UNIQUE (id, source_id, owner_line_user_id)
);

COMMENT ON TABLE public.accountability_rounds IS
  'One generated UUID per economically distinct accountability cycle. Source, '
  'owner, seller, market and date are immutable attributes, never identity.';

ALTER TABLE public.accountability_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accountability_rounds FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.accountability_rounds FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.accountability_rounds TO service_role;

CREATE INDEX accountability_rounds_source_owner_open_idx
  ON public.accountability_rounds (source_id, owner_line_user_id, created_at DESC)
  WHERE status = 'open';

ALTER TABLE public.pending_sessions
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.produce_sessions
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.inventory_movements
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.slip_batches
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.slip_evidences
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.manual_slip_sessions
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.manual_white_sheet_note_sessions
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.digital_white_sheet_cash_entries
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.white_sheet_lifecycle_events
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.settlement_entries
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.settlement_entries
  DROP CONSTRAINT settlement_entries_settlement_date_settlement_time_staff_na_key;
ALTER TABLE public.settlement_entries
  ADD CONSTRAINT settlement_entries_round_identity_key
  UNIQUE NULLS NOT DISTINCT (
    settlement_date, settlement_time, staff_name, market_name,
    accountability_round_id
  );
ALTER TABLE public.settlement_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.settlement_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.settlement_entries FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.settlement_entries TO service_role;
ALTER TABLE public.settlement_finalizations
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.settlement_finalizations
  DROP CONSTRAINT IF EXISTS settlement_finalizations_source_id_business_date_key;
DROP INDEX IF EXISTS public.settlement_finalizations_legacy_source_date_key;
ALTER TABLE public.settlement_finalizations
  ADD CONSTRAINT settlement_finalizations_round_identity_key
  UNIQUE NULLS NOT DISTINCT (source_id, business_date, accountability_round_id);
ALTER TABLE public.transfer_reconciliations
  ADD COLUMN accountability_round_id uuid
    REFERENCES public.accountability_rounds(id);
ALTER TABLE public.transfer_reconciliations
  DROP CONSTRAINT transfer_reconciliations_source_date_key;
ALTER TABLE public.transfer_reconciliations
  ADD CONSTRAINT transfer_reconciliations_round_identity_key
  UNIQUE NULLS NOT DISTINCT (source_id, business_date, accountability_round_id);

CREATE INDEX pending_sessions_accountability_round_idx
  ON public.pending_sessions (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;
CREATE INDEX produce_sessions_accountability_round_idx
  ON public.produce_sessions (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;
CREATE INDEX inventory_movements_accountability_round_idx
  ON public.inventory_movements (accountability_round_id, movement_type)
  WHERE accountability_round_id IS NOT NULL;
CREATE INDEX slip_batches_accountability_round_idx
  ON public.slip_batches (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;
CREATE INDEX slip_evidences_accountability_round_idx
  ON public.slip_evidences (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;
CREATE INDEX manual_slip_sessions_accountability_round_idx
  ON public.manual_slip_sessions (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;
ALTER TABLE public.digital_white_sheet_cash_entries
  DROP CONSTRAINT digital_white_sheet_cash_entries_identity_key;
CREATE UNIQUE INDEX digital_white_sheet_cash_entries_legacy_identity_uidx
  ON public.digital_white_sheet_cash_entries (
    source_id, market_label_normalized, business_date
  )
  WHERE accountability_round_id IS NULL;
CREATE UNIQUE INDEX digital_white_sheet_cash_entries_accountability_round_uidx
  ON public.digital_white_sheet_cash_entries (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;
CREATE INDEX white_sheet_lifecycle_events_accountability_round_idx
  ON public.white_sheet_lifecycle_events (accountability_round_id, created_at);
CREATE UNIQUE INDEX settlement_entries_accountability_round_uidx
  ON public.settlement_entries (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;
CREATE UNIQUE INDEX settlement_finalizations_accountability_round_uidx
  ON public.settlement_finalizations (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;
CREATE UNIQUE INDEX transfer_reconciliations_accountability_round_uidx
  ON public.transfer_reconciliations (accountability_round_id)
  WHERE accountability_round_id IS NOT NULL;

-- Native same-parent check for slip evidence. MATCH SIMPLE preserves legacy NULL.
ALTER TABLE public.slip_batches
  ADD CONSTRAINT slip_batches_id_accountability_round_key
    UNIQUE (id, accountability_round_id);
ALTER TABLE public.slip_evidences
  ADD CONSTRAINT slip_evidences_batch_accountability_round_fk
    FOREIGN KEY (batch_id, accountability_round_id)
    REFERENCES public.slip_batches(id, accountability_round_id);

-- P2D has these movement classes but no quantity adapters yet. P2E only makes
-- the identity column able to receive future ISSUE/return movements.
ALTER TABLE public.inventory_movements
  DROP CONSTRAINT inventory_movements_movement_type_check;
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_movement_type_check CHECK (
    movement_type IN (
      'PURCHASE_RECEIPT', 'REVERSAL', 'ISSUE', 'GOOD_RETURN',
      'DAMAGED_WRITE_OFF', 'ADJUSTMENT'
    )
  );
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_round_required_check CHECK (
    movement_type NOT IN ('ISSUE', 'GOOD_RETURN', 'DAMAGED_WRITE_OFF')
    OR accountability_round_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION public.accountability_round_normalize(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT btrim(normalize(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g'), NFC))
$$;

REVOKE ALL ON FUNCTION public.accountability_round_normalize(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accountability_round_normalize(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.accountability_rounds_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.owner_line_user_id IS DISTINCT FROM OLD.owner_line_user_id
     OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.seller_label IS DISTINCT FROM OLD.seller_label
     OR NEW.market_label IS DISTINCT FROM OLD.market_label
     OR NEW.market_label_normalized IS DISTINCT FROM OLD.market_label_normalized
     OR NEW.created_line_event_id IS DISTINCT FROM OLD.created_line_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'P2E: accountability round identity and attributes are immutable';
  END IF;
  IF OLD.status <> 'open' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'P2E: terminal accountability round is immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER accountability_rounds_guard_update
  BEFORE UPDATE ON public.accountability_rounds
  FOR EACH ROW EXECUTE FUNCTION public.accountability_rounds_guard_update();

CREATE OR REPLACE FUNCTION public.prevent_accountability_round_rebind()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.accountability_round_id IS NOT NULL
     AND NEW.accountability_round_id IS DISTINCT FROM OLD.accountability_round_id THEN
    RAISE EXCEPTION 'P2E: accountability_round_id is write-once on public.%', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_accountability_round_artifact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row       jsonb := to_jsonb(NEW);
  v_round     public.accountability_rounds%ROWTYPE;
  v_round_id  uuid := NULLIF(v_row->>'accountability_round_id', '')::uuid;
  v_source    text := NULLIF(btrim(v_row->>'source_id'), '');
  v_owner     text := NULLIF(btrim(COALESCE(
    v_row->>'line_user_id',
    v_row->>'opened_by_line_user_id',
    v_row->>'sender_id'
  )), '');
  v_date      date := COALESCE(
    NULLIF(v_row->>'business_date', '')::date,
    NULLIF(v_row->>'settlement_date', '')::date,
    NULLIF(v_row->>'slip_date', '')::date
  );
  v_seller    text := COALESCE(v_row->>'seller_name', v_row->>'staff_name');
  v_market    text := COALESCE(
    v_row->>'market_label_normalized',
    v_row->>'market_label',
    v_row->>'market_name'
  );
BEGIN
  IF v_round_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_round
  FROM public.accountability_rounds
  WHERE id = v_round_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P2E: accountability round % does not exist', v_round_id;
  END IF;
  IF TG_OP = 'INSERT' AND v_round.status <> 'open' THEN
    RAISE EXCEPTION 'P2E: accountability round % is not open', v_round_id;
  END IF;
  IF v_source IS NOT NULL AND v_source IS DISTINCT FROM v_round.source_id THEN
    RAISE EXCEPTION 'P2E: artifact source does not match accountability round %', v_round_id;
  END IF;
  IF v_owner IS NOT NULL AND v_owner IS DISTINCT FROM v_round.owner_line_user_id THEN
    RAISE EXCEPTION 'P2E: artifact owner does not match accountability round %', v_round_id;
  END IF;
  IF v_date IS NOT NULL AND v_date IS DISTINCT FROM v_round.business_date THEN
    RAISE EXCEPTION 'P2E: artifact business date does not match accountability round %', v_round_id;
  END IF;
  IF v_seller IS NOT NULL
     AND public.accountability_round_normalize(v_seller)
         IS DISTINCT FROM public.accountability_round_normalize(v_round.seller_label) THEN
    RAISE EXCEPTION 'P2E: artifact seller does not match accountability round %', v_round_id;
  END IF;
  IF v_market IS NOT NULL
     AND public.accountability_round_normalize(v_market)
         IS DISTINCT FROM v_round.market_label_normalized THEN
    RAISE EXCEPTION 'P2E: artifact market does not match accountability round %', v_round_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_slip_evidence_accountability_round()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch_round uuid;
  v_batch_source text;
  v_batch_sender text;
BEGIN
  IF NEW.batch_id IS NULL THEN RETURN NEW; END IF;
  SELECT accountability_round_id, source_id, sender_id
  INTO v_batch_round, v_batch_source, v_batch_sender
  FROM public.slip_batches WHERE id = NEW.batch_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.source_id IS DISTINCT FROM v_batch_source THEN
    RAISE EXCEPTION 'P2E: slip evidence and batch sources differ';
  END IF;
  IF v_batch_sender IS NOT NULL
     AND NEW.line_user_id IS DISTINCT FROM v_batch_sender THEN
    RAISE EXCEPTION 'P2E: slip evidence and batch owners differ';
  END IF;
  IF v_batch_round IS NULL AND NEW.accountability_round_id IS NOT NULL THEN
    RAISE EXCEPTION 'P2E: bound slip evidence requires a bound batch';
  END IF;
  IF v_batch_round IS NOT NULL THEN
    IF NEW.accountability_round_id IS NOT NULL
       AND NEW.accountability_round_id IS DISTINCT FROM v_batch_round THEN
      RAISE EXCEPTION 'P2E: slip evidence and batch accountability rounds differ';
    END IF;
    NEW.accountability_round_id := v_batch_round;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_inventory_movement_accountability_round()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent_round uuid;
  v_parent_date date;
BEGIN
  IF NEW.movement_type = 'REVERSAL' THEN
    SELECT accountability_round_id INTO v_parent_round
    FROM public.inventory_movements
    WHERE id = NEW.reversal_of_movement_id
    FOR KEY SHARE;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF NEW.accountability_round_id IS NOT NULL
       AND NEW.accountability_round_id IS DISTINCT FROM v_parent_round THEN
      RAISE EXCEPTION 'P2E: reversal accountability round differs from original';
    END IF;
    NEW.accountability_round_id := v_parent_round;
    RETURN NEW;
  END IF;

  IF NEW.accountability_round_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.source_document_type <> 'produce_session' THEN
    RAISE EXCEPTION 'P2E: bound non-reversal movement must source a produce_session';
  END IF;
  SELECT accountability_round_id, session_date INTO v_parent_round, v_parent_date
  FROM public.produce_sessions
  WHERE id = NEW.source_document_id
  FOR KEY SHARE;
  IF NOT FOUND OR v_parent_round IS DISTINCT FROM NEW.accountability_round_id THEN
    RAISE EXCEPTION 'P2E: movement source produce session has another accountability round';
  END IF;
  IF v_parent_date IS NULL OR v_parent_date IS DISTINCT FROM NEW.business_date THEN
    RAISE EXCEPTION 'P2E: movement source produce session has another business date';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.propagate_produce_session_accountability_round()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_round uuid;
BEGIN
  IF NEW.ingest_idempotency_key IS NULL THEN RETURN NEW; END IF;
  SELECT accountability_round_id INTO v_round
  FROM public.pending_sessions
  WHERE session_key || ':' || session_generation::text = NEW.ingest_idempotency_key
  FOR KEY SHARE;
  IF v_round IS NOT NULL THEN
    IF NEW.accountability_round_id IS NOT NULL
       AND NEW.accountability_round_id IS DISTINCT FROM v_round THEN
      RAISE EXCEPTION 'P2E: produce session and pending generation rounds differ';
    END IF;
    NEW.accountability_round_id := v_round;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_white_sheet_cash_from_note()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'closed'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.accountability_round_id IS NOT NULL THEN
    UPDATE public.digital_white_sheet_cash_entries
    SET accountability_round_id = NEW.accountability_round_id
    WHERE source_id = NEW.source_id
      AND market_label_normalized = NEW.market_label_normalized
      AND business_date = NEW.business_date
      AND (
        accountability_round_id IS NULL
        OR accountability_round_id = NEW.accountability_round_id
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'P2E: white-sheet cash row is missing or bound to another round';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_white_sheet_lifecycle_accountability_round()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_round uuid;
BEGIN
  SELECT accountability_round_id INTO v_round
  FROM public.digital_white_sheet_cash_entries
  WHERE source_id = NEW.source_id
    AND market_label_normalized = NEW.market_label_normalized
    AND business_date = NEW.business_date
  FOR KEY SHARE;
  IF v_round IS NOT NULL THEN
    IF NEW.accountability_round_id IS NOT NULL
       AND NEW.accountability_round_id IS DISTINCT FROM v_round THEN
      RAISE EXCEPTION 'P2E: white-sheet lifecycle event round differs from cash row';
    END IF;
    NEW.accountability_round_id := v_round;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER produce_sessions_propagate_accountability_round
  BEFORE INSERT ON public.produce_sessions
  FOR EACH ROW EXECUTE FUNCTION public.propagate_produce_session_accountability_round();
CREATE TRIGGER inventory_movements_bind_accountability_round
  BEFORE INSERT OR UPDATE ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.bind_inventory_movement_accountability_round();
CREATE TRIGGER slip_evidences_bind_accountability_round
  BEFORE INSERT OR UPDATE OF batch_id, accountability_round_id ON public.slip_evidences
  FOR EACH ROW EXECUTE FUNCTION public.bind_slip_evidence_accountability_round();
CREATE TRIGGER manual_white_sheet_note_bind_cash_round
  AFTER UPDATE OF status ON public.manual_white_sheet_note_sessions
  FOR EACH ROW EXECUTE FUNCTION public.bind_white_sheet_cash_from_note();
CREATE TRIGGER white_sheet_lifecycle_bind_accountability_round
  BEFORE INSERT ON public.white_sheet_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.bind_white_sheet_lifecycle_accountability_round();

REVOKE ALL ON FUNCTION public.accountability_rounds_guard_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_accountability_round_rebind() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_accountability_round_artifact() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_slip_evidence_accountability_round() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_inventory_movement_accountability_round() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.propagate_produce_session_accountability_round() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_white_sheet_cash_from_note() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_white_sheet_lifecycle_accountability_round() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'produce_sessions', 'inventory_movements', 'slip_batches', 'slip_evidences',
    'manual_slip_sessions', 'manual_white_sheet_note_sessions',
    'digital_white_sheet_cash_entries', 'white_sheet_lifecycle_events',
    'settlement_entries', 'settlement_finalizations', 'transfer_reconciliations'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OF accountability_round_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.prevent_accountability_round_rebind()',
      v_table || '_accountability_round_write_once', v_table
    );
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY[
    'slip_batches', 'slip_evidences', 'manual_slip_sessions',
    'manual_white_sheet_note_sessions', 'digital_white_sheet_cash_entries',
    'settlement_entries', 'settlement_finalizations', 'transfer_reconciliations'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF accountability_round_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.assert_accountability_round_artifact()',
      v_table || '_accountability_round_guard', v_table
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.open_accountability_round_produce_session(
  p_session_key                     text,
  p_source_type                     text,
  p_source_id                       text,
  p_line_user_id                    text,
  p_opened_line_event_id            text,
  p_line_timestamp_ms               bigint,
  p_command_contract_version        integer,
  p_business_date                   date,
  p_transaction_time                text,
  p_transaction_time_source         text,
  p_staff_label                     text,
  p_market_label                    text,
  p_market_label_normalized         text,
  p_session_kind                    text,
  p_initial_transaction_type        text,
  p_declared_transaction_type       text DEFAULT NULL,
  p_additional_opener               text DEFAULT NULL,
  p_expected_session_generation     uuid DEFAULT NULL,
  p_accountability_round_id         uuid DEFAULT NULL,
  p_entry_origin                    text DEFAULT 'structured_menu'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_result       jsonb;
  v_round        public.accountability_rounds%ROWTYPE;
  v_round_id     uuid := p_accountability_round_id;
  v_is_initial   boolean := p_session_kind = 'main'
    AND p_initial_transaction_type = 'เบิก'
    AND p_declared_transaction_type IS NULL
    AND p_additional_opener IS NULL;
  v_market       text := public.accountability_round_normalize(p_market_label_normalized);
  v_seller       text := public.accountability_round_normalize(p_staff_label);
BEGIN
  IF v_is_initial = (v_round_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'P2E: initial withdrawal creates a new round; continuation requires an explicit round (kind=%, type=%, declared=%, additional=%, round=%)',
      p_session_kind, p_initial_transaction_type, p_declared_transaction_type,
      p_additional_opener, p_accountability_round_id;
  END IF;

  IF v_round_id IS NOT NULL THEN
    SELECT * INTO v_round
    FROM public.accountability_rounds
    WHERE id = v_round_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_round.status <> 'open'
       OR v_round.source_type IS DISTINCT FROM p_source_type
       OR v_round.source_id IS DISTINCT FROM btrim(p_source_id)
       OR v_round.owner_line_user_id IS DISTINCT FROM btrim(p_line_user_id)
       OR v_round.business_date IS DISTINCT FROM p_business_date
       OR public.accountability_round_normalize(v_round.seller_label) IS DISTINCT FROM v_seller
       OR v_round.market_label_normalized IS DISTINCT FROM v_market THEN
      RAISE EXCEPTION 'P2E: accountability round continuation identity mismatch';
    END IF;
  END IF;

  v_result := public.open_or_rotate_guided_produce_structured_session(
    p_session_key => p_session_key,
    p_source_type => p_source_type,
    p_source_id => p_source_id,
    p_line_user_id => p_line_user_id,
    p_opened_line_event_id => p_opened_line_event_id,
    p_line_timestamp_ms => p_line_timestamp_ms,
    p_command_contract_version => p_command_contract_version,
    p_business_date => p_business_date,
    p_transaction_time => p_transaction_time,
    p_transaction_time_source => p_transaction_time_source,
    p_staff_label => p_staff_label,
    p_market_label => p_market_label,
    p_market_label_normalized => p_market_label_normalized,
    p_session_kind => p_session_kind,
    p_initial_transaction_type => p_initial_transaction_type,
    p_declared_transaction_type => p_declared_transaction_type,
    p_additional_opener => p_additional_opener,
    p_expected_session_generation => p_expected_session_generation,
    p_entry_origin => p_entry_origin
  );

  IF v_result->>'outcome' NOT IN ('opened', 'rotated', 'idempotent') THEN
    RETURN v_result;
  END IF;

  IF v_is_initial THEN
    INSERT INTO public.accountability_rounds (
      source_type, source_id, owner_line_user_id, business_date,
      seller_label, market_label, market_label_normalized,
      created_line_event_id
    ) VALUES (
      p_source_type, btrim(p_source_id), btrim(p_line_user_id), p_business_date,
      v_seller, public.accountability_round_normalize(p_market_label), v_market,
      btrim(p_opened_line_event_id)
    )
    ON CONFLICT (created_line_event_id) DO NOTHING;

    SELECT * INTO v_round
    FROM public.accountability_rounds
    WHERE created_line_event_id = btrim(p_opened_line_event_id)
    FOR UPDATE;
    IF v_round.source_type IS DISTINCT FROM p_source_type
       OR v_round.source_id IS DISTINCT FROM btrim(p_source_id)
       OR v_round.owner_line_user_id IS DISTINCT FROM btrim(p_line_user_id)
       OR v_round.business_date IS DISTINCT FROM p_business_date
       OR public.accountability_round_normalize(v_round.seller_label) IS DISTINCT FROM v_seller
       OR v_round.market_label_normalized IS DISTINCT FROM v_market THEN
      RAISE EXCEPTION 'P2E: round creation event was reused with different attributes';
    END IF;
    v_round_id := v_round.id;
  END IF;

  UPDATE public.pending_sessions
  SET accountability_round_id = v_round_id
  WHERE session_key = p_session_key
    AND session_generation = (v_result->>'session_generation')::uuid
    AND source_id = btrim(p_source_id)
    AND line_user_id = btrim(p_line_user_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P2E: opened pending generation could not be bound';
  END IF;

  RETURN v_result || jsonb_build_object('accountability_round_id', v_round_id);
END;
$$;

REVOKE ALL ON FUNCTION public.open_accountability_round_produce_session(
  text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,
  text,text,uuid,uuid,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_accountability_round_produce_session(
  text,text,text,text,text,bigint,integer,date,text,text,text,text,text,text,text,
  text,text,uuid,uuid,text
) TO service_role;

CREATE OR REPLACE FUNCTION public.close_accountability_round(
  p_accountability_round_id uuid,
  p_source_id text,
  p_owner_line_user_id text,
  p_closed_line_event_id text,
  p_status text DEFAULT 'closed'
) RETURNS public.accountability_rounds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_round public.accountability_rounds%ROWTYPE;
BEGIN
  IF p_status NOT IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'P2E: invalid terminal accountability round status';
  END IF;
  SELECT * INTO v_round FROM public.accountability_rounds
  WHERE id = p_accountability_round_id FOR UPDATE;
  IF NOT FOUND
     OR v_round.source_id IS DISTINCT FROM btrim(p_source_id)
     OR v_round.owner_line_user_id IS DISTINCT FROM btrim(p_owner_line_user_id) THEN
    RAISE EXCEPTION 'P2E: accountability round close identity mismatch';
  END IF;
  IF v_round.status = p_status THEN RETURN v_round; END IF;
  IF v_round.status <> 'open' THEN
    RAISE EXCEPTION 'P2E: accountability round already terminal';
  END IF;
  UPDATE public.accountability_rounds
  SET status = p_status,
      closed_at = now(),
      closed_line_event_id = btrim(p_closed_line_event_id)
  WHERE id = p_accountability_round_id
  RETURNING * INTO v_round;
  RETURN v_round;
END;
$$;

REVOKE ALL ON FUNCTION public.close_accountability_round(uuid,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_accountability_round(uuid,text,text,text,text)
  TO service_role;

-- Add round identity to the operational produce views without changing totals.
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
  ps.voided_at, ps.voided_by, ps.void_reason, ps.replacement_session_id,
  ps.accountability_round_id
FROM public.produce_items pi
JOIN public.produce_sessions ps ON ps.id = pi.session_id
LEFT JOIN public.raw_messages rm ON rm.id = ps.raw_message_id;

CREATE OR REPLACE VIEW public.produce_transactions AS
SELECT * FROM public.produce_transactions_all WHERE voided_at IS NULL;

COMMENT ON COLUMN public.pending_sessions.accountability_round_id IS
  'Explicit generated accountability cycle carried by this mutable generation. NULL is legacy/unbound.';
COMMENT ON COLUMN public.produce_sessions.accountability_round_id IS
  'Immutable generated accountability cycle. NULL is legacy/unbound; never infer from descriptive fields.';
COMMENT ON COLUMN public.inventory_movements.accountability_round_id IS
  'Accountability provenance only; never part of physical stock or weighted-average pool keys.';
