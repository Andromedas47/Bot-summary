-- P2B Purchase Receipt persistence — purchase DOCUMENT layer only.
--
-- Slice B only: additive schema + draft/confirm/void RPCs + frozen confirmation
-- contract.
-- Does NOT write inventory movements (no ledger, no stock rows).
-- Does NOT write valuation / COGS / landed cost allocation.
-- Does NOT touch produce_sessions / pending_sessions / physical_inventory_* /
--   slip_* / white sheet / P0 / P1 / P2A.
-- Does NOT wire LINE webhooks.
--
-- Migration id 0052: origin/main highest applied is 0050; 0051 is reserved by
-- feat/guided-menu-identity-state-0051; 0042 and 0046 are reserved/frozen
-- (0046 = frozen purchase prototype — do not resurrect).
--
-- Relationship to P2B Slice A (src/lib/purchases, contract p2b-slice-a-v1):
--   Slice A parses LINE text into commands and NEVER touches the database
--   (enforced by src/lib/purchases/architecture.test.ts). This migration is the
--   persistence sink that a separate service module writes into. The parser's
--   numeric envelope is carried over verbatim and is NOT narrowed here:
--     quantity    numeric(18,6)   PURCHASE_QUANTITY_MAX_*
--     unit_cost   numeric(18,4)   PURCHASE_UNIT_RATE_MAX_*
--     document money integer satang, 15 digits / scale 2 (max 10^15 - 1 satang)
--     item count  <= 500          PURCHASE_MAX_ITEM_COUNT
--
--
-- ─── Money and the line-amount domain ───────────────────────────────────────
--
-- Every settled AMOUNT is an integer number of satang (1 baht = 100 satang),
-- never numeric/float, per BR-01 and the 0040 central-price precedent.
-- unit_cost is the ONLY numeric money-ish column and it is a RATE, not an
-- amount — it keeps the parser's 4dp envelope so a quoted rate is never
-- silently rounded on the way in.
--
-- line_amount_satang is exact `numeric`, NOT bigint. Reason (review finding):
-- the Slice A envelope admits quantity up to ~10^12 and unit_cost up to ~10^14,
-- whose product in satang reaches ~10^28 — far beyond bigint's 9.22*10^18. A
-- bigint generated column would raise a generic "bigint out of range" cast
-- failure on input the parser legitimately accepted. Widening the stored type
-- instead of narrowing the parser means:
--   * every value Slice A accepts is representable — no silent divergence
--     between what the parser admits and what persistence can store
--   * no generated-column cast can fail
--   * rounding stays exact and deterministic: round() on numeric is
--     half-away-from-zero and IMMUTABLE, so the value is replayable
-- Out-of-domain input is still rejected, but as an intentional, named business
-- error raised by the RPC (see purchase_receipt_assert_item_domain), never as a
-- generic overflow. Document-level satang columns stay bigint and carry an
-- explicit CHECK proving they sit inside the documented 10^15 envelope.
--
--
-- ─── Document identity ──────────────────────────────────────────────────────
--
-- A receipt is identified by (document_namespace, document_key), NOT by a
-- delivery event id. Delivery identity (source_line_event_id,
-- source_raw_message_id) is stored SEPARATELY and is explicitly allowed to
-- differ between redeliveries of the same document.
--
-- document_key is normalized before both lookup and insert by
-- purchase_receipt_normalize_document_key(): NFC, internal whitespace runs
-- collapsed to one space, then trimmed. Lookup and insert therefore can never
-- disagree about whitespace, and '  A  B ' and 'A B' are one document.
--
-- The identity is bound to its source. A draft carrying a key that already
-- exists under a DIFFERENT source binding (source_type, source_id) FAILS CLOSED
-- rather than replacing the existing document wholesale — arbitrary caller text
-- must never be able to overwrite an unrelated draft.
--
-- Per-path contract:
--
--   webhook redelivery
--     Same document_key, same source binding. The redelivered draft updates in
--     place and replaces its items wholesale. source_line_event_id may differ
--     and is overwritten as latest-delivery metadata. No fork, no duplicate lines.
--
--   multi-message LINE purchase document
--     All chunks of one document share one document_key (the caller derives it
--     from the document-opening event, not from each message). Each subsequent
--     write is a full replace of the assembled document, so partial assembly
--     never accumulates.
--
--   staff correction of an existing draft
--     Same document_key while the receipt is still `draft`: replace in place.
--     Once CONFIRMED the document is frozen — correction is expressed as a NEW
--     receipt carrying supersedes_receipt_id (see the correction model below),
--     never as an edit.
--
--   staff resending a genuinely new document
--     A new document_key. Callers must not reuse a key across distinct
--     documents; the source binding check is the backstop that turns an
--     accidental reuse from a different conversation into a hard failure
--     instead of silent data loss.
--
--   future Guided Menu / postback purchase session
--     namespace 'guided-postback' with document_key = the durable guided
--     session id. The namespace column exists so that a guided session id can
--     never collide with a LINE-text document key.
--
-- purchase_receipt_document_namespaces is a real table, not a CHECK list, so a
-- future path can register a namespace without a migration to widen an enum.
--
--
-- ─── Frozen confirmation snapshot ───────────────────────────────────────────
--
-- Confirming stores an IMMUTABLE snapshot of the confirmation payload plus the
-- versions needed to interpret it:
--     confirmation_payload           the frozen document (jsonb)
--     confirmation_contract_version  payload schema version
--     confirmation_canonical_form    how the payload was serialized for hashing
--     confirmation_hash_algorithm    'sha256'
--     confirmation_hash              hash of the EXACT stored snapshot
--
-- The hash is taken over purchase_receipt_canonical_json(), an explicit
-- key-sorted serializer owned by this migration — NOT over jsonb::text.
-- jsonb::text is an implementation detail of PostgreSQL's internal key ordering
-- and is not a contract we can promise to external consumers across versions.
--
-- The getter returns the STORED snapshot. It never recomputes the payload from
-- the live tables, so a confirmed document read back years later is exactly the
-- document that was confirmed.
--
--
-- ─── Void, correction, and the P2C handoff ──────────────────────────────────
--
-- Void does not erase the confirmation. get_purchase_receipt_confirmation
-- keeps returning the frozen payload after void, alongside current lifecycle
-- state, void metadata, and correction metadata as SEPARATE fields — historical
-- access survives, and a consumer can always tell "what was confirmed" apart
-- from "what is true now".
--
-- Correction model: a confirmed receipt is never edited. A correcting document
-- is a NEW receipt declaring supersedes_receipt_id; confirming it stamps the
-- superseded receipt's superseded_by_receipt_id and records a 'superseded'
-- lifecycle event on the target. The link is one-to-one in both directions.
--
-- P2B does NOT implement inventory reversal — that is P2C. What P2B provides is
-- the safety hook: once P2C has posted movements for a receipt it calls
-- lock_purchase_receipt_for_posting(), and void_purchase_receipt() then refuses
-- a standalone void. That forces the future atomic "document void + ledger
-- reversal" to go through one P2C transaction instead of allowing the document
-- to be voided out from under posted stock.
--
-- P2C dedupe identity (exact, stable):
--     'purchase-receipt-confirmation:v1:' || receipt_id || ':' || confirmation_hash
-- exposed as p2c_dedupe_key. receipt_id alone is insufficient (a receipt could
-- in principle be re-confirmed under a future correction flow); the hash pins
-- the exact content that was posted.
--
--
-- ─── Posting blockers ───────────────────────────────────────────────────────
--
-- P2B deliberately ACCEPTS an incomplete source document — staff reality wins
-- over schema purity. What it must not do is let P2C/P2D discover the gaps by
-- accident. Every gap is therefore emitted as a structured, machine-readable
-- blocker in the frozen payload (code / severity / affected item ordinals), so
-- downstream fail-closed behaviour is a data decision, not a guess.
--
-- A missing unit cost is NEVER represented as zero: the line amount stays NULL,
-- the subtotal becomes non-computable, and MISSING_UNIT_COST is raised.
--
--
-- ─── Privilege model (mirrors 0047) ─────────────────────────────────────────
--   anon / authenticated: no table DML/SELECT; no RPC EXECUTE
--   service_role: SELECT on tables; mutation only via SECURITY DEFINER RPCs
--   RPCs: SECURITY DEFINER, fixed search_path, REVOKE PUBLIC/anon/authenticated,
--         GRANT EXECUTE TO service_role only
--   Trigger guards are intentionally NOT SECURITY DEFINER: they must run as the
--   mutating role, and DEFINER there would be privilege escalation for no gain.

-- WITH SCHEMA applies only when pgcrypto is absent; IF NOT EXISTS does not
-- relocate an extension that is already installed.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Contract constants ───────────────────────────────────────────────────────

-- Documented envelope, kept in one place so SQL and TypeScript cite the same
-- numbers. These MATCH Slice A; they do not narrow it.
--   quantity   : numeric(18,6)  -> |q| < 10^12
--   unit_cost  : numeric(18,4)  -> |r| < 10^14
--   doc money  : < 10^15 satang
CREATE OR REPLACE FUNCTION public.purchase_receipt_max_document_satang()
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 999999999999999::bigint $$;

COMMENT ON FUNCTION public.purchase_receipt_max_document_satang() IS
  'Documented document-money envelope: 15 digits at scale 2 => 10^15-1 satang. '
  'Below Number.MAX_SAFE_INTEGER, but these values still cross the wire as '
  'strings — see the bigint handling note in the service layer.';

-- ── Document namespaces ──────────────────────────────────────────────────────

CREATE TABLE public.purchase_receipt_document_namespaces (
  namespace   text        PRIMARY KEY CHECK (namespace ~ '^[a-z][a-z0-9-]{2,31}$'),
  description text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.purchase_receipt_document_namespaces IS
  'Registry of document identity namespaces. A table rather than a CHECK list so '
  'a future intake path can register without a schema migration.';

INSERT INTO public.purchase_receipt_document_namespaces (namespace, description) VALUES
  ('line-text',       'Document assembled from LINE text chunks (Slice A parser).'),
  ('guided-postback', 'Document authored through a guided menu / postback session.'),
  ('manual-entry',    'Document keyed in directly by staff tooling.');

-- ── Identity normalization ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_receipt_normalize_document_key(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- NFC, collapse internal whitespace runs to a single space, then trim.
  -- Applied to BOTH lookup and insert so the two can never disagree.
  SELECT nullif(btrim(regexp_replace(normalize(p_key, NFC), '\s+', ' ', 'g')), '');
$$;

COMMENT ON FUNCTION public.purchase_receipt_normalize_document_key(text) IS
  'Canonical document key: NFC + collapsed internal whitespace + trim. Returns '
  'NULL for blank input so a blank key can never become an identity.';

-- ── Canonical JSON (hash input) ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_receipt_canonical_json(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_type  text := jsonb_typeof(p_value);
  v_parts text[] := ARRAY[]::text[];
  v_key   text;
  v_elem  jsonb;
BEGIN
  IF p_value IS NULL OR v_type = 'null' THEN
    RETURN 'null';
  END IF;

  IF v_type = 'object' THEN
    -- COLLATE "C": bytewise key order, independent of database locale, so the
    -- serialization is identical on every machine that replays it.
    FOR v_key IN
      SELECT k FROM jsonb_object_keys(p_value) AS k ORDER BY k COLLATE "C"
    LOOP
      v_parts := v_parts
        || (to_json(v_key)::text || ':'
            || public.purchase_receipt_canonical_json(p_value -> v_key));
    END LOOP;
    RETURN '{' || array_to_string(v_parts, ',') || '}';
  END IF;

  IF v_type = 'array' THEN
    -- Array order is significant and preserved as stored.
    FOR v_elem IN SELECT e FROM jsonb_array_elements(p_value) AS e
    LOOP
      v_parts := v_parts || public.purchase_receipt_canonical_json(v_elem);
    END LOOP;
    RETURN '[' || array_to_string(v_parts, ',') || ']';
  END IF;

  IF v_type = 'string' THEN
    RETURN to_json(p_value #>> '{}')::text;
  END IF;

  -- number / boolean render canonically from jsonb already.
  RETURN p_value::text;
END;
$$;

COMMENT ON FUNCTION public.purchase_receipt_canonical_json(jsonb) IS
  'Canonical form purchase-receipt-canonical-json-v1: recursively key-sorted '
  '(COLLATE "C") compact JSON. Owned by this migration so the hash input is a '
  'contract, not a side effect of PostgreSQL jsonb::text ordering.';

-- ── Receipts (document header) ───────────────────────────────────────────────

CREATE TABLE public.purchase_receipts (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Document identity: namespace + normalized key. NOT a delivery event id.
  document_namespace        text        NOT NULL
    REFERENCES public.purchase_receipt_document_namespaces(namespace),
  document_key              text        NOT NULL
    CHECK (document_key = public.purchase_receipt_normalize_document_key(document_key)),

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
  supplier_ref              text        CHECK (supplier_ref IS NULL OR length(btrim(supplier_ref)) > 0),

  reference_text            text        CHECK (reference_text IS NULL OR length(btrim(reference_text)) > 0),

  -- Declared destination only. 0052 posts NO movement, so this is intent.
  intended_warehouse_code   text        NOT NULL DEFAULT 'MAIN'
    CHECK (intended_warehouse_code = 'MAIN'),

  -- Document-level settled amounts, integer satang, bounded by the documented
  -- envelope so an out-of-domain amount is a named CHECK failure, not overflow.
  freight_satang            bigint      NOT NULL DEFAULT 0,
  handling_satang           bigint      NOT NULL DEFAULT 0,
  discount_satang           bigint      NOT NULL DEFAULT 0,

  vat_kind                  text        NOT NULL DEFAULT 'NONE'
    CHECK (vat_kind IN ('NONE', 'AMOUNT')),
  vat_satang                bigint,
  vat_included_in_item_prices boolean,
  vat_recoverable           boolean,

  item_count                integer     NOT NULL DEFAULT 0
    CHECK (item_count >= 0 AND item_count <= 500),

  -- Source / delivery evidence. Deliberately separate from document identity:
  -- these may change between redeliveries of the SAME document.
  source_type               text        CHECK (source_type IS NULL OR source_type IN ('user', 'group', 'room')),
  source_id                 text        CHECK (source_id IS NULL OR length(btrim(source_id)) > 0),
  sender_line_user_id       text        CHECK (sender_line_user_id IS NULL OR length(btrim(sender_line_user_id)) > 0),
  source_line_event_id      text        CHECK (source_line_event_id IS NULL OR length(btrim(source_line_event_id)) > 0),
  source_raw_message_id     uuid        REFERENCES public.raw_messages(id),
  source_evidence           jsonb       NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_evidence) = 'object'),
  review_flags              jsonb       NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(review_flags) = 'array'),

  -- Optimistic-concurrency token for draft replacement.
  draft_revision            bigint      NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),

  -- Frozen confirmation snapshot.
  confirmation_key          text        CHECK (confirmation_key IS NULL OR length(btrim(confirmation_key)) > 0),
  confirmation_payload      jsonb       CHECK (confirmation_payload IS NULL OR jsonb_typeof(confirmation_payload) = 'object'),
  confirmation_contract_version text,
  confirmation_canonical_form   text,
  confirmation_hash_algorithm   text,
  confirmation_hash         text        CHECK (confirmation_hash IS NULL OR confirmation_hash ~ '^[0-9a-f]{64}$'),
  confirmed_at              timestamptz,
  confirmed_by              text,

  -- Correction / supersession linkage.
  supersedes_receipt_id     uuid        REFERENCES public.purchase_receipts(id),
  superseded_by_receipt_id  uuid        REFERENCES public.purchase_receipts(id),

  -- P2C posting hook: set once movements exist, blocks standalone void.
  posting_locked_at         timestamptz,
  posting_locked_by         text,

  voided_at                 timestamptz,
  voided_by                 text,
  void_reason               text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  UNIQUE (document_namespace, document_key),
  UNIQUE (confirmation_key),
  UNIQUE (superseded_by_receipt_id),
  UNIQUE (supersedes_receipt_id),

  CONSTRAINT purchase_receipts_freight_envelope
    CHECK (freight_satang  BETWEEN 0 AND public.purchase_receipt_max_document_satang()),
  CONSTRAINT purchase_receipts_handling_envelope
    CHECK (handling_satang BETWEEN 0 AND public.purchase_receipt_max_document_satang()),
  CONSTRAINT purchase_receipts_discount_envelope
    CHECK (discount_satang BETWEEN 0 AND public.purchase_receipt_max_document_satang()),
  CONSTRAINT purchase_receipts_vat_envelope
    CHECK (vat_satang IS NULL
           OR vat_satang BETWEEN 0 AND public.purchase_receipt_max_document_satang()),

  -- A confirmed receipt carries a COMPLETE frozen snapshot.
  CONSTRAINT purchase_receipts_confirmed_complete
    CHECK (
      status <> 'confirmed'
      OR (
        confirmation_key              IS NOT NULL
        AND confirmation_hash         IS NOT NULL
        AND confirmation_payload      IS NOT NULL
        AND confirmation_contract_version IS NOT NULL
        AND confirmation_canonical_form   IS NOT NULL
        AND confirmation_hash_algorithm   IS NOT NULL
        AND confirmed_at              IS NOT NULL
        AND item_count > 0
      )
    ),
  CONSTRAINT purchase_receipts_draft_unconfirmed
    CHECK (
      status <> 'draft'
      OR (confirmation_key IS NULL AND confirmation_hash IS NULL
          AND confirmation_payload IS NULL AND confirmed_at IS NULL)
    ),
  CONSTRAINT purchase_receipts_void_audited
    CHECK (status <> 'void' OR voided_at IS NOT NULL),
  CONSTRAINT purchase_receipts_unvoided_clean
    CHECK (status = 'void' OR (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)),
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
    CHECK ((supplier_key IS NULL) = (supplier_raw IS NULL)),
  CONSTRAINT purchase_receipts_no_self_supersede
    CHECK (supersedes_receipt_id IS DISTINCT FROM id
           AND superseded_by_receipt_id IS DISTINCT FROM id),
  CONSTRAINT purchase_receipts_posting_lock_paired
    CHECK ((posting_locked_at IS NULL) = (posting_locked_by IS NULL))
);

COMMENT ON TABLE public.purchase_receipts IS
  'P2B purchase DOCUMENT header (draft/confirmed/void). Confirming never writes '
  'inventory movements, valuation, or COGS — those are P2C.';

COMMENT ON COLUMN public.purchase_receipts.document_key IS
  'Normalized document identity within its namespace. NOT a delivery event id — '
  'redelivery of the same document reuses this key.';

COMMENT ON COLUMN public.purchase_receipts.source_line_event_id IS
  'Latest DELIVERY event id. Deliberately separate from document identity and '
  'expected to change across redeliveries.';

COMMENT ON COLUMN public.purchase_receipts.confirmation_payload IS
  'Immutable frozen snapshot of the confirmation contract as confirmed. Readers '
  'get this stored value, never a recomputation from live tables.';

COMMENT ON COLUMN public.purchase_receipts.posting_locked_at IS
  'Set by P2C once movements are posted. Blocks standalone void so document void '
  'and ledger reversal must happen together.';

CREATE INDEX purchase_receipts_business_date_idx
  ON public.purchase_receipts (business_date, status);

CREATE INDEX purchase_receipts_supplier_idx
  ON public.purchase_receipts (supplier_key, business_date)
  WHERE supplier_key IS NOT NULL;

CREATE INDEX purchase_receipts_status_confirmed_idx
  ON public.purchase_receipts (status, confirmed_at DESC)
  WHERE status = 'confirmed';

CREATE INDEX purchase_receipts_source_idx
  ON public.purchase_receipts (source_type, source_id)
  WHERE source_id IS NOT NULL;

-- ── Receipt items ────────────────────────────────────────────────────────────

CREATE TABLE public.purchase_receipt_items (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id            uuid          NOT NULL
    REFERENCES public.purchase_receipts(id) ON DELETE CASCADE,

  item_ordinal          integer       NOT NULL CHECK (item_ordinal > 0 AND item_ordinal <= 500),
  -- Staff-entered line number, kept as evidence. Unbounded in the source, so it
  -- crosses the service boundary as a string.
  item_number           bigint        CHECK (item_number IS NULL OR item_number > 0),

  -- Product normalized identity (application-canonical, never computed in SQL).
  product_key           text          NOT NULL CHECK (length(btrim(product_key)) > 0),
  raw_product_text      text          NOT NULL CHECK (length(btrim(raw_product_text)) > 0),
  -- Whether product_key is a real resolved identity or a raw-text fallback.
  product_identity_status text        NOT NULL DEFAULT 'RESOLVED'
    CHECK (product_identity_status IN ('RESOLVED', 'UNRESOLVED')),

  quantity              numeric(18,6) NOT NULL CHECK (quantity > 0),
  unit_key              text          NOT NULL CHECK (length(btrim(unit_key)) > 0),
  raw_unit              text          NOT NULL CHECK (length(btrim(raw_unit)) > 0),
  unit_identity_status  text          NOT NULL DEFAULT 'RESOLVED'
    CHECK (unit_identity_status IN ('RESOLVED', 'UNRESOLVED')),

  -- Quoted rate per unit in BAHT. NULL = no rate stated on the document
  -- (Slice A MISSING_UNIT_RATE). NEVER coerced to zero.
  unit_cost             numeric(18,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  -- Unit the rate was quoted against when it differs from unit_key
  -- (Slice A PRICE_UNIT_REQUIRES_RESOLUTION). Evidence only; 0052 never converts.
  price_unit_text       text          CHECK (price_unit_text IS NULL OR length(btrim(price_unit_text)) > 0),
  price_unit_status     text          NOT NULL DEFAULT 'NOT_APPLICABLE'
    CHECK (price_unit_status IN ('NOT_APPLICABLE', 'RESOLVED', 'UNRESOLVED')),

  -- Settled line amount in satang. EXACT numeric, not bigint: see the header
  -- note. Derived, never caller-supplied, so the document total cannot drift
  -- from its own lines. round() on numeric is half-away-from-zero and IMMUTABLE.
  line_amount_satang    numeric       GENERATED ALWAYS AS (
    CASE WHEN unit_cost IS NULL THEN NULL
         ELSE round(quantity * unit_cost * 100)
    END
  ) STORED,

  source_evidence       jsonb         NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_evidence) = 'object'),

  created_at            timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (receipt_id, item_ordinal),
  CONSTRAINT purchase_receipt_items_price_unit_needs_rate
    CHECK (price_unit_text IS NULL OR unit_cost IS NOT NULL),
  CONSTRAINT purchase_receipt_items_price_unit_status_paired
    CHECK ((price_unit_text IS NULL) = (price_unit_status = 'NOT_APPLICABLE'))
);

COMMENT ON TABLE public.purchase_receipt_items IS
  'P2B purchase document lines. Product identity is application-canonical '
  'product_key/unit_key; raw_* keep verbatim staff text as evidence.';

COMMENT ON COLUMN public.purchase_receipt_items.line_amount_satang IS
  'Generated exact numeric: round(quantity * unit_cost * 100), half away from '
  'zero. NULL when the document stated no unit rate — never zero.';

COMMENT ON COLUMN public.purchase_receipt_items.product_identity_status IS
  'UNRESOLVED means product_key is a raw-text fallback, not a canonical identity. '
  'Surfaces as an UNRESOLVED_PRODUCT_IDENTITY blocker in the frozen contract.';

-- The UNIQUE (receipt_id, item_ordinal) index already serves receipt_id-prefixed
-- lookups, so a separate (receipt_id, item_ordinal) index would be redundant.
CREATE INDEX purchase_receipt_items_product_idx
  ON public.purchase_receipt_items (product_key, unit_key);

-- ── Lifecycle audit (append-only) ────────────────────────────────────────────

CREATE TABLE public.purchase_receipt_lifecycle_events (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id   uuid        NOT NULL REFERENCES public.purchase_receipts(id),
  event        text        NOT NULL
    CHECK (event IN ('drafted', 'confirmed', 'voided', 'superseded', 'posting_locked')),
  actor        text,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.purchase_receipt_lifecycle_events.id IS
  'Monotonic sequence. bigint, so it crosses the service boundary as a string.';

CREATE INDEX purchase_receipt_lifecycle_events_receipt_idx
  ON public.purchase_receipt_lifecycle_events (receipt_id, id);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.purchase_receipts                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_receipt_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_receipt_lifecycle_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_receipt_document_namespaces ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: RLS enabled with no policy denies every non-BYPASSRLS
-- role. service_role has BYPASSRLS but is separately stripped of table DML, so
-- mutation can only happen inside the SECURITY DEFINER RPCs.

-- ── Immutability guards ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_receipt_forbid_confirmed_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_receipt_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.receipt_id ELSE NEW.receipt_id END;
  v_status     text;
BEGIN
  -- FOR UPDATE is the race fix: taking the PARENT row lock makes any item DML
  -- serialize against confirm_purchase_receipt(), which locks the same row.
  -- Whichever transaction gets there first, the other blocks and then re-reads
  -- the committed status — so item DML begun while draft can never commit after
  -- the receipt has become confirmed.
  SELECT status INTO v_status
    FROM public.purchase_receipts
   WHERE id = v_receipt_id
     FOR UPDATE;

  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'purchase_receipt_items are immutable once the receipt leaves draft (status=%)',
      coalesce(v_status, '<missing>')
      USING ERRCODE = 'invalid_parameter_value';
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
DECLARE
  -- The ONLY columns that may change after confirmation. Everything else —
  -- including any column added by a future migration — is frozen by default,
  -- which is why this is an allow-list diff rather than a hand-listed deny-list
  -- that someone must remember to extend.
  v_mutable_after_confirm CONSTANT text[] := ARRAY[
    'status', 'voided_at', 'voided_by', 'void_reason',
    'superseded_by_receipt_id', 'posting_locked_at', 'posting_locked_by',
    'updated_at'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_receipts rows must not be deleted (void instead)';
  END IF;

  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'purchase_receipts status=void is terminal and immutable'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF OLD.status = 'confirmed' THEN
    IF NEW.status NOT IN ('confirmed', 'void') THEN
      RAISE EXCEPTION 'illegal purchase receipt transition confirmed -> %', NEW.status
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF (to_jsonb(OLD) - v_mutable_after_confirm)
       IS DISTINCT FROM (to_jsonb(NEW) - v_mutable_after_confirm) THEN
      RAISE EXCEPTION
        'confirmed purchase receipt is immutable except for void/supersede/posting-lock metadata'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'confirmed', 'void') THEN
    RAISE EXCEPTION 'illegal purchase receipt transition draft -> %', NEW.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Document identity never moves, in any state.
  IF NEW.document_key IS DISTINCT FROM OLD.document_key
     OR NEW.document_namespace IS DISTINCT FROM OLD.document_namespace THEN
    RAISE EXCEPTION 'document identity is immutable'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF OLD.confirmation_key IS NOT NULL
     AND NEW.confirmation_key IS DISTINCT FROM OLD.confirmation_key THEN
    RAISE EXCEPTION 'confirmation_key is immutable once set';
  END IF;
  IF OLD.confirmation_hash IS NOT NULL
     AND NEW.confirmation_hash IS DISTINCT FROM OLD.confirmation_hash THEN
    RAISE EXCEPTION 'confirmation_hash is immutable once set';
  END IF;
  IF OLD.confirmation_payload IS NOT NULL
     AND NEW.confirmation_payload IS DISTINCT FROM OLD.confirmation_payload THEN
    RAISE EXCEPTION 'confirmation_payload is immutable once set';
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

-- ── Domain assertion for item input ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_receipt_assert_item_domain(
  p_ordinal   integer,
  p_quantity  numeric,
  p_unit_cost numeric
) RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  -- Explicit, named business errors. Without these the column casts would raise
  -- a generic "numeric field overflow" that tells an operator nothing.
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'item %: quantity must be greater than zero', p_ordinal
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF trunc(abs(p_quantity)) >= 10::numeric ^ 12 THEN
    RAISE EXCEPTION
      'item %: quantity % exceeds the documented numeric(18,6) envelope', p_ordinal, p_quantity
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_unit_cost IS NOT NULL THEN
    IF p_unit_cost < 0 THEN
      RAISE EXCEPTION 'item %: unit_cost must not be negative', p_ordinal
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF trunc(abs(p_unit_cost)) >= 10::numeric ^ 14 THEN
      RAISE EXCEPTION
        'item %: unit_cost % exceeds the documented numeric(18,4) envelope', p_ordinal, p_unit_cost
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.purchase_receipt_assert_item_domain(integer, numeric, numeric) IS
  'Rejects out-of-envelope item input with an intentional business error before '
  'any column cast can raise a generic overflow.';

-- ── Confirmation payload ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_receipt_build_confirmation_payload(
  p_receipt_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  r                 public.purchase_receipts;
  v_items           jsonb;
  v_blockers        jsonb := '[]'::jsonb;
  v_missing_cost    integer;
  v_unresolved_prod integer;
  v_unresolved_unit integer;
  v_unresolved_pu   integer;
  v_subtotal        numeric;
  v_payable         numeric;
  v_recon_status    text;
BEGIN
  SELECT * INTO r FROM public.purchase_receipts WHERE id = p_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt % not found', p_receipt_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             -- Stable item identity so P2C can address a line directly.
             'receipt_item_id',        i.id::text,
             'item_ordinal',           i.item_ordinal,
             'item_number',            CASE WHEN i.item_number IS NULL THEN NULL
                                            ELSE i.item_number::text END,
             'product_key',            i.product_key,
             'raw_product_text',       i.raw_product_text,
             'product_identity_status', i.product_identity_status,
             'quantity',               trim_scale(i.quantity)::text,
             'unit_key',               i.unit_key,
             'raw_unit',               i.raw_unit,
             'unit_identity_status',   i.unit_identity_status,
             'unit_cost',              CASE WHEN i.unit_cost IS NULL THEN NULL
                                            ELSE trim_scale(i.unit_cost)::text END,
             'price_unit_text',        i.price_unit_text,
             'price_unit_status',      i.price_unit_status,
             'line_amount_satang',     CASE WHEN i.line_amount_satang IS NULL THEN NULL
                                            ELSE i.line_amount_satang::text END,
             'source_evidence',        i.source_evidence
           ) ORDER BY i.item_ordinal
         ), '[]'::jsonb)
    INTO v_items
    FROM public.purchase_receipt_items i
   WHERE i.receipt_id = r.id;

  SELECT
    count(*) FILTER (WHERE i.unit_cost IS NULL),
    count(*) FILTER (WHERE i.product_identity_status = 'UNRESOLVED'),
    count(*) FILTER (WHERE i.unit_identity_status = 'UNRESOLVED'),
    count(*) FILTER (WHERE i.price_unit_status = 'UNRESOLVED'),
    sum(i.line_amount_satang)
    INTO v_missing_cost, v_unresolved_prod, v_unresolved_unit, v_unresolved_pu, v_subtotal
    FROM public.purchase_receipt_items i
   WHERE i.receipt_id = r.id;

  -- A missing rate makes the subtotal NON-COMPUTABLE. It is never treated as 0.
  IF v_missing_cost > 0 THEN
    v_subtotal := NULL;
  END IF;

  -- Structured blockers: every gap that must make P2C/P2D fail closed.
  IF v_missing_cost > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'MISSING_UNIT_COST', 'severity', 'BLOCKING',
      'item_count', v_missing_cost,
      'item_ordinals', (SELECT coalesce(jsonb_agg(i.item_ordinal ORDER BY i.item_ordinal), '[]'::jsonb)
                          FROM public.purchase_receipt_items i
                         WHERE i.receipt_id = r.id AND i.unit_cost IS NULL),
      'detail', 'Document stated no unit rate for these lines; amount is NULL, not zero.'));
  END IF;

  IF v_unresolved_prod > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'UNRESOLVED_PRODUCT_IDENTITY', 'severity', 'BLOCKING',
      'item_count', v_unresolved_prod,
      'item_ordinals', (SELECT coalesce(jsonb_agg(i.item_ordinal ORDER BY i.item_ordinal), '[]'::jsonb)
                          FROM public.purchase_receipt_items i
                         WHERE i.receipt_id = r.id AND i.product_identity_status = 'UNRESOLVED'),
      'detail', 'product_key is a raw-text fallback, not a canonical identity.'));
  END IF;

  IF v_unresolved_unit > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'UNRESOLVED_UNIT_IDENTITY', 'severity', 'BLOCKING',
      'item_count', v_unresolved_unit,
      'item_ordinals', (SELECT coalesce(jsonb_agg(i.item_ordinal ORDER BY i.item_ordinal), '[]'::jsonb)
                          FROM public.purchase_receipt_items i
                         WHERE i.receipt_id = r.id AND i.unit_identity_status = 'UNRESOLVED'),
      'detail', 'unit_key is a raw-text fallback, not a canonical identity.'));
  END IF;

  IF v_unresolved_pu > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'UNRESOLVED_PRICE_UNIT', 'severity', 'BLOCKING',
      'item_count', v_unresolved_pu,
      'item_ordinals', (SELECT coalesce(jsonb_agg(i.item_ordinal ORDER BY i.item_ordinal), '[]'::jsonb)
                          FROM public.purchase_receipt_items i
                         WHERE i.receipt_id = r.id AND i.price_unit_status = 'UNRESOLVED'),
      'detail', 'Rate was quoted against a different unit; 0052 performs no conversion.'));
  END IF;

  IF jsonb_array_length(r.review_flags) > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'SOURCE_REVIEW_FLAGS', 'severity', 'REVIEW',
      'item_count', jsonb_array_length(r.review_flags),
      'item_ordinals', '[]'::jsonb,
      'detail', 'Slice A raised review flags on this document.',
      'flags', r.review_flags));
  END IF;

  -- Destination is constrained to MAIN today; the blocker exists so a future
  -- multi-location intake reports an unresolved destination the same way.
  IF r.intended_warehouse_code IS NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'UNRESOLVED_DESTINATION', 'severity', 'BLOCKING',
      'item_count', 0, 'item_ordinals', '[]'::jsonb,
      'detail', 'No destination declared on the document.'));
  END IF;

  -- Totals. Slice A captures NO declared document/invoice total (its COSTS block
  -- carries only freight, handling, discount and VAT), so v1 does not invent one
  -- and payable-total RECONCILIATION against a declared figure is unavailable.
  IF v_subtotal IS NULL THEN
    v_payable      := NULL;
    v_recon_status := 'NOT_COMPUTABLE_MISSING_UNIT_COST';
  ELSE
    v_payable := v_subtotal + r.freight_satang + r.handling_satang - r.discount_satang
      + CASE WHEN r.vat_kind = 'AMOUNT' AND r.vat_included_in_item_prices IS FALSE
             THEN r.vat_satang ELSE 0 END;
    v_recon_status := 'COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE';
  END IF;

  RETURN jsonb_build_object(
    'contract_version',        'p2b-purchase-confirm-v1',
    'receipt_id',              r.id::text,
    -- Frozen document identity.
    'document_namespace',      r.document_namespace,
    'document_key',            r.document_key,
    'parser_contract_version', r.contract_version,
    -- Frozen source / delivery identity.
    'source', jsonb_build_object(
      'source_type',           r.source_type,
      'source_id',             r.source_id,
      'sender_line_user_id',   r.sender_line_user_id,
      'source_line_event_id',  r.source_line_event_id,
      'source_raw_message_id', CASE WHEN r.source_raw_message_id IS NULL THEN NULL
                                    ELSE r.source_raw_message_id::text END,
      'source_evidence',       r.source_evidence
    ),
    'business_date',           to_char(r.business_date, 'YYYY-MM-DD'),
    'purchase_time',           CASE WHEN r.purchase_time IS NULL THEN NULL
                                    ELSE to_char(r.purchase_time, 'HH24:MI') END,
    'supplier_key',            r.supplier_key,
    'supplier_raw',            r.supplier_raw,
    'supplier_ref',            r.supplier_ref,
    'reference_text',          r.reference_text,
    'intended_warehouse_code', r.intended_warehouse_code,
    'vat_kind',                r.vat_kind,
    'vat_included_in_item_prices', r.vat_included_in_item_prices,
    'vat_recoverable',         r.vat_recoverable,
    'item_count',              r.item_count,
    'items',                   v_items,
    'totals', jsonb_build_object(
      'line_subtotal_satang',  CASE WHEN v_subtotal IS NULL THEN NULL ELSE v_subtotal::text END,
      'freight_satang',        r.freight_satang::text,
      'handling_satang',       r.handling_satang::text,
      'discount_satang',       r.discount_satang::text,
      'vat_satang',            CASE WHEN r.vat_satang IS NULL THEN NULL ELSE r.vat_satang::text END,
      'payable_total_satang',  CASE WHEN v_payable IS NULL THEN NULL ELSE v_payable::text END,
      'declared_total_satang', NULL,
      'reconciliation_status', v_recon_status
    ),
    'blockers',                v_blockers,
    'has_blocking_blockers',   EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_blockers) AS b
       WHERE b->>'severity' = 'BLOCKING'),
    -- Explicit, machine-readable statement of what 0052 did NOT do.
    'posts_inventory_movement', false,
    'posts_valuation',          false
  );
END;
$$;

COMMENT ON FUNCTION public.purchase_receipt_build_confirmation_payload(uuid) IS
  'Builds the P2B confirmation contract (p2b-purchase-confirm-v1) from live '
  'tables. Called ONCE at confirm time; readers get the frozen snapshot instead.';

-- ── Draft write (full replace) ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_purchase_receipt_draft(
  p_document_namespace      text,
  p_document_key            text,
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
  p_supersedes_receipt_id   uuid    DEFAULT NULL,
  p_actor                   text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_receipt public.purchase_receipts;
  v_key     text;
  v_item    jsonb;
  v_ordinal integer := 0;
  v_count   integer;
  v_qty     numeric;
  v_cost    numeric;
BEGIN
  -- Normalize ONCE, then use the same value for lookup and insert.
  v_key := public.purchase_receipt_normalize_document_key(p_document_key);
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'document_key must not be blank'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_document_namespace IS NULL THEN
    RAISE EXCEPTION 'document_namespace is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'items must be a JSON array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_count := jsonb_array_length(p_items);
  IF v_count > 500 THEN
    RAISE EXCEPTION 'items exceed the 500-line document limit (got %)', v_count
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock first so two concurrent drafts of the same document serialize.
  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE document_namespace = p_document_namespace AND document_key = v_key
     FOR UPDATE;

  IF FOUND THEN
    -- Fail closed when the same identity arrives bound to a DIFFERENT source.
    -- Arbitrary caller text must never silently replace an unrelated draft.
    IF (v_receipt.source_type IS DISTINCT FROM p_source_type)
       OR (v_receipt.source_id IS DISTINCT FROM p_source_id) THEN
      RAISE EXCEPTION
        'document %/% already exists under a different source binding (stored %/%, got %/%)',
        p_document_namespace, v_key,
        coalesce(v_receipt.source_type, '<null>'), coalesce(v_receipt.source_id, '<null>'),
        coalesce(p_source_type, '<null>'), coalesce(p_source_id, '<null>')
        USING ERRCODE = 'unique_violation';
    END IF;

    IF v_receipt.status <> 'draft' THEN
      RAISE EXCEPTION
        'purchase receipt % is % and can no longer be drafted', v_receipt.id, v_receipt.status
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    INSERT INTO public.purchase_receipts (
      document_namespace, document_key, contract_version, business_date, purchase_time,
      supplier_key, supplier_raw, supplier_ref, reference_text,
      freight_satang, handling_satang, discount_satang,
      vat_kind, vat_satang, vat_included_in_item_prices, vat_recoverable,
      item_count, source_type, source_id, sender_line_user_id,
      source_line_event_id, source_raw_message_id, source_evidence, review_flags,
      supersedes_receipt_id, draft_revision
    ) VALUES (
      p_document_namespace, v_key, p_contract_version, p_business_date, p_purchase_time,
      p_supplier_key, p_supplier_raw, p_supplier_ref, p_reference_text,
      coalesce(p_freight_satang, 0), coalesce(p_handling_satang, 0),
      coalesce(p_discount_satang, 0),
      coalesce(p_vat_kind, 'NONE'), p_vat_satang,
      p_vat_included_in_item_prices, p_vat_recoverable,
      v_count, p_source_type, p_source_id, p_sender_line_user_id,
      p_source_line_event_id, p_source_raw_message_id,
      coalesce(p_source_evidence, '{}'::jsonb), coalesce(p_review_flags, '[]'::jsonb),
      p_supersedes_receipt_id,
      -- Seeded at 0: the UPDATE below is the single path that assigns field
      -- values, so it also owns the bump. A first draft lands on 1.
      0
    )
    -- Concurrent first-draft race: the UNIQUE index is the backstop.
    ON CONFLICT (document_namespace, document_key) DO NOTHING
    RETURNING * INTO v_receipt;

    IF NOT FOUND THEN
      -- Lost the insert race; adopt the winner under the same rules.
      SELECT * INTO v_receipt
        FROM public.purchase_receipts
       WHERE document_namespace = p_document_namespace AND document_key = v_key
         FOR UPDATE;
      IF (v_receipt.source_type IS DISTINCT FROM p_source_type)
         OR (v_receipt.source_id IS DISTINCT FROM p_source_id) THEN
        RAISE EXCEPTION
          'document %/% already exists under a different source binding',
          p_document_namespace, v_key
          USING ERRCODE = 'unique_violation';
      END IF;
      IF v_receipt.status <> 'draft' THEN
        RAISE EXCEPTION
          'purchase receipt % is % and can no longer be drafted', v_receipt.id, v_receipt.status
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
    -- Latest DELIVERY metadata; identity is unaffected.
    source_line_event_id        = p_source_line_event_id,
    source_raw_message_id       = p_source_raw_message_id,
    source_evidence             = coalesce(p_source_evidence, '{}'::jsonb),
    review_flags                = coalesce(p_review_flags, '[]'::jsonb),
    supersedes_receipt_id       = p_supersedes_receipt_id,
    draft_revision              = purchase_receipts.draft_revision + 1
  WHERE id = v_receipt.id
  RETURNING * INTO v_receipt;

  -- Full replace: drafts are authored wholesale, never patched line by line.
  DELETE FROM public.purchase_receipt_items WHERE receipt_id = v_receipt.id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_ordinal := v_ordinal + 1;
    v_qty  := NULLIF(v_item->>'quantity', '')::numeric;
    v_cost := NULLIF(v_item->>'unit_cost', '')::numeric;
    PERFORM public.purchase_receipt_assert_item_domain(v_ordinal, v_qty, v_cost);

    INSERT INTO public.purchase_receipt_items (
      receipt_id, item_ordinal, item_number,
      product_key, raw_product_text, product_identity_status,
      quantity, unit_key, raw_unit, unit_identity_status,
      unit_cost, price_unit_text, price_unit_status, source_evidence
    ) VALUES (
      v_receipt.id,
      v_ordinal,
      NULLIF(v_item->>'item_number', '')::bigint,
      v_item->>'product_key',
      v_item->>'raw_product_text',
      coalesce(NULLIF(v_item->>'product_identity_status', ''), 'RESOLVED'),
      v_qty,
      v_item->>'unit_key',
      v_item->>'raw_unit',
      coalesce(NULLIF(v_item->>'unit_identity_status', ''), 'RESOLVED'),
      v_cost,
      NULLIF(v_item->>'price_unit_text', ''),
      coalesce(
        NULLIF(v_item->>'price_unit_status', ''),
        CASE WHEN NULLIF(v_item->>'price_unit_text', '') IS NULL
             THEN 'NOT_APPLICABLE' ELSE 'UNRESOLVED' END),
      coalesce(v_item->'source_evidence', '{}'::jsonb)
    );
  END LOOP;

  INSERT INTO public.purchase_receipt_lifecycle_events (receipt_id, event, actor, detail)
  VALUES (
    v_receipt.id, 'drafted', p_actor,
    jsonb_build_object('draft_revision', v_receipt.draft_revision, 'item_count', v_count)
  );

  RETURN jsonb_build_object(
    'receipt_id',         v_receipt.id::text,
    'document_namespace', v_receipt.document_namespace,
    'document_key',       v_receipt.document_key,
    'status',             v_receipt.status,
    'draft_revision',     v_receipt.draft_revision::text,
    'item_count',         v_count
  );
END;
$$;

COMMENT ON FUNCTION public.upsert_purchase_receipt_draft IS
  'Atomically writes a purchase draft header + items (full item replace). Fails '
  'closed on a document-key collision from a different source. Writes no '
  'inventory movement and no valuation.';

-- ── Idempotent confirm ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.confirm_purchase_receipt(
  p_receipt_id              uuid,
  p_confirmation_key        text,
  p_expected_draft_revision bigint DEFAULT NULL,
  p_actor                   text   DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_receipt public.purchase_receipts;
  v_payload jsonb;
  v_hash    text;
  v_items   integer;
BEGIN
  IF p_confirmation_key IS NULL OR btrim(p_confirmation_key) = '' THEN
    RAISE EXCEPTION 'confirmation_key must not be empty'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Same row lock the item trigger takes: item DML and confirm serialize.
  SELECT * INTO v_receipt
    FROM public.purchase_receipts
   WHERE id = p_receipt_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt % not found', p_receipt_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotent replay: same key, already confirmed -> return the frozen snapshot.
  IF v_receipt.status = 'confirmed' THEN
    IF v_receipt.confirmation_key IS DISTINCT FROM btrim(p_confirmation_key) THEN
      RAISE EXCEPTION
        'purchase receipt % already confirmed under a different confirmation_key',
        p_receipt_id
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN public.get_purchase_receipt_confirmation(v_receipt.id) || jsonb_build_object('replayed', true);
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

  -- Build the snapshot, then hash the EXACT snapshot being stored.
  v_payload := public.purchase_receipt_build_confirmation_payload(v_receipt.id);
  v_hash := encode(
    extensions.digest(
      convert_to(public.purchase_receipt_canonical_json(v_payload), 'UTF8'), 'sha256'),
    'hex');

  UPDATE public.purchase_receipts SET
    status                        = 'confirmed',
    confirmation_key              = btrim(p_confirmation_key),
    confirmation_payload          = v_payload,
    confirmation_contract_version = v_payload->>'contract_version',
    confirmation_canonical_form   = 'purchase-receipt-canonical-json-v1',
    confirmation_hash_algorithm   = 'sha256',
    confirmation_hash             = v_hash,
    confirmed_at                  = now(),
    confirmed_by                  = p_actor
  WHERE id = v_receipt.id
  RETURNING * INTO v_receipt;

  -- Correction linkage: stamp the superseded document.
  IF v_receipt.supersedes_receipt_id IS NOT NULL THEN
    UPDATE public.purchase_receipts
       SET superseded_by_receipt_id = v_receipt.id
     WHERE id = v_receipt.supersedes_receipt_id;

    INSERT INTO public.purchase_receipt_lifecycle_events (receipt_id, event, actor, detail)
    VALUES (v_receipt.supersedes_receipt_id, 'superseded', p_actor,
            jsonb_build_object('superseded_by_receipt_id', v_receipt.id::text));
  END IF;

  INSERT INTO public.purchase_receipt_lifecycle_events (receipt_id, event, actor, detail)
  VALUES (
    v_receipt.id, 'confirmed', p_actor,
    jsonb_build_object('confirmation_hash', v_hash, 'item_count', v_items)
  );

  RETURN public.get_purchase_receipt_confirmation(v_receipt.id) || jsonb_build_object('replayed', false);
END;
$$;

COMMENT ON FUNCTION public.confirm_purchase_receipt IS
  'Idempotent confirm on confirmation_key. Freezes an immutable snapshot of the '
  'P2C contract plus its hash. Writes no inventory movement and no valuation.';

-- ── Posting lock (P2C extension hook) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lock_purchase_receipt_for_posting(
  p_receipt_id uuid,
  p_locked_by  text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_receipt public.purchase_receipts;
BEGIN
  IF p_locked_by IS NULL OR btrim(p_locked_by) = '' THEN
    RAISE EXCEPTION 'locked_by is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_receipt FROM public.purchase_receipts
   WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase receipt % not found', p_receipt_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_receipt.status <> 'confirmed' THEN
    RAISE EXCEPTION 'only a confirmed purchase receipt can be locked for posting (status=%)',
      v_receipt.status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_receipt.posting_locked_at IS NOT NULL THEN
    RETURN jsonb_build_object('receipt_id', v_receipt.id::text, 'replayed', true);
  END IF;

  UPDATE public.purchase_receipts
     SET posting_locked_at = now(), posting_locked_by = btrim(p_locked_by)
   WHERE id = v_receipt.id;

  INSERT INTO public.purchase_receipt_lifecycle_events (receipt_id, event, actor, detail)
  VALUES (v_receipt.id, 'posting_locked', p_locked_by, '{}'::jsonb);

  RETURN jsonb_build_object('receipt_id', v_receipt.id::text, 'replayed', false);
END;
$$;

COMMENT ON FUNCTION public.lock_purchase_receipt_for_posting(uuid, text) IS
  'P2C extension hook. Once set, void_purchase_receipt refuses a standalone void '
  'so document void and ledger reversal must happen in one P2C transaction.';

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
    RAISE EXCEPTION 'void reason is required'
      USING ERRCODE = 'invalid_parameter_value';
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
      'receipt_id', v_receipt.id::text, 'status', v_receipt.status, 'replayed', true);
  END IF;

  -- Safety hook: once P2C has posted movements, a standalone document void
  -- would strand the ledger. P2C must reverse and void in one transaction.
  IF v_receipt.posting_locked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'purchase receipt % is locked for posting by % — void must be performed together with ledger reversal',
      v_receipt.id, v_receipt.posting_locked_by
      USING ERRCODE = 'invalid_parameter_value';
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
    'receipt_id', v_receipt.id::text, 'status', v_receipt.status, 'replayed', false);
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
  -- A receipt that was never confirmed has no contract to expose. A VOIDED
  -- receipt that WAS confirmed still does — history survives the void.
  IF v_receipt.confirmation_payload IS NULL THEN
    RAISE EXCEPTION
      'purchase receipt % has never been confirmed — no confirmation contract exists',
      p_receipt_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN jsonb_build_object(
    'receipt_id', v_receipt.id::text,
    -- The frozen contract, returned verbatim as stored. Never recomputed.
    'confirmation', jsonb_build_object(
      'contract_version',  v_receipt.confirmation_contract_version,
      'canonical_form',    v_receipt.confirmation_canonical_form,
      'hash_algorithm',    v_receipt.confirmation_hash_algorithm,
      'hash',              v_receipt.confirmation_hash,
      'confirmation_key',  v_receipt.confirmation_key,
      'confirmed_at',      v_receipt.confirmed_at,
      'confirmed_by',      v_receipt.confirmed_by,
      'payload',           v_receipt.confirmation_payload
    ),
    -- Current truth, kept SEPARATE from the frozen contract.
    'lifecycle', jsonb_build_object(
      'status',            v_receipt.status,
      'posting_locked_at', v_receipt.posting_locked_at,
      'posting_locked_by', v_receipt.posting_locked_by
    ),
    'void', CASE WHEN v_receipt.status = 'void' THEN jsonb_build_object(
      'voided_at',   v_receipt.voided_at,
      'voided_by',   v_receipt.voided_by,
      'void_reason', v_receipt.void_reason
    ) ELSE NULL END,
    'correction', jsonb_build_object(
      'supersedes_receipt_id',    CASE WHEN v_receipt.supersedes_receipt_id IS NULL THEN NULL
                                       ELSE v_receipt.supersedes_receipt_id::text END,
      'superseded_by_receipt_id', CASE WHEN v_receipt.superseded_by_receipt_id IS NULL THEN NULL
                                       ELSE v_receipt.superseded_by_receipt_id::text END
    ),
    -- Exact dedupe identity for P2C.
    'p2c_dedupe_key',
      'purchase-receipt-confirmation:v1:' || v_receipt.id::text || ':' || v_receipt.confirmation_hash
  );
END;
$$;

COMMENT ON FUNCTION public.get_purchase_receipt_confirmation(uuid) IS
  'P2C entry point. Returns the STORED frozen contract plus current lifecycle, '
  'void and correction metadata as separate fields. Survives void.';

-- ── Privileges ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE '%purchase_receipt%'
       AND p.prorettype <> 'trigger'::regtype::oid
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END
$$;

REVOKE ALL ON TABLE public.purchase_receipts                    FROM PUBLIC;
REVOKE ALL ON TABLE public.purchase_receipt_items               FROM PUBLIC;
REVOKE ALL ON TABLE public.purchase_receipt_lifecycle_events    FROM PUBLIC;
REVOKE ALL ON TABLE public.purchase_receipt_document_namespaces FROM PUBLIC;

REVOKE ALL ON TABLE public.purchase_receipts                    FROM anon, authenticated;
REVOKE ALL ON TABLE public.purchase_receipt_items               FROM anon, authenticated;
REVOKE ALL ON TABLE public.purchase_receipt_lifecycle_events    FROM anon, authenticated;
REVOKE ALL ON TABLE public.purchase_receipt_document_namespaces FROM anon, authenticated;

REVOKE ALL ON TABLE public.purchase_receipts                    FROM service_role;
REVOKE ALL ON TABLE public.purchase_receipt_items               FROM service_role;
REVOKE ALL ON TABLE public.purchase_receipt_lifecycle_events    FROM service_role;
REVOKE ALL ON TABLE public.purchase_receipt_document_namespaces FROM service_role;

GRANT SELECT ON TABLE public.purchase_receipts                    TO service_role;
GRANT SELECT ON TABLE public.purchase_receipt_items               TO service_role;
GRANT SELECT ON TABLE public.purchase_receipt_lifecycle_events    TO service_role;
GRANT SELECT ON TABLE public.purchase_receipt_document_namespaces TO service_role;
