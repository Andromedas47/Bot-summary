-- P2B Purchase Receipt persistence — purchase DOCUMENT layer only.
--
-- Slice B only: additive schema + draft/confirm/void RPCs + confirmation contract.
-- Does NOT write inventory movements (no ledger, no stock rows).
-- Does NOT write valuation / COGS / landed cost allocation.
-- Does NOT touch produce_sessions / pending_sessions / physical_inventory_* /
--   slip_* / white sheet / P0 / P1 / P2A.
--
-- Migration id 0052: origin/main highest applied is 0050; 0051 is reserved by
-- feat/guided-menu-identity-state-0051; 0042 and 0046 are reserved/frozen
-- (0046 = frozen purchase prototype — do not resurrect).
--
-- Relationship to P2B Slice A (src/lib/purchases, contract p2b-slice-a-v1):
--   Slice A parses LINE text into commands and NEVER touches the database
--   (enforced by src/lib/purchases/architecture.test.ts). This migration is the
--   persistence sink that a separate service module writes into. The parser's
--   numeric envelope is carried over verbatim:
--     quantity    numeric(18,6)   PURCHASE_QUANTITY_MAX_*
--     unit_cost   numeric(18,4)   PURCHASE_UNIT_RATE_MAX_*
--     document money in integer satang  PURCHASE_DOCUMENT_MONEY_MAX_(15,2)
--     item count  <= 500          PURCHASE_MAX_ITEM_COUNT
--
-- Money: integer satang (1 baht = 100 satang), never numeric/float, per BR-01
-- and the 0040 central-price precedent. unit_cost is the ONLY numeric money-ish
-- column and it is a RATE, not an amount — it keeps the parser's 4dp envelope so
-- a quoted rate is never silently rounded on the way in. Every settled AMOUNT is
-- satang.
--
-- Product identity: product_key / unit_key are canonical strings supplied by the
-- application layer, exactly like 0040 central_selling_prices. They are NEVER
-- recomputed in SQL, so purchase identity can never silently diverge from the
-- pricing/summary identity already in use. raw_* columns keep the verbatim staff
-- text as evidence alongside them.
--
-- Supplier: there is no supplier master table anywhere in this system as of
-- 0052, so a receipt carries supplier IDENTITY TEXT (raw + normalized key) and
-- an optional free external supplier_ref. supplier_key is nullable because the
-- guided/postback path may confirm a receipt before a supplier is known
-- ("supplier reference where available"). Introducing a suppliers table is
-- deliberately out of scope; when one arrives it adds a nullable FK beside
-- supplier_key without rewriting history.
--
-- Lifecycle: draft -> confirmed -> void, and draft -> void.
--   draft      mutable header + items, replaceable in full
--   confirmed  frozen; the ONLY legal onward transition is void
--   void       terminal
-- Confirm is idempotent on (confirmation_key): a redelivered confirm returns the
-- original confirmation unchanged and never double-writes.
--
-- Privilege model (mirrors 0047):
--   anon / authenticated: no table DML/SELECT; no RPC EXECUTE
--   service_role: SELECT on tables; mutation only via SECURITY DEFINER RPCs
--   RPCs: SECURITY DEFINER, fixed search_path, REVOKE PUBLIC/anon/authenticated,
--         GRANT EXECUTE TO service_role only
--   Why DEFINER: so service_role can be denied direct INSERT/UPDATE/DELETE on
--   receipt tables while draft/confirm/void still mutate atomically.

-- WITH SCHEMA applies only when pgcrypto is absent; IF NOT EXISTS does not
-- relocate an extension that is already installed.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Receipts (document header) ───────────────────────────────────────────────

CREATE TABLE public.purchase_receipts (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Draft identity. Stable across redelivery of the same staff document so a
  -- retried draft updates in place instead of forking a second receipt.
  draft_key                 text        NOT NULL
    CHECK (length(btrim(draft_key)) > 0),

  status                    text        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'confirmed', 'void')),

  contract_version          text        NOT NULL
    CHECK (length(btrim(contract_version)) > 0),

  -- Business date of the purchase document (staff-declared), NOT server date.
  business_date             date        NOT NULL,
  -- NULL encodes the parser's PURCHASE_UNKNOWN_TIME_LITERAL case.
  purchase_time             time,

  -- Supplier identity text. No supplier master exists at 0052.
  supplier_key              text        CHECK (supplier_key IS NULL OR length(btrim(supplier_key)) > 0),
  supplier_raw              text        CHECK (supplier_raw IS NULL OR length(btrim(supplier_raw)) > 0),
  -- Optional external supplier/vendor code carried from the document.
  supplier_ref              text        CHECK (supplier_ref IS NULL OR length(btrim(supplier_ref)) > 0),

  -- Document reference (invoice/PO number). NULL encodes PURCHASE_NO_VALUE_LITERAL.
  reference_text            text        CHECK (reference_text IS NULL OR length(btrim(reference_text)) > 0),

  -- Declared destination only. 0052 posts NO movement, so this is intent, not
  -- a location write. Named intended_* to keep that unambiguous for P2C.
  intended_warehouse_code   text        NOT NULL DEFAULT 'MAIN'
    CHECK (intended_warehouse_code = 'MAIN'),

  -- Document-level settled amounts, integer satang.
  freight_satang            bigint      NOT NULL DEFAULT 0 CHECK (freight_satang  >= 0),
  handling_satang           bigint      NOT NULL DEFAULT 0 CHECK (handling_satang >= 0),
  discount_satang           bigint      NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),

  vat_kind                  text        NOT NULL DEFAULT 'NONE'
    CHECK (vat_kind IN ('NONE', 'AMOUNT')),
  vat_satang                bigint      CHECK (vat_satang IS NULL OR vat_satang >= 0),
  vat_included_in_item_prices boolean,
  vat_recoverable           boolean,

  item_count                integer     NOT NULL DEFAULT 0
    CHECK (item_count >= 0 AND item_count <= 500),

  -- Source evidence / provenance of the document.
  source_type               text        CHECK (source_type IS NULL OR source_type IN ('user', 'group', 'room')),
  source_id                 text        CHECK (source_id IS NULL OR length(btrim(source_id)) > 0),
  sender_line_user_id       text        CHECK (sender_line_user_id IS NULL OR length(btrim(sender_line_user_id)) > 0),
  source_line_event_id      text        CHECK (source_line_event_id IS NULL OR length(btrim(source_line_event_id)) > 0),
  source_raw_message_id     uuid        REFERENCES public.raw_messages(id),
  -- Verbatim parser evidence (chunks, review flags, postbacks) kept as captured.
  source_evidence           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  review_flags              jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Optimistic-concurrency token for draft replacement. Bumped on every
  -- successful draft write; confirm requires the caller's expected value.
  draft_revision            bigint      NOT NULL DEFAULT 0,

  -- Confirmation contract.
  confirmation_key          text        CHECK (confirmation_key IS NULL OR length(btrim(confirmation_key)) > 0),
  confirmation_hash         text        CHECK (confirmation_hash IS NULL OR confirmation_hash ~ '^[0-9a-f]{64}$'),
  confirmed_at              timestamptz,
  confirmed_by              text,

  voided_at                 timestamptz,
  voided_by                 text,
  void_reason               text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  UNIQUE (draft_key),
  UNIQUE (confirmation_key),

  -- A confirmed receipt carries a complete confirmation contract.
  CONSTRAINT purchase_receipts_confirmed_complete
    CHECK (
      status <> 'confirmed'
      OR (
        confirmation_key  IS NOT NULL
        AND confirmation_hash IS NOT NULL
        AND confirmed_at  IS NOT NULL
        AND item_count > 0
      )
    ),
  -- A draft has not been confirmed yet.
  CONSTRAINT purchase_receipts_draft_unconfirmed
    CHECK (
      status <> 'draft'
      OR (confirmation_key IS NULL AND confirmation_hash IS NULL AND confirmed_at IS NULL)
    ),
  CONSTRAINT purchase_receipts_void_audited
    CHECK (status <> 'void' OR voided_at IS NOT NULL),
  CONSTRAINT purchase_receipts_unvoided_clean
    CHECK (status = 'void' OR (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)),
  -- VAT shape must match its kind. Zero VAT must be declared as NONE, matching
  -- the Slice A VAT_ZERO_MUST_USE_NONE structural rule.
  CONSTRAINT purchase_receipts_vat_shape
    CHECK (
      (vat_kind = 'NONE'
        AND vat_satang IS NULL
        AND vat_included_in_item_prices IS NULL
        AND vat_recoverable IS NULL)
      OR (vat_kind = 'AMOUNT'
        AND vat_satang IS NOT NULL
        AND vat_satang > 0
        AND vat_included_in_item_prices IS NOT NULL
        AND vat_recoverable IS NOT NULL)
    ),
  CONSTRAINT purchase_receipts_supplier_pairing
    CHECK ((supplier_key IS NULL) = (supplier_raw IS NULL))
);

COMMENT ON TABLE public.purchase_receipts IS
  'P2B purchase DOCUMENT header (draft/confirmed/void). Confirming never writes '
  'inventory movements, valuation, or COGS — those are P2C.';

COMMENT ON COLUMN public.purchase_receipts.draft_key IS
  'Caller-stable identity for the staff document. Redelivered drafts update in '
  'place instead of forking a second receipt.';

COMMENT ON COLUMN public.purchase_receipts.confirmation_key IS
  'Idempotency key for confirm. A repeat confirm with the same key returns the '
  'original confirmation and never double-writes.';

COMMENT ON COLUMN public.purchase_receipts.confirmation_hash IS
  'sha256 over the canonical confirmation payload. Stable anchor P2C can use to '
  'detect whether a confirmed document it already consumed has changed.';

COMMENT ON COLUMN public.purchase_receipts.intended_warehouse_code IS
  'Declared destination intent only. 0052 posts no movement to any location.';

COMMENT ON COLUMN public.purchase_receipts.supplier_key IS
  'Application-canonical supplier identity text. No supplier master table exists '
  'at 0052; nullable because a document may confirm before supplier is known.';

CREATE INDEX purchase_receipts_business_date_idx
  ON public.purchase_receipts (business_date, status);

CREATE INDEX purchase_receipts_supplier_idx
  ON public.purchase_receipts (supplier_key, business_date)
  WHERE supplier_key IS NOT NULL;

CREATE INDEX purchase_receipts_status_confirmed_idx
  ON public.purchase_receipts (status, confirmed_at DESC)
  WHERE status = 'confirmed';

-- ── Receipt items ────────────────────────────────────────────────────────────

CREATE TABLE public.purchase_receipt_items (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id            uuid          NOT NULL
    REFERENCES public.purchase_receipts(id) ON DELETE CASCADE,

  -- Dense 1..n document ordering assigned by the writer.
  item_ordinal          integer       NOT NULL CHECK (item_ordinal > 0 AND item_ordinal <= 500),
  -- Staff-entered line number. Kept as evidence; may differ from item_ordinal.
  item_number           bigint        CHECK (item_number IS NULL OR item_number > 0),

  -- Product normalized identity (application-canonical, never computed in SQL).
  product_key           text          NOT NULL CHECK (length(btrim(product_key)) > 0),
  raw_product_text      text          NOT NULL CHECK (length(btrim(raw_product_text)) > 0),

  quantity              numeric(18,6) NOT NULL CHECK (quantity > 0),
  unit_key              text          NOT NULL CHECK (length(btrim(unit_key)) > 0),
  raw_unit              text          NOT NULL CHECK (length(btrim(raw_unit)) > 0),

  -- Quoted rate per unit in BAHT, parser's 4dp envelope. NULL = rate not stated
  -- on the document (Slice A MISSING_UNIT_RATE review flag).
  unit_cost             numeric(18,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  -- Unit the rate was quoted against when it differs from unit_key
  -- (Slice A PRICE_UNIT_REQUIRES_RESOLUTION). Evidence only; 0052 does not convert.
  price_unit_text       text          CHECK (price_unit_text IS NULL OR length(btrim(price_unit_text)) > 0),

  -- Settled line amount in integer satang. Derived, never caller-supplied, so
  -- the document total can never drift from its own lines. Postgres round() on
  -- numeric is half-away-from-zero and immutable, which makes this deterministic
  -- and replayable.
  line_amount_satang    bigint        GENERATED ALWAYS AS (
    CASE WHEN unit_cost IS NULL THEN NULL
         ELSE round(quantity * unit_cost * 100)::bigint
    END
  ) STORED,

  -- Per-line source evidence (chunk/block span, raw captured text).
  source_evidence       jsonb         NOT NULL DEFAULT '{}'::jsonb,

  created_at            timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (receipt_id, item_ordinal),
  -- A rate quoted against a different unit must actually have a rate.
  CONSTRAINT purchase_receipt_items_price_unit_needs_rate
    CHECK (price_unit_text IS NULL OR unit_cost IS NOT NULL)
);

COMMENT ON TABLE public.purchase_receipt_items IS
  'P2B purchase document lines. Product identity is application-canonical '
  'product_key/unit_key; raw_* keep verbatim staff text as evidence.';

COMMENT ON COLUMN public.purchase_receipt_items.line_amount_satang IS
  'Generated: round(quantity * unit_cost * 100). Half-away-from-zero at satang. '
  'NULL when the document stated no unit rate.';

COMMENT ON COLUMN public.purchase_receipt_items.unit_cost IS
  'Quoted rate per unit in baht at 4dp (parser envelope). A RATE, not a settled '
  'amount — every settled amount in this schema is integer satang.';

COMMENT ON COLUMN public.purchase_receipt_items.price_unit_text IS
  'Unit the rate was quoted against when it differs from unit_key. Evidence '
  'only: 0052 performs no unit conversion.';

CREATE INDEX purchase_receipt_items_receipt_idx
  ON public.purchase_receipt_items (receipt_id, item_ordinal);

CREATE INDEX purchase_receipt_items_product_idx
  ON public.purchase_receipt_items (product_key, unit_key);

-- ── Lifecycle audit (append-only) ────────────────────────────────────────────

CREATE TABLE public.purchase_receipt_lifecycle_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id   uuid        NOT NULL REFERENCES public.purchase_receipts(id),
  event        text        NOT NULL CHECK (event IN ('drafted', 'confirmed', 'voided')),
  actor        text,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX purchase_receipt_lifecycle_events_receipt_idx
  ON public.purchase_receipt_lifecycle_events (receipt_id, created_at);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.purchase_receipts                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_receipt_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_receipt_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- No policies are defined on purpose: with RLS enabled and no policy, every
-- non-BYPASSRLS role reads/writes nothing. service_role has BYPASSRLS but is
-- separately stripped of table DML below, so mutation can only happen inside
-- the SECURITY DEFINER RPCs.

-- ── Immutability guards ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_receipt_forbid_confirmed_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_receipt_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.receipt_id ELSE NEW.receipt_id END;
  v_status     text;
BEGIN
  SELECT status INTO v_status
    FROM public.purchase_receipts
   WHERE id = v_receipt_id;

  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'purchase_receipt_items are immutable once the receipt leaves draft (status=%)',
      coalesce(v_status, '<missing>');
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER purchase_receipt_items_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_receipt_items
  FOR EACH ROW EXECUTE FUNCTION public.purchase_receipt_forbid_confirmed_item_mutation();

CREATE OR REPLACE FUNCTION public.purchase_receipt_guard_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_receipts rows must not be deleted (void instead)';
  END IF;

  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'purchase_receipts status=void is terminal and immutable';
  END IF;

  IF OLD.status = 'confirmed' THEN
    IF NEW.status NOT IN ('confirmed', 'void') THEN
      RAISE EXCEPTION
        'illegal purchase receipt transition confirmed -> %', NEW.status;
    END IF;
    -- A confirmed document is frozen: only the void audit columns may move.
    IF NEW.business_date            IS DISTINCT FROM OLD.business_date
       OR NEW.supplier_key          IS DISTINCT FROM OLD.supplier_key
       OR NEW.supplier_raw          IS DISTINCT FROM OLD.supplier_raw
       OR NEW.supplier_ref          IS DISTINCT FROM OLD.supplier_ref
       OR NEW.reference_text        IS DISTINCT FROM OLD.reference_text
       OR NEW.purchase_time         IS DISTINCT FROM OLD.purchase_time
       OR NEW.intended_warehouse_code IS DISTINCT FROM OLD.intended_warehouse_code
       OR NEW.freight_satang        IS DISTINCT FROM OLD.freight_satang
       OR NEW.handling_satang       IS DISTINCT FROM OLD.handling_satang
       OR NEW.discount_satang       IS DISTINCT FROM OLD.discount_satang
       OR NEW.vat_kind              IS DISTINCT FROM OLD.vat_kind
       OR NEW.vat_satang            IS DISTINCT FROM OLD.vat_satang
       OR NEW.item_count            IS DISTINCT FROM OLD.item_count
       OR NEW.confirmation_key      IS DISTINCT FROM OLD.confirmation_key
       OR NEW.confirmation_hash     IS DISTINCT FROM OLD.confirmation_hash
       OR NEW.confirmed_at          IS DISTINCT FROM OLD.confirmed_at
       OR NEW.draft_revision        IS DISTINCT FROM OLD.draft_revision THEN
      RAISE EXCEPTION 'confirmed purchase receipt is immutable except for void';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'confirmed', 'void') THEN
    RAISE EXCEPTION 'illegal purchase receipt transition draft -> %', NEW.status;
  END IF;

  IF NEW.draft_key IS DISTINCT FROM OLD.draft_key THEN
    RAISE EXCEPTION 'draft_key is immutable';
  END IF;

  -- Confirmation identity, once issued, never changes.
  IF OLD.confirmation_key IS NOT NULL
     AND NEW.confirmation_key IS DISTINCT FROM OLD.confirmation_key THEN
    RAISE EXCEPTION 'confirmation_key is immutable once set';
  END IF;
  IF OLD.confirmation_hash IS NOT NULL
     AND NEW.confirmation_hash IS DISTINCT FROM OLD.confirmation_hash THEN
    RAISE EXCEPTION 'confirmation_hash is immutable once set';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_receipts_transition_guard
  BEFORE UPDATE OR DELETE ON public.purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION public.purchase_receipt_guard_transition();

CREATE OR REPLACE FUNCTION public.purchase_receipt_lifecycle_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'purchase_receipt_lifecycle_events is append-only';
END;
$$;

CREATE TRIGGER purchase_receipt_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.purchase_receipt_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.purchase_receipt_lifecycle_forbid_mutation();

-- ── Confirmation contract ────────────────────────────────────────────────────

-- Canonical confirmation payload. This is THE contract P2C consumes.
--
-- Stability rules for this payload (breaking any of them is a contract break):
--   * key set and key order are fixed and explicit
--   * numerics are rendered as canonical strings, never floats
--   * items are ordered by item_ordinal
--   * it carries no inventory movement, valuation, or COGS field — by design
CREATE OR REPLACE FUNCTION public.purchase_receipt_confirmation_payload(
  p_receipt_id uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'contract_version',        'p2b-purchase-confirm-v1',
    'receipt_id',              r.id::text,
    'draft_key',               r.draft_key,
    'parser_contract_version', r.contract_version,
    'business_date',           to_char(r.business_date, 'YYYY-MM-DD'),
    'purchase_time',           CASE WHEN r.purchase_time IS NULL THEN NULL
                                    ELSE to_char(r.purchase_time, 'HH24:MI') END,
    'supplier_key',            r.supplier_key,
    'supplier_ref',            r.supplier_ref,
    'reference_text',          r.reference_text,
    'intended_warehouse_code', r.intended_warehouse_code,
    'freight_satang',          r.freight_satang::text,
    'handling_satang',         r.handling_satang::text,
    'discount_satang',         r.discount_satang::text,
    'vat_kind',                r.vat_kind,
    'vat_satang',              CASE WHEN r.vat_satang IS NULL THEN NULL ELSE r.vat_satang::text END,
    'vat_included_in_item_prices', r.vat_included_in_item_prices,
    'vat_recoverable',         r.vat_recoverable,
    'item_count',              r.item_count,
    'items',                   coalesce(
      (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'item_ordinal',       i.item_ordinal,
                   'item_number',        CASE WHEN i.item_number IS NULL THEN NULL
                                              ELSE i.item_number::text END,
                   'product_key',        i.product_key,
                   'quantity',           trim_scale(i.quantity)::text,
                   'unit_key',           i.unit_key,
                   'unit_cost',          CASE WHEN i.unit_cost IS NULL THEN NULL
                                              ELSE trim_scale(i.unit_cost)::text END,
                   'price_unit_text',    i.price_unit_text,
                   'line_amount_satang', CASE WHEN i.line_amount_satang IS NULL THEN NULL
                                              ELSE i.line_amount_satang::text END
                 )
                 ORDER BY i.item_ordinal
               )
          FROM public.purchase_receipt_items i
         WHERE i.receipt_id = r.id
      ),
      '[]'::jsonb
    ),
    -- Sum of stated line amounts. NULL-rate lines contribute nothing and are
    -- reported separately so P2C can refuse to value an incomplete document
    -- instead of silently treating a missing rate as zero.
    'items_line_amount_satang_total', coalesce(
      (SELECT sum(i.line_amount_satang) FROM public.purchase_receipt_items i
        WHERE i.receipt_id = r.id), 0)::text,
    'items_missing_unit_cost_count', (
      SELECT count(*) FROM public.purchase_receipt_items i
       WHERE i.receipt_id = r.id AND i.unit_cost IS NULL),
    -- Explicit, machine-readable statement of what 0052 did NOT do.
    'posts_inventory_movement', false,
    'posts_valuation',          false
  )
  FROM public.purchase_receipts r
  WHERE r.id = p_receipt_id;
$$;

COMMENT ON FUNCTION public.purchase_receipt_confirmation_payload(uuid) IS
  'Canonical P2B confirmation contract (p2b-purchase-confirm-v1) consumed by P2C. '
  'Fixed key set, string-rendered numerics, items ordered by item_ordinal.';

CREATE OR REPLACE FUNCTION public.purchase_receipt_confirmation_hash(
  p_receipt_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  -- Hash the canonical payload. jsonb key order is deterministic for a given key
  -- set, so this is replayable across sessions and machines.
  SELECT encode(
           extensions.digest(
             convert_to(public.purchase_receipt_confirmation_payload(p_receipt_id)::text, 'UTF8'),
             'sha256'
           ),
           'hex'
         );
$$;

-- ── Draft write (full replace) ───────────────────────────────────────────────

-- Writes header + items atomically. A redelivered draft with the same draft_key
-- replaces its items wholesale rather than appending, so a retried staff
-- document can never accumulate duplicate lines.
CREATE OR REPLACE FUNCTION public.upsert_purchase_receipt_draft(
  p_draft_key               text,
  p_contract_version        text,
  p_business_date           date,
  p_items                   jsonb,
  p_purchase_time           time    DEFAULT NULL,
  p_supplier_key            text    DEFAULT NULL,
  p_supplier_raw            text    DEFAULT NULL,
  p_supplier_ref            text    DEFAULT NULL,
  p_reference_text          text    DEFAULT NULL,
  p_freight_satang          bigint  DEFAULT 0,
  p_handling_satang         bigint  DEFAULT 0,
  p_discount_satang         bigint  DEFAULT 0,
  p_vat_kind                text    DEFAULT 'NONE',
  p_vat_satang              bigint  DEFAULT NULL,
  p_vat_included_in_item_prices boolean DEFAULT NULL,
  p_vat_recoverable         boolean DEFAULT NULL,
  p_source_type             text    DEFAULT NULL,
  p_source_id               text    DEFAULT NULL,
  p_sender_line_user_id     text    DEFAULT NULL,
  p_source_line_event_id    text    DEFAULT NULL,
  p_source_raw_message_id   uuid    DEFAULT NULL,
  p_source_evidence         jsonb   DEFAULT '{}'::jsonb,
  p_review_flags            jsonb   DEFAULT '[]'::jsonb,
  p_actor                   text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_receipt   public.purchase_receipts;
  v_item      jsonb;
  v_ordinal   integer := 0;
  v_count     integer;
BEGIN
  IF p_draft_key IS NULL OR btrim(p_draft_key) = '' THEN
    RAISE EXCEPTION 'draft_key must not be empty';
  END IF;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date is required';
  END IF;
  IF jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'items must be a JSON array';
  END IF;

  v_count := jsonb_array_length(p_items);
  IF v_count > 500 THEN
    RAISE EXCEPTION 'items exceed the 500-line document limit (got %)', v_count;
  END IF;

  -- Take the row lock first so two concurrent drafts for the same document
  -- serialize instead of interleaving header and item writes.
  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE draft_key = p_draft_key
     FOR UPDATE;

  IF FOUND AND v_receipt.status <> 'draft' THEN
    RAISE EXCEPTION
      'purchase receipt % is % and can no longer be drafted',
      v_receipt.id, v_receipt.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT FOUND THEN
    INSERT INTO public.purchase_receipts (
      draft_key, contract_version, business_date, purchase_time,
      supplier_key, supplier_raw, supplier_ref, reference_text,
      freight_satang, handling_satang, discount_satang,
      vat_kind, vat_satang, vat_included_in_item_prices, vat_recoverable,
      item_count, source_type, source_id, sender_line_user_id,
      source_line_event_id, source_raw_message_id, source_evidence, review_flags,
      draft_revision
    ) VALUES (
      btrim(p_draft_key), p_contract_version, p_business_date, p_purchase_time,
      p_supplier_key, p_supplier_raw, p_supplier_ref, p_reference_text,
      coalesce(p_freight_satang, 0), coalesce(p_handling_satang, 0),
      coalesce(p_discount_satang, 0),
      coalesce(p_vat_kind, 'NONE'), p_vat_satang,
      p_vat_included_in_item_prices, p_vat_recoverable,
      v_count, p_source_type, p_source_id, p_sender_line_user_id,
      p_source_line_event_id, p_source_raw_message_id,
      coalesce(p_source_evidence, '{}'::jsonb), coalesce(p_review_flags, '[]'::jsonb),
      -- Seeded at 0: the unconditional UPDATE below is the single path that
      -- assigns field values, so it also owns the bump. A first draft lands on 1.
      0
    )
    -- Concurrent first-draft race: the UNIQUE(draft_key) index is the backstop.
    ON CONFLICT (draft_key) DO NOTHING
    RETURNING * INTO v_receipt;

    IF NOT FOUND THEN
      -- Lost the insert race; adopt the winner and update it instead.
      SELECT * INTO v_receipt
        FROM public.purchase_receipts
       WHERE draft_key = p_draft_key
         FOR UPDATE;
      IF v_receipt.status <> 'draft' THEN
        RAISE EXCEPTION
          'purchase receipt % is % and can no longer be drafted',
          v_receipt.id, v_receipt.status
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END IF;
  END IF;

  UPDATE public.purchase_receipts SET
    contract_version            = p_contract_version,
    business_date               = p_business_date,
    purchase_time               = p_purchase_time,
    supplier_key                = p_supplier_key,
    supplier_raw                = p_supplier_raw,
    supplier_ref                = p_supplier_ref,
    reference_text              = p_reference_text,
    freight_satang              = coalesce(p_freight_satang, 0),
    handling_satang             = coalesce(p_handling_satang, 0),
    discount_satang             = coalesce(p_discount_satang, 0),
    vat_kind                    = coalesce(p_vat_kind, 'NONE'),
    vat_satang                  = p_vat_satang,
    vat_included_in_item_prices = p_vat_included_in_item_prices,
    vat_recoverable             = p_vat_recoverable,
    item_count                  = v_count,
    source_type                 = p_source_type,
    source_id                   = p_source_id,
    sender_line_user_id         = p_sender_line_user_id,
    source_line_event_id        = p_source_line_event_id,
    source_raw_message_id       = p_source_raw_message_id,
    source_evidence             = coalesce(p_source_evidence, '{}'::jsonb),
    review_flags                = coalesce(p_review_flags, '[]'::jsonb),
    draft_revision              = purchase_receipts.draft_revision + 1
  WHERE id = v_receipt.id
  RETURNING * INTO v_receipt;

  -- Full replace: drafts are authored wholesale, never patched line by line.
  DELETE FROM public.purchase_receipt_items WHERE receipt_id = v_receipt.id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_ordinal := v_ordinal + 1;
    INSERT INTO public.purchase_receipt_items (
      receipt_id, item_ordinal, item_number,
      product_key, raw_product_text,
      quantity, unit_key, raw_unit,
      unit_cost, price_unit_text, source_evidence
    ) VALUES (
      v_receipt.id,
      v_ordinal,
      NULLIF(v_item->>'item_number', '')::bigint,
      v_item->>'product_key',
      v_item->>'raw_product_text',
      (v_item->>'quantity')::numeric,
      v_item->>'unit_key',
      v_item->>'raw_unit',
      NULLIF(v_item->>'unit_cost', '')::numeric,
      NULLIF(v_item->>'price_unit_text', ''),
      coalesce(v_item->'source_evidence', '{}'::jsonb)
    );
  END LOOP;

  INSERT INTO public.purchase_receipt_lifecycle_events (receipt_id, event, actor, detail)
  VALUES (
    v_receipt.id, 'drafted', p_actor,
    jsonb_build_object('draft_revision', v_receipt.draft_revision, 'item_count', v_count)
  );

  RETURN jsonb_build_object(
    'receipt_id',     v_receipt.id::text,
    'status',         v_receipt.status,
    'draft_revision', v_receipt.draft_revision,
    'item_count',     v_count
  );
END;
$$;

COMMENT ON FUNCTION public.upsert_purchase_receipt_draft IS
  'Atomically writes a purchase draft header + items (full item replace). '
  'Writes no inventory movement and no valuation.';

-- ── Idempotent confirm ───────────────────────────────────────────────────────

-- Confirm is idempotent on p_confirmation_key:
--   * first call freezes the document, stores the hash, returns the payload
--   * a redelivered call with the SAME key returns the SAME payload, unchanged
--   * a DIFFERENT key against an already-confirmed receipt is rejected, because
--     that means two different callers each believe they own the confirmation
CREATE OR REPLACE FUNCTION public.confirm_purchase_receipt(
  p_receipt_id             uuid,
  p_confirmation_key       text,
  p_expected_draft_revision bigint DEFAULT NULL,
  p_actor                  text   DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_receipt public.purchase_receipts;
  v_hash    text;
  v_items   integer;
BEGIN
  IF p_confirmation_key IS NULL OR btrim(p_confirmation_key) = '' THEN
    RAISE EXCEPTION 'confirmation_key must not be empty';
  END IF;

  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE id = p_receipt_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt % not found', p_receipt_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotent replay: same key, already confirmed -> return the original.
  IF v_receipt.status = 'confirmed' THEN
    IF v_receipt.confirmation_key IS DISTINCT FROM btrim(p_confirmation_key) THEN
      RAISE EXCEPTION
        'purchase receipt % already confirmed under a different confirmation_key',
        p_receipt_id
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object(
      'receipt_id',        v_receipt.id::text,
      'status',            v_receipt.status,
      'confirmation_key',  v_receipt.confirmation_key,
      'confirmation_hash', v_receipt.confirmation_hash,
      'confirmed_at',      v_receipt.confirmed_at,
      'replayed',          true,
      'payload',           public.purchase_receipt_confirmation_payload(v_receipt.id)
    );
  END IF;

  IF v_receipt.status <> 'draft' THEN
    RAISE EXCEPTION 'purchase receipt % is % and cannot be confirmed', p_receipt_id, v_receipt.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_expected_draft_revision IS NOT NULL
     AND p_expected_draft_revision <> v_receipt.draft_revision THEN
    RAISE EXCEPTION
      'purchase receipt % draft_revision moved (expected %, found %)',
      p_receipt_id, p_expected_draft_revision, v_receipt.draft_revision
      USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT count(*) INTO v_items
    FROM public.purchase_receipt_items WHERE receipt_id = v_receipt.id;
  IF v_items = 0 THEN
    RAISE EXCEPTION 'purchase receipt % has no items and cannot be confirmed', p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_items <> v_receipt.item_count THEN
    RAISE EXCEPTION
      'purchase receipt % item_count % disagrees with % stored items',
      p_receipt_id, v_receipt.item_count, v_items
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Hash the document as it stands, BEFORE flipping status, so the hash covers
  -- exactly the content being frozen.
  v_hash := public.purchase_receipt_confirmation_hash(v_receipt.id);

  UPDATE public.purchase_receipts SET
    status            = 'confirmed',
    confirmation_key  = btrim(p_confirmation_key),
    confirmation_hash = v_hash,
    confirmed_at      = now(),
    confirmed_by      = p_actor
  WHERE id = v_receipt.id
  RETURNING * INTO v_receipt;

  INSERT INTO public.purchase_receipt_lifecycle_events (receipt_id, event, actor, detail)
  VALUES (
    v_receipt.id, 'confirmed', p_actor,
    jsonb_build_object('confirmation_hash', v_hash, 'item_count', v_items)
  );

  RETURN jsonb_build_object(
    'receipt_id',        v_receipt.id::text,
    'status',            v_receipt.status,
    'confirmation_key',  v_receipt.confirmation_key,
    'confirmation_hash', v_receipt.confirmation_hash,
    'confirmed_at',      v_receipt.confirmed_at,
    'replayed',          false,
    'payload',           public.purchase_receipt_confirmation_payload(v_receipt.id)
  );
END;
$$;

COMMENT ON FUNCTION public.confirm_purchase_receipt IS
  'Idempotent confirm on confirmation_key. Freezes the document and returns the '
  'P2C confirmation contract. Writes no inventory movement and no valuation.';

-- ── Void ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.void_purchase_receipt(
  p_receipt_id uuid,
  p_reason     text,
  p_actor      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_receipt public.purchase_receipts;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'void reason is required';
  END IF;

  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE id = p_receipt_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt % not found', p_receipt_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotent: voiding an already-void receipt is a no-op, not an error.
  IF v_receipt.status = 'void' THEN
    RETURN jsonb_build_object(
      'receipt_id', v_receipt.id::text,
      'status',     v_receipt.status,
      'replayed',   true
    );
  END IF;

  UPDATE public.purchase_receipts SET
    status      = 'void',
    voided_at   = now(),
    voided_by   = p_actor,
    void_reason = btrim(p_reason)
  WHERE id = v_receipt.id
  RETURNING * INTO v_receipt;

  INSERT INTO public.purchase_receipt_lifecycle_events (receipt_id, event, actor, detail)
  VALUES (v_receipt.id, 'voided', p_actor, jsonb_build_object('reason', btrim(p_reason)));

  RETURN jsonb_build_object(
    'receipt_id', v_receipt.id::text,
    'status',     v_receipt.status,
    'replayed',   false
  );
END;
$$;

-- ── Read side for P2C ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_purchase_receipt_confirmation(
  p_receipt_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_receipt public.purchase_receipts;
BEGIN
  SELECT * INTO v_receipt FROM public.purchase_receipts WHERE id = p_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt % not found', p_receipt_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_receipt.status <> 'confirmed' THEN
    RAISE EXCEPTION
      'purchase receipt % is % — only confirmed receipts expose a confirmation contract',
      p_receipt_id, v_receipt.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN jsonb_build_object(
    'receipt_id',        v_receipt.id::text,
    'status',            v_receipt.status,
    'confirmation_key',  v_receipt.confirmation_key,
    'confirmation_hash', v_receipt.confirmation_hash,
    'confirmed_at',      v_receipt.confirmed_at,
    'payload',           public.purchase_receipt_confirmation_payload(v_receipt.id)
  );
END;
$$;

COMMENT ON FUNCTION public.get_purchase_receipt_confirmation(uuid) IS
  'P2C entry point. Returns the frozen confirmation contract for a confirmed '
  'receipt; refuses draft and void receipts.';

-- ── Privileges ───────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.purchase_receipt_confirmation_payload(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purchase_receipt_confirmation_payload(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_receipt_confirmation_payload(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.purchase_receipt_confirmation_hash(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purchase_receipt_confirmation_hash(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_receipt_confirmation_hash(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_purchase_receipt_draft(
  text, text, date, jsonb, time, text, text, text, text,
  bigint, bigint, bigint, text, bigint, boolean, boolean,
  text, text, text, text, uuid, jsonb, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_purchase_receipt_draft(
  text, text, date, jsonb, time, text, text, text, text,
  bigint, bigint, bigint, text, bigint, boolean, boolean,
  text, text, text, text, uuid, jsonb, jsonb, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_purchase_receipt_draft(
  text, text, date, jsonb, time, text, text, text, text,
  bigint, bigint, bigint, text, bigint, boolean, boolean,
  text, text, text, text, uuid, jsonb, jsonb, text
) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_purchase_receipt(uuid, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_purchase_receipt(uuid, text, bigint, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_purchase_receipt(uuid, text, bigint, text) TO service_role;

REVOKE ALL ON FUNCTION public.void_purchase_receipt(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_purchase_receipt(uuid, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_purchase_receipt(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.get_purchase_receipt_confirmation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_purchase_receipt_confirmation(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_purchase_receipt_confirmation(uuid) TO service_role;

REVOKE ALL ON TABLE public.purchase_receipts                 FROM PUBLIC;
REVOKE ALL ON TABLE public.purchase_receipt_items            FROM PUBLIC;
REVOKE ALL ON TABLE public.purchase_receipt_lifecycle_events FROM PUBLIC;

REVOKE ALL ON TABLE public.purchase_receipts                 FROM anon, authenticated;
REVOKE ALL ON TABLE public.purchase_receipt_items            FROM anon, authenticated;
REVOKE ALL ON TABLE public.purchase_receipt_lifecycle_events FROM anon, authenticated;

REVOKE ALL ON TABLE public.purchase_receipts                 FROM service_role;
REVOKE ALL ON TABLE public.purchase_receipt_items            FROM service_role;
REVOKE ALL ON TABLE public.purchase_receipt_lifecycle_events FROM service_role;

GRANT SELECT ON TABLE public.purchase_receipts                 TO service_role;
GRANT SELECT ON TABLE public.purchase_receipt_items            TO service_role;
GRANT SELECT ON TABLE public.purchase_receipt_lifecycle_events TO service_role;
