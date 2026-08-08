-- P3: COGS and profit/loss snapshots.
--
-- Additive, append-only profitability layer over the 0053 quantity ledger, the
-- 0054 (P2D) value ledger, the 0040 central price catalog, the 0038/0043
-- Digital White Sheet, and the 20260808105001 (P2E) accountability round.
--
-- Economic identity is (accountability_round_id, revision) and nothing else.
-- Two rounds may share source, market, seller and business date; they are still
-- two rounds, so no descriptive tuple appears in any key, lock, dedupe value or
-- lineage join in this file.
--
-- This layer writes no quantity movement and no cost line. It only reads them.

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'accountability_rounds', 'produce_items', 'produce_sessions',
    'inventory_movements', 'inventory_movement_lines',
    'inventory_cost_movements', 'inventory_cost_movement_lines',
    'central_selling_prices', 'digital_white_sheet_cash_entries',
    'white_sheet_lifecycle_events', 'settlement_entries',
    'transfer_reconciliations', 'pending_sessions', 'purchase_receipts',
    'slip_batches', 'slip_evidences', 'manual_slip_sessions'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'P3: required table public.% is missing', v_table;
    END IF;
  END LOOP;
  IF to_regclass('public.produce_transactions') IS NULL THEN
    RAISE EXCEPTION 'P3: required view public.produce_transactions is missing';
  END IF;
END $$;

-- ── Snapshot header ─────────────────────────────────────────────────────────

CREATE TABLE public.profitability_snapshots (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The one and only economic identity. NOT NULL by design: a legacy, unbound
  -- artifact has no round, so it has no snapshot and is never merged into one.
  accountability_round_id   uuid          NOT NULL
    REFERENCES public.accountability_rounds(id),
  revision                  integer       NOT NULL CHECK (revision > 0),

  calculation_version       text          NOT NULL
    CHECK (length(btrim(calculation_version)) > 0),
  input_hash                text          NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  dedupe_key                text          NOT NULL UNIQUE
    CHECK (length(btrim(dedupe_key)) > 0),

  certification_state       text          NOT NULL
    CHECK (certification_state IN ('INCOMPLETE', 'CERTIFIED')),
  incomplete_reasons        text[]        NOT NULL DEFAULT '{}',

  -- Quantities. numeric(18,6) is the 0053 ledger envelope (0053:320).
  issued_quantity           numeric(18,6),
  good_return_quantity      numeric(18,6),
  damaged_quantity          numeric(18,6),
  sold_quantity             numeric(18,6),

  -- Money. Integer satang in numeric(24,0), following 0052:496 / 0054:171.
  -- NULL means "not provable", never zero.
  issued_cost_satang        numeric(24,0) CHECK (issued_cost_satang        = trunc(issued_cost_satang)),
  good_return_cost_satang   numeric(24,0) CHECK (good_return_cost_satang   = trunc(good_return_cost_satang)),
  damage_loss_satang        numeric(24,0) CHECK (damage_loss_satang        = trunc(damage_loss_satang)),
  cogs_sold_satang          numeric(24,0) CHECK (cogs_sold_satang          = trunc(cogs_sold_satang)),
  expected_money_satang     numeric(24,0) CHECK (expected_money_satang     = trunc(expected_money_satang)),
  standard_margin_satang    numeric(24,0) CHECK (standard_margin_satang    = trunc(standard_margin_satang)),
  approved_expenses_satang  numeric(24,0) CHECK (approved_expenses_satang  = trunc(approved_expenses_satang)),
  approved_wages_satang     numeric(24,0) CHECK (approved_wages_satang     = trunc(approved_wages_satang)),
  purchasing_expenses_satang numeric(24,0) CHECK (purchasing_expenses_satang = trunc(purchasing_expenses_satang)),
  expected_operating_pl_satang numeric(24,0) CHECK (expected_operating_pl_satang = trunc(expected_operating_pl_satang)),
  verified_transfers_satang numeric(24,0) CHECK (verified_transfers_satang = trunc(verified_transfers_satang)),
  actual_cash_satang        numeric(24,0) CHECK (actual_cash_satang        = trunc(actual_cash_satang)),
  shortage_overage_satang   numeric(24,0) CHECK (shortage_overage_satang   = trunc(shortage_overage_satang)),
  realized_pl_satang        numeric(24,0) CHECK (realized_pl_satang        = trunc(realized_pl_satang)),

  -- One-way door, mirroring 0053's reversed_by_movement_id: a superseded
  -- revision records that fact once and is otherwise frozen.
  superseded_by_snapshot_id uuid          UNIQUE
    REFERENCES public.profitability_snapshots(id),

  actor                     text          CHECK (actor IS NULL OR length(btrim(actor)) > 0),
  created_at                timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (accountability_round_id, revision),

  CONSTRAINT profitability_snapshots_no_self_supersede
    CHECK (superseded_by_snapshot_id IS DISTINCT FROM id),

  -- The state and the reasons are the same fact stated twice; a CHECK is what
  -- stops them disagreeing, rather than application discipline.
  CONSTRAINT profitability_snapshots_certified_iff_no_reasons
    CHECK ((certification_state = 'CERTIFIED') = (cardinality(incomplete_reasons) = 0)),

  -- A certified snapshot may not carry an absent money term. Absence is exactly
  -- what INCOMPLETE means, so the two can never drift apart.
  CONSTRAINT profitability_snapshots_certified_is_complete
    CHECK (certification_state <> 'CERTIFIED' OR (
      issued_cost_satang IS NOT NULL AND cogs_sold_satang IS NOT NULL
      AND damage_loss_satang IS NOT NULL AND expected_money_satang IS NOT NULL
      AND standard_margin_satang IS NOT NULL
      AND expected_operating_pl_satang IS NOT NULL
      AND shortage_overage_satang IS NOT NULL AND realized_pl_satang IS NOT NULL
    ))
);

COMMENT ON TABLE public.profitability_snapshots IS
  'Append-only immutable COGS and profit/loss result for one accountability '
  'round at one revision. Identity is (accountability_round_id, revision); no '
  'descriptive field is ever part of it.';
COMMENT ON COLUMN public.profitability_snapshots.incomplete_reasons IS
  'Machine-readable reasons a term could not be proven. Empty exactly when '
  'CERTIFIED. A missing input is NULL plus a reason, never a zero.';

CREATE INDEX profitability_snapshots_round_revision_idx
  ON public.profitability_snapshots (accountability_round_id, revision DESC);

-- ── Snapshot lines ──────────────────────────────────────────────────────────

CREATE TABLE public.profitability_snapshot_lines (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id             uuid          NOT NULL
    REFERENCES public.profitability_snapshots(id),
  line_ordinal            integer       NOT NULL CHECK (line_ordinal > 0),

  -- The 0054 balance key, verbatim. Units and locations therefore stay isolated
  -- structurally: two units of one product are two lines that never combine.
  location_code           text          NOT NULL CHECK (length(btrim(location_code)) > 0),
  product_key             text          NOT NULL CHECK (length(btrim(product_key)) > 0),
  unit_key                text          NOT NULL CHECK (length(btrim(unit_key)) > 0),

  issued_quantity         numeric(18,6) NOT NULL,
  good_return_quantity    numeric(18,6) NOT NULL,
  damaged_quantity        numeric(18,6) NOT NULL,
  sold_quantity           numeric(18,6) NOT NULL CHECK (sold_quantity >= 0),
  issued_ledger_quantity  numeric(18,6),

  price_satang            integer       CHECK (price_satang IS NULL OR price_satang >= 0),

  issued_cost_satang      numeric(24,0) CHECK (issued_cost_satang      = trunc(issued_cost_satang)),
  good_return_cost_satang numeric(24,0) CHECK (good_return_cost_satang = trunc(good_return_cost_satang)),
  damage_loss_satang      numeric(24,0) CHECK (damage_loss_satang      = trunc(damage_loss_satang)),
  cogs_sold_satang        numeric(24,0) CHECK (cogs_sold_satang        = trunc(cogs_sold_satang)),
  expected_money_satang   numeric(24,0) CHECK (expected_money_satang   = trunc(expected_money_satang)),

  incomplete_reasons      text[]        NOT NULL DEFAULT '{}',
  created_at              timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (snapshot_id, line_ordinal),
  UNIQUE (snapshot_id, location_code, product_key, unit_key)
);

COMMENT ON TABLE public.profitability_snapshot_lines IS
  'One row per (location_code, product_key, unit_key) of one snapshot. The key '
  'is the 0054 balance key so cost provenance joins without a second identity.';

-- ── Snapshot lineage ────────────────────────────────────────────────────────

CREATE TABLE public.profitability_snapshot_sources (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id   uuid        NOT NULL REFERENCES public.profitability_snapshots(id),
  artifact_kind text        NOT NULL CHECK (artifact_kind IN (
    'produce_item', 'produce_session', 'inventory_movement',
    'inventory_movement_line', 'inventory_cost_movement_line',
    'central_selling_price', 'white_sheet_cash_entry',
    'white_sheet_lifecycle_event', 'settlement_entry', 'settlement_finalization',
    'transfer_reconciliation', 'slip_batch', 'slip_evidence',
    'manual_slip_session', 'purchase_receipt', 'pending_session'
  )),
  artifact_id   uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, artifact_kind, artifact_id)
);

COMMENT ON TABLE public.profitability_snapshot_sources IS
  'Every source artifact that contributed to one snapshot. Written only from '
  'round-scoped queries or from caller-supplied ids already proven to belong to '
  'the same accountability round.';

CREATE INDEX profitability_snapshot_sources_snapshot_idx
  ON public.profitability_snapshot_sources (snapshot_id);

-- ── Append-only enforcement ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.profitability_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'P3: profitability_ledger_is_append_only (%, %)', TG_TABLE_NAME, TG_OP;
END;
$$;

-- The header allows exactly one mutation: superseded_by_snapshot_id moving from
-- NULL to a value, once. Everything else on the row is frozen.
CREATE OR REPLACE FUNCTION public.profitability_snapshots_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.superseded_by_snapshot_id IS NOT NULL THEN
    RAISE EXCEPTION 'P3: profitability_ledger_is_append_only (snapshot already superseded)';
  END IF;
  IF NEW.superseded_by_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'P3: profitability_ledger_is_append_only (no permitted change)';
  END IF;
  IF (to_jsonb(NEW) - 'superseded_by_snapshot_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_by_snapshot_id') THEN
    RAISE EXCEPTION 'P3: profitability_ledger_is_append_only (snapshot is immutable)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profitability_snapshots_guard_update
  BEFORE UPDATE ON public.profitability_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.profitability_snapshots_guard_update();
CREATE TRIGGER profitability_snapshots_forbid_delete
  BEFORE DELETE ON public.profitability_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.profitability_forbid_mutation();
CREATE TRIGGER profitability_snapshot_lines_forbid_mutation
  BEFORE UPDATE OR DELETE ON public.profitability_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION public.profitability_forbid_mutation();
CREATE TRIGGER profitability_snapshot_sources_forbid_mutation
  BEFORE UPDATE OR DELETE ON public.profitability_snapshot_sources
  FOR EACH ROW EXECUTE FUNCTION public.profitability_forbid_mutation();

-- ── Security posture: identical to 0053/0054 ────────────────────────────────
-- RLS enabled with zero policies; service_role reads through BYPASSRLS. All DML
-- goes through the SECURITY DEFINER RPC below, so the tables carry SELECT only.
-- Production carries broad default ACLs, so REVOKE precedes every GRANT.

ALTER TABLE public.profitability_snapshots        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profitability_snapshot_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profitability_snapshot_sources ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.profitability_snapshots        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.profitability_snapshot_lines   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.profitability_snapshot_sources FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.profitability_snapshots        TO service_role;
GRANT SELECT ON TABLE public.profitability_snapshot_lines   TO service_role;
GRANT SELECT ON TABLE public.profitability_snapshot_sources TO service_role;

REVOKE ALL ON FUNCTION public.profitability_forbid_mutation()        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.profitability_snapshots_guard_update() FROM PUBLIC, anon, authenticated, service_role;

-- ── Posting RPC ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_profitability_snapshot(
  p_accountability_round_id        uuid,
  p_quantity_attributions          jsonb,
  p_verified_transfers_satang      numeric DEFAULT NULL,
  p_verified_transfer_source_ids   uuid[]  DEFAULT '{}',
  p_purchasing_expenses_satang     numeric DEFAULT NULL,
  p_purchasing_expense_receipt_ids uuid[]  DEFAULT '{}',
  p_calculation_version            text    DEFAULT 'p3:v1',
  p_actor                          text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_round        public.accountability_rounds%ROWTYPE;
  v_actor        text := nullif(btrim(coalesce(p_actor, '')), '');
  v_version      text := nullif(btrim(coalesce(p_calculation_version, '')), '');
  v_lines        jsonb;
  v_reasons      text[] := '{}';
  v_hash         text;
  v_dedupe       text;
  v_existing     public.profitability_snapshots%ROWTYPE;
  v_previous     public.profitability_snapshots%ROWTYPE;
  v_snapshot_id  uuid;
  v_revision     integer;
  v_state        text;
  v_bad          integer;
  v_sheet        public.digital_white_sheet_cash_entries%ROWTYPE;
  v_sheet_found  boolean := false;
  v_wages        numeric(24,0);
  v_expenses     numeric(24,0);
  v_expense_all  numeric(24,0);
  v_actual_cash  numeric(24,0);
  v_issued_cost  numeric(24,0);
  v_gr_cost      numeric(24,0);
  v_damage       numeric(24,0);
  v_cogs         numeric(24,0);
  v_expected     numeric(24,0);
  v_margin       numeric(24,0);
  v_operating    numeric(24,0);
  v_shortage     numeric(24,0);
  v_realized     numeric(24,0);
  v_issued_qty   numeric(18,6);
  v_gr_qty       numeric(18,6);
  v_dmg_qty      numeric(18,6);
  v_sold_qty     numeric(18,6);
  v_purchasing   numeric(24,0) := p_purchasing_expenses_satang;
  v_transfers    numeric(24,0) := p_verified_transfers_satang;
BEGIN
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'P3: calculation_version is required';
  END IF;

  SELECT * INTO v_round FROM public.accountability_rounds
  WHERE id = p_accountability_round_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P3: accountability_round_not_found (%)', p_accountability_round_id;
  END IF;

  -- Round-scoped lock. Two rounds that share every descriptive field hash to
  -- two different keys here, so neither blocks nor collides with the other.
  PERFORM pg_advisory_xact_lock(
    hashtext('profitability:' || p_accountability_round_id::text)
  );

  -- The parameters are checked, not the numeric(24,0) locals they were assigned
  -- to: plpgsql would already have rounded a fractional input at DECLARE time,
  -- and a silently rounded money input is exactly what must not pass here. A
  -- negative verified transfer would inflate the shortage, so it is refused too.
  IF p_verified_transfers_satang IS NOT NULL
     AND (p_verified_transfers_satang <> trunc(p_verified_transfers_satang)
          OR p_verified_transfers_satang < 0) THEN
    RAISE EXCEPTION 'P3: invalid_satang_input (verified transfers must be exact non-negative satang)';
  END IF;
  IF p_purchasing_expenses_satang IS NOT NULL
     AND (p_purchasing_expenses_satang <> trunc(p_purchasing_expenses_satang)
          OR p_purchasing_expenses_satang < 0) THEN
    RAISE EXCEPTION 'P3: invalid_satang_input (purchasing expenses must be exact non-negative satang)';
  END IF;

  IF p_quantity_attributions IS NULL
     OR jsonb_typeof(p_quantity_attributions) <> 'array' THEN
    RAISE EXCEPTION 'P3: quantity attributions must be a JSON array';
  END IF;

  -- Caller-supplied transfer evidence must belong to THIS round. A slip batch,
  -- slip evidence, manual slip session or reconciliation row from another round
  -- is refused outright rather than quietly ignored.
  SELECT count(*) INTO v_bad
  FROM unnest(coalesce(p_verified_transfer_source_ids, '{}'::uuid[])) AS s(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.slip_evidences x
      WHERE x.id = s.id AND x.accountability_round_id = p_accountability_round_id
    UNION ALL
    SELECT 1 FROM public.slip_batches x
      WHERE x.id = s.id AND x.accountability_round_id = p_accountability_round_id
    UNION ALL
    SELECT 1 FROM public.manual_slip_sessions x
      WHERE x.id = s.id AND x.accountability_round_id = p_accountability_round_id
    UNION ALL
    SELECT 1 FROM public.transfer_reconciliations x
      WHERE x.id = s.id AND x.accountability_round_id = p_accountability_round_id
  );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'P3: cross_round_artifact (% transfer source id(s) do not belong to round %)',
      v_bad, p_accountability_round_id;
  END IF;

  SELECT count(*) INTO v_bad
  FROM unnest(coalesce(p_purchasing_expense_receipt_ids, '{}'::uuid[])) AS s(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.purchase_receipts r
    WHERE r.id = s.id AND r.status = 'confirmed'
  );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'P3: required_artifact_unbound (% purchasing-expense receipt id(s) are not confirmed receipts)', v_bad;
  END IF;

  -- Attribution shape. SQL never derives product_key/unit_key from
  -- produce_items text — 0053:311-313 reserves that resolver to the
  -- application — so the caller supplies it and this verifies it instead.
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_quantity_attributions) e
  WHERE (e->>'produce_item_id') IS NULL
     OR nullif(btrim(coalesce(e->>'location_code', '')), '') IS NULL
     OR nullif(btrim(coalesce(e->>'product_key', '')), '') IS NULL
     OR nullif(btrim(coalesce(e->>'unit_key', '')), '') IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'P3: quantity attribution entries require produce_item_id, location_code, product_key and unit_key';
  END IF;

  SELECT count(*) INTO v_bad FROM (
    SELECT (e->>'produce_item_id')::uuid AS id
    FROM jsonb_array_elements(p_quantity_attributions) e
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'P3: % produce item(s) attributed more than once', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(p_quantity_attributions) e
  WHERE NOT EXISTS (
    SELECT 1 FROM public.produce_transactions t
    WHERE t.id = (e->>'produce_item_id')::uuid
      AND t.accountability_round_id = p_accountability_round_id
  );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'P3: cross_round_artifact (% attributed produce item(s) do not belong to round %)',
      v_bad, p_accountability_round_id;
  END IF;

  -- Per-key result. Produce side and ledger side are joined on the balance key
  -- and then cross-checked against each other; neither is trusted alone.
  WITH attr AS (
    SELECT (e->>'produce_item_id')::uuid AS produce_item_id,
           btrim(e->>'location_code')    AS location_code,
           btrim(e->>'product_key')      AS product_key,
           btrim(e->>'unit_key')         AS unit_key
    FROM jsonb_array_elements(p_quantity_attributions) e
  ),
  produce AS (
    SELECT a.location_code, a.product_key, a.unit_key,
           sum(CASE WHEN t.base_transaction_type = 'เบิก'     THEN t.quantity ELSE 0 END) AS issued_quantity,
           sum(CASE WHEN t.base_transaction_type = 'คืน'      THEN t.quantity ELSE 0 END) AS good_return_quantity,
           sum(CASE WHEN t.base_transaction_type = 'คืนเสีย'  THEN t.quantity ELSE 0 END) AS damaged_quantity
    FROM attr a
    JOIN public.produce_transactions t ON t.id = a.produce_item_id
    GROUP BY 1, 2, 3
  ),
  -- Only movements that are still active count: a 0053 REVERSAL and its 0054
  -- EXACT_NEGATION drop out here, so a reversed issue stops backing a cost.
  ledger AS (
    SELECT l.location_code, l.product_key, l.unit_key, m.movement_type,
           sum(l.signed_quantity)                        AS signed_quantity,
           sum(c.signed_value_satang)                    AS signed_value_satang,
           count(*)                                      AS ledger_lines,
           count(c.id)                                   AS valued_lines
    FROM public.inventory_movements m
    JOIN public.inventory_movement_lines l ON l.movement_id = m.id
    LEFT JOIN public.inventory_cost_movement_lines c ON c.movement_line_id = l.id
    WHERE m.accountability_round_id = p_accountability_round_id
      AND m.movement_type IN ('ISSUE', 'GOOD_RETURN')
      AND m.reversal_of_movement_id IS NULL
      AND m.reversed_by_movement_id IS NULL
    GROUP BY 1, 2, 3, 4
  ),
  issue AS (
    SELECT location_code, product_key, unit_key,
           -signed_quantity AS ledger_quantity,
           CASE WHEN valued_lines = ledger_lines THEN -signed_value_satang END AS cost_satang,
           (valued_lines < ledger_lines) AS unvalued
    FROM ledger WHERE movement_type = 'ISSUE'
  ),
  good_return AS (
    SELECT location_code, product_key, unit_key,
           signed_quantity AS ledger_quantity,
           CASE WHEN valued_lines = ledger_lines THEN signed_value_satang END AS cost_satang,
           (valued_lines < ledger_lines) AS unvalued
    FROM ledger WHERE movement_type = 'GOOD_RETURN'
  ),
  keys AS (
    SELECT location_code, product_key, unit_key FROM produce
    UNION
    SELECT location_code, product_key, unit_key FROM issue
    UNION
    SELECT location_code, product_key, unit_key FROM good_return
  ),
  joined AS (
    SELECT k.location_code, k.product_key, k.unit_key,
           coalesce(p.issued_quantity, 0)      AS issued_quantity,
           coalesce(p.good_return_quantity, 0) AS good_return_quantity,
           coalesce(p.damaged_quantity, 0)     AS damaged_quantity,
           coalesce(p.issued_quantity, 0)
             - coalesce(p.good_return_quantity, 0)
             - coalesce(p.damaged_quantity, 0) AS sold_quantity,
           i.ledger_quantity                   AS issued_ledger_quantity,
           i.cost_satang                       AS issued_cost_satang,
           coalesce(i.unvalued, false)         AS issue_unvalued,
           coalesce(g.ledger_quantity, 0)      AS good_return_ledger_quantity,
           CASE WHEN g.location_code IS NULL THEN 0::numeric ELSE g.cost_satang END
                                               AS good_return_cost_satang,
           coalesce(g.unvalued, false)         AS good_return_unvalued,
           cp.id                               AS price_id,
           cp.price_satang
    FROM keys k
    LEFT JOIN produce     p ON (p.location_code, p.product_key, p.unit_key) = (k.location_code, k.product_key, k.unit_key)
    LEFT JOIN issue       i ON (i.location_code, i.product_key, i.unit_key) = (k.location_code, k.product_key, k.unit_key)
    LEFT JOIN good_return g ON (g.location_code, g.product_key, g.unit_key) = (k.location_code, k.product_key, k.unit_key)
    LEFT JOIN public.central_selling_prices cp
      ON cp.product_key = k.product_key
     AND cp.unit_key    = k.unit_key
     AND cp.business_date = v_round.business_date
  ),
  computed AS (
    SELECT j.*,
           -- Damage carries the round's own proven issue rate. It has no ledger
           -- event by design: the stock left MAIN on the issue and never came
           -- back, so posting one would decrement MAIN a second time.
           CASE WHEN j.issued_cost_satang IS NOT NULL
                 AND j.issued_ledger_quantity IS NOT NULL
                 AND j.issued_ledger_quantity <> 0
                THEN round(j.issued_cost_satang * j.damaged_quantity / j.issued_ledger_quantity)
                WHEN j.issued_cost_satang IS NOT NULL AND j.damaged_quantity = 0
                THEN 0::numeric
           END AS damage_loss_satang,
           CASE WHEN j.price_satang IS NOT NULL
                THEN round(j.sold_quantity * j.price_satang)
           END AS expected_money_satang
    FROM joined j
  ),
  final AS (
    SELECT c.*,
           -- COGS is the residual of one proven total, never a third rounding:
           -- a full return or a full write-off drives it to exactly zero.
           CASE WHEN c.issued_cost_satang IS NOT NULL
                 AND c.good_return_cost_satang IS NOT NULL
                 AND c.damage_loss_satang IS NOT NULL
                THEN c.issued_cost_satang - c.good_return_cost_satang - c.damage_loss_satang
           END AS cogs_sold_satang,
           (
             CASE WHEN c.issued_ledger_quantity IS NULL THEN ARRAY['issue_movement_unbound'] ELSE '{}'::text[] END
             || CASE WHEN c.issue_unvalued OR (c.issued_ledger_quantity IS NOT NULL AND c.issued_cost_satang IS NULL)
                     THEN ARRAY['issue_cost_unvalued'] ELSE '{}'::text[] END
             || CASE WHEN c.issued_ledger_quantity IS NOT NULL
                      AND c.issued_ledger_quantity <> c.issued_quantity
                     THEN ARRAY['issue_quantity_mismatch'] ELSE '{}'::text[] END
             || CASE WHEN c.good_return_unvalued THEN ARRAY['good_return_cost_unvalued'] ELSE '{}'::text[] END
             || CASE WHEN c.good_return_ledger_quantity <> c.good_return_quantity
                     THEN ARRAY['good_return_quantity_mismatch'] ELSE '{}'::text[] END
             || CASE WHEN c.price_satang IS NULL THEN ARRAY['missing_central_price'] ELSE '{}'::text[] END
           ) AS incomplete_reasons
    FROM computed c
  ),
  -- row_number() lives in its own step: a window function may not appear inside
  -- an aggregate call, which jsonb_agg below is.
  ordered AS (
    SELECT f.*,
           row_number() OVER (ORDER BY location_code, product_key, unit_key) AS line_ordinal
    FROM final f
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'line_ordinal',            line_ordinal,
             'location_code',           location_code,
             'product_key',             product_key,
             'unit_key',                unit_key,
             'issued_quantity',         issued_quantity,
             'good_return_quantity',    good_return_quantity,
             'damaged_quantity',        damaged_quantity,
             'sold_quantity',           sold_quantity,
             'issued_ledger_quantity',  issued_ledger_quantity,
             'price_id',                price_id,
             'price_satang',            price_satang,
             'issued_cost_satang',      issued_cost_satang,
             'good_return_cost_satang', good_return_cost_satang,
             'damage_loss_satang',      damage_loss_satang,
             'cogs_sold_satang',        cogs_sold_satang,
             'expected_money_satang',   expected_money_satang,
             'incomplete_reasons',      incomplete_reasons
           )
           ORDER BY line_ordinal
         )
  INTO v_lines
  FROM ordered;

  v_lines := coalesce(v_lines, '[]'::jsonb);

  -- Returns and damage exceeding withdrawals is not a degraded result; it is a
  -- contradiction in the operational record, so it raises rather than clamps.
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_lines) e
  WHERE (e->>'sold_quantity')::numeric < 0;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'P3: negative_sold_quantity (% line(s) return more than was issued)', v_bad;
  END IF;

  SELECT
    sum((e->>'issued_quantity')::numeric),
    sum((e->>'good_return_quantity')::numeric),
    sum((e->>'damaged_quantity')::numeric),
    sum((e->>'sold_quantity')::numeric),
    CASE WHEN count(*) FILTER (WHERE e->>'issued_cost_satang' IS NULL) = 0
         THEN sum((e->>'issued_cost_satang')::numeric) END,
    CASE WHEN count(*) FILTER (WHERE e->>'good_return_cost_satang' IS NULL) = 0
         THEN sum((e->>'good_return_cost_satang')::numeric) END,
    CASE WHEN count(*) FILTER (WHERE e->>'damage_loss_satang' IS NULL) = 0
         THEN sum((e->>'damage_loss_satang')::numeric) END,
    CASE WHEN count(*) FILTER (WHERE e->>'cogs_sold_satang' IS NULL) = 0
         THEN sum((e->>'cogs_sold_satang')::numeric) END,
    CASE WHEN count(*) FILTER (WHERE e->>'expected_money_satang' IS NULL) = 0
         THEN sum((e->>'expected_money_satang')::numeric) END
  INTO v_issued_qty, v_gr_qty, v_dmg_qty, v_sold_qty,
       v_issued_cost, v_gr_cost, v_damage, v_cogs, v_expected
  FROM jsonb_array_elements(v_lines) e;

  SELECT coalesce(array_agg(DISTINCT r.reason), '{}')
  INTO v_reasons
  FROM jsonb_array_elements(v_lines) e,
       jsonb_array_elements_text(e->'incomplete_reasons') AS r(reason);

  IF jsonb_array_length(v_lines) = 0 THEN
    v_reasons := v_reasons || 'no_round_activity'::text;
  END IF;

  -- A produce item of this round that the caller did not attribute would be
  -- silently missing from every total, so its absence is a named reason.
  SELECT count(*) INTO v_bad
  FROM public.produce_transactions t
  WHERE t.accountability_round_id = p_accountability_round_id
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_quantity_attributions) e
      WHERE (e->>'produce_item_id')::uuid = t.id
    );
  IF v_bad > 0 THEN
    v_reasons := v_reasons || 'produce_item_unattributed'::text;
  END IF;

  -- Damage still being decided has not reached produce_transactions yet, so it
  -- cannot reduce anything; the round simply may not be frozen while it waits.
  IF EXISTS (
    SELECT 1 FROM public.pending_sessions ps
    WHERE ps.accountability_round_id = p_accountability_round_id
      AND coalesce(ps.finalization_status, 'pending') NOT IN ('finalized', 'duplicate')
  ) THEN
    v_reasons := v_reasons || 'pending_produce_sessions'::text;
  END IF;

  IF v_round.status = 'open' THEN
    v_reasons := v_reasons || 'accountability_round_open'::text;
  END IF;

  -- Only ISSUE and GOOD_RETURN have a defined contribution to this result. A
  -- round-bound movement of any other class is a contract this repository has
  -- not reviewed — most of all DAMAGED_WRITE_OFF, which would decrement MAIN a
  -- second time for stock that already left on the issue. Silently ignoring it
  -- would understate cost, so it blocks certification instead.
  IF EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.accountability_round_id = p_accountability_round_id
      AND m.movement_type NOT IN ('ISSUE', 'GOOD_RETURN', 'REVERSAL')
      AND m.reversed_by_movement_id IS NULL
  ) THEN
    v_reasons := v_reasons || 'unsupported_round_movement'::text;
  END IF;

  -- White sheet: found only through the round id. A white sheet bound to
  -- another round is therefore invisible here, not merely rejected.
  SELECT * INTO v_sheet FROM public.digital_white_sheet_cash_entries
  WHERE accountability_round_id = p_accountability_round_id;
  v_sheet_found := FOUND;

  IF NOT v_sheet_found THEN
    v_reasons := v_reasons || 'white_sheet_missing'::text;
  ELSE
    IF v_sheet.finalized_at IS NULL THEN
      v_reasons := v_reasons || 'white_sheet_not_finalized'::text;
    END IF;
    -- numeric(12,2) baht is exact, so x100 is an exact satang conversion.
    v_wages       := v_sheet.labor * 100;
    v_expenses    := (v_sheet.location_fee + v_sheet.bag + v_sheet.snack + v_sheet.other) * 100;
    v_expense_all := v_wages + v_expenses;
    v_actual_cash := v_sheet.actual_cash_submitted * 100;
  END IF;

  IF v_transfers IS NULL THEN
    v_reasons := v_reasons || 'missing_verified_transfers'::text;
  END IF;
  IF v_purchasing IS NULL THEN
    v_reasons := v_reasons || 'purchasing_expenses_unattributable'::text;
  END IF;

  v_margin    := v_expected - v_cogs;
  v_operating := v_expected - v_cogs - v_damage - v_expenses - v_wages - v_purchasing;
  v_shortage  := v_actual_cash - (v_expected - v_transfers - v_expense_all);
  v_realized  := v_operating + v_shortage;

  SELECT coalesce(array_agg(DISTINCT r ORDER BY r), '{}') INTO v_reasons
  FROM unnest(v_reasons) r;
  v_state := CASE WHEN cardinality(v_reasons) = 0 THEN 'CERTIFIED' ELSE 'INCOMPLETE' END;

  -- Everything that can move a number is in the digest; anything in the digest
  -- produces a new revision when it moves. Ordering is explicit throughout so
  -- the hash is stable across plan changes.
  v_hash := encode(sha256(convert_to(
      p_accountability_round_id::text
      || '|' || v_version
      || '|' || v_lines::text
      || '|' || coalesce(v_transfers::text, 'null')
      || '|' || coalesce((SELECT string_agg(s::text, ',' ORDER BY s::text)
                          FROM unnest(coalesce(p_verified_transfer_source_ids, '{}'::uuid[])) s), '')
      || '|' || coalesce(v_purchasing::text, 'null')
      || '|' || coalesce((SELECT string_agg(s::text, ',' ORDER BY s::text)
                          FROM unnest(coalesce(p_purchasing_expense_receipt_ids, '{}'::uuid[])) s), '')
      || '|' || coalesce(v_sheet.id::text, 'null')
      || '|' || coalesce(v_wages::text, 'null')
      || '|' || coalesce(v_expenses::text, 'null')
      || '|' || coalesce(v_actual_cash::text, 'null')
      || '|' || coalesce(v_sheet.finalized_at::text, 'null')
      || '|' || array_to_string(v_reasons, ',')
      || '|' || v_round.status,
      'UTF8')), 'hex');
  v_dedupe := 'profitability:v1:' || p_accountability_round_id::text || '|' || v_hash;

  SELECT * INTO v_existing FROM public.profitability_snapshots
  WHERE dedupe_key = v_dedupe;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'replayed', true,
      'snapshot_id', v_existing.id,
      'accountability_round_id', v_existing.accountability_round_id,
      'revision', v_existing.revision,
      'certification_state', v_existing.certification_state,
      'incomplete_reasons', to_jsonb(v_existing.incomplete_reasons)
    );
  END IF;

  SELECT * INTO v_previous FROM public.profitability_snapshots
  WHERE accountability_round_id = p_accountability_round_id
  ORDER BY revision DESC LIMIT 1;
  v_revision := coalesce(v_previous.revision, 0) + 1;

  INSERT INTO public.profitability_snapshots (
    accountability_round_id, revision, calculation_version, input_hash, dedupe_key,
    certification_state, incomplete_reasons,
    issued_quantity, good_return_quantity, damaged_quantity, sold_quantity,
    issued_cost_satang, good_return_cost_satang, damage_loss_satang, cogs_sold_satang,
    expected_money_satang, standard_margin_satang,
    approved_expenses_satang, approved_wages_satang, purchasing_expenses_satang,
    expected_operating_pl_satang, verified_transfers_satang, actual_cash_satang,
    shortage_overage_satang, realized_pl_satang, actor
  ) VALUES (
    p_accountability_round_id, v_revision, v_version, v_hash, v_dedupe,
    v_state, v_reasons,
    v_issued_qty, v_gr_qty, v_dmg_qty, v_sold_qty,
    v_issued_cost, v_gr_cost, v_damage, v_cogs,
    v_expected, v_margin,
    v_expenses, v_wages, v_purchasing,
    v_operating, v_transfers, v_actual_cash,
    v_shortage, v_realized, v_actor
  ) RETURNING id INTO v_snapshot_id;

  INSERT INTO public.profitability_snapshot_lines (
    snapshot_id, line_ordinal, location_code, product_key, unit_key,
    issued_quantity, good_return_quantity, damaged_quantity, sold_quantity,
    issued_ledger_quantity, price_satang,
    issued_cost_satang, good_return_cost_satang, damage_loss_satang,
    cogs_sold_satang, expected_money_satang, incomplete_reasons
  )
  SELECT v_snapshot_id,
         (e->>'line_ordinal')::integer,
         e->>'location_code', e->>'product_key', e->>'unit_key',
         (e->>'issued_quantity')::numeric, (e->>'good_return_quantity')::numeric,
         (e->>'damaged_quantity')::numeric, (e->>'sold_quantity')::numeric,
         (e->>'issued_ledger_quantity')::numeric, (e->>'price_satang')::integer,
         (e->>'issued_cost_satang')::numeric, (e->>'good_return_cost_satang')::numeric,
         (e->>'damage_loss_satang')::numeric, (e->>'cogs_sold_satang')::numeric,
         (e->>'expected_money_satang')::numeric,
         coalesce((SELECT array_agg(r.reason)
                   FROM jsonb_array_elements_text(e->'incomplete_reasons') AS r(reason)), '{}')
  FROM jsonb_array_elements(v_lines) e;

  -- Lineage. Every automatic source is selected by round id, so a Round A
  -- artifact structurally cannot appear under Round B.
  INSERT INTO public.profitability_snapshot_sources (snapshot_id, artifact_kind, artifact_id)
  SELECT v_snapshot_id, 'produce_item'::text, (e->>'produce_item_id')::uuid
  FROM jsonb_array_elements(p_quantity_attributions) e
  UNION
  SELECT v_snapshot_id, 'produce_session'::text, t.session_id
  FROM public.produce_transactions t WHERE t.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'inventory_movement'::text, m.id
  FROM public.inventory_movements m WHERE m.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'inventory_movement_line'::text, l.id
  FROM public.inventory_movements m
  JOIN public.inventory_movement_lines l ON l.movement_id = m.id
  WHERE m.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'inventory_cost_movement_line'::text, c.id
  FROM public.inventory_movements m
  JOIN public.inventory_movement_lines l ON l.movement_id = m.id
  JOIN public.inventory_cost_movement_lines c ON c.movement_line_id = l.id
  WHERE m.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'central_selling_price'::text, (e->>'price_id')::uuid
  FROM jsonb_array_elements(v_lines) e WHERE e->>'price_id' IS NOT NULL
  UNION
  SELECT v_snapshot_id, 'white_sheet_cash_entry'::text, w.id
  FROM public.digital_white_sheet_cash_entries w
  WHERE w.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'white_sheet_lifecycle_event'::text, x.id
  FROM public.white_sheet_lifecycle_events x
  WHERE x.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'settlement_entry'::text, s.id
  FROM public.settlement_entries s
  WHERE s.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'transfer_reconciliation'::text, r.id
  FROM public.transfer_reconciliations r
  WHERE r.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'slip_batch'::text, b.id
  FROM public.slip_batches b WHERE b.accountability_round_id = p_accountability_round_id
  UNION
  SELECT v_snapshot_id, 'purchase_receipt'::text, s.id
  FROM unnest(coalesce(p_purchasing_expense_receipt_ids, '{}'::uuid[])) AS s(id);

  -- Caller-supplied transfer evidence, already proven to belong to this round.
  INSERT INTO public.profitability_snapshot_sources (snapshot_id, artifact_kind, artifact_id)
  SELECT v_snapshot_id, k.kind, s.id
  FROM unnest(coalesce(p_verified_transfer_source_ids, '{}'::uuid[])) AS s(id)
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM public.slip_evidences x WHERE x.id = s.id) THEN 'slip_evidence'
      WHEN EXISTS (SELECT 1 FROM public.slip_batches x WHERE x.id = s.id) THEN 'slip_batch'
      WHEN EXISTS (SELECT 1 FROM public.manual_slip_sessions x WHERE x.id = s.id) THEN 'manual_slip_session'
      ELSE 'transfer_reconciliation'
    END AS kind
  ) k
  ON CONFLICT (snapshot_id, artifact_kind, artifact_id) DO NOTHING;

  IF v_previous.id IS NOT NULL THEN
    UPDATE public.profitability_snapshots
    SET superseded_by_snapshot_id = v_snapshot_id
    WHERE id = v_previous.id AND superseded_by_snapshot_id IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'replayed', false,
    'snapshot_id', v_snapshot_id,
    'accountability_round_id', p_accountability_round_id,
    'revision', v_revision,
    'certification_state', v_state,
    'incomplete_reasons', to_jsonb(v_reasons)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_profitability_snapshot(uuid, jsonb, numeric, uuid[], numeric, uuid[], text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_profitability_snapshot(uuid, jsonb, numeric, uuid[], numeric, uuid[], text, text)
  TO service_role;

-- ── Read RPC ────────────────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: it needs no elevation, so a leaked EXECUTE grant
-- still cannot read past the caller's own table privileges (0053 precedent).
-- Every money and quantity value leaves as ::text — PostgREST serializes
-- numeric as a JSON number, which would round through an IEEE-754 double.

CREATE OR REPLACE FUNCTION public.get_profitability_snapshot(
  p_accountability_round_id uuid,
  p_revision                integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH snapshot AS (
    SELECT * FROM public.profitability_snapshots
    WHERE accountability_round_id = p_accountability_round_id
      AND (p_revision IS NULL OR revision = p_revision)
    ORDER BY revision DESC
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'snapshot_id',                  s.id,
    'accountability_round_id',      s.accountability_round_id,
    'revision',                     s.revision,
    'calculation_version',          s.calculation_version,
    'input_hash',                   s.input_hash,
    'certification_state',          s.certification_state,
    'incomplete_reasons',           to_jsonb(s.incomplete_reasons),
    'superseded_by_snapshot_id',    s.superseded_by_snapshot_id,
    'created_at',                   s.created_at,
    'issued_quantity',              s.issued_quantity::text,
    'good_return_quantity',         s.good_return_quantity::text,
    'damaged_quantity',             s.damaged_quantity::text,
    'sold_quantity',                s.sold_quantity::text,
    'issued_cost_satang',           s.issued_cost_satang::text,
    'good_return_cost_satang',      s.good_return_cost_satang::text,
    'damage_loss_satang',           s.damage_loss_satang::text,
    'cogs_sold_satang',             s.cogs_sold_satang::text,
    'expected_money_satang',        s.expected_money_satang::text,
    'standard_margin_satang',       s.standard_margin_satang::text,
    'approved_expenses_satang',     s.approved_expenses_satang::text,
    'approved_wages_satang',        s.approved_wages_satang::text,
    'purchasing_expenses_satang',   s.purchasing_expenses_satang::text,
    'expected_operating_pl_satang', s.expected_operating_pl_satang::text,
    'verified_transfers_satang',    s.verified_transfers_satang::text,
    'actual_cash_satang',           s.actual_cash_satang::text,
    'shortage_overage_satang',      s.shortage_overage_satang::text,
    'realized_pl_satang',           s.realized_pl_satang::text,
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'line_ordinal',            l.line_ordinal,
        'location_code',           l.location_code,
        'product_key',             l.product_key,
        'unit_key',                l.unit_key,
        'issued_quantity',         l.issued_quantity::text,
        'good_return_quantity',    l.good_return_quantity::text,
        'damaged_quantity',        l.damaged_quantity::text,
        'sold_quantity',           l.sold_quantity::text,
        'issued_ledger_quantity',  l.issued_ledger_quantity::text,
        'price_satang',            l.price_satang::text,
        'issued_cost_satang',      l.issued_cost_satang::text,
        'good_return_cost_satang', l.good_return_cost_satang::text,
        'damage_loss_satang',      l.damage_loss_satang::text,
        'cogs_sold_satang',        l.cogs_sold_satang::text,
        'expected_money_satang',   l.expected_money_satang::text,
        'incomplete_reasons',      to_jsonb(l.incomplete_reasons)
      ) ORDER BY l.line_ordinal)
      FROM public.profitability_snapshot_lines l WHERE l.snapshot_id = s.id
    ), '[]'::jsonb),
    'sources', coalesce((
      SELECT jsonb_agg(jsonb_build_object('artifact_kind', x.artifact_kind, 'artifact_id', x.artifact_id)
                       ORDER BY x.artifact_kind, x.artifact_id)
      FROM public.profitability_snapshot_sources x WHERE x.snapshot_id = s.id
    ), '[]'::jsonb)
  )
  FROM snapshot s;
$$;

REVOKE ALL ON FUNCTION public.get_profitability_snapshot(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_profitability_snapshot(uuid, integer)
  TO service_role;
