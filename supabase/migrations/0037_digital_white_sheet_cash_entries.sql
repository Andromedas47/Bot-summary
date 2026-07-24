-- Digital White Sheet Core MVP — local persistence for operator-entered
-- expenses and submitted cash. Additive only; does not touch or dual-write
-- settlement_entries or settlement_finalizations.
--
-- Identity (see docs/core-white-sheet-integration.md "Market identity before
-- persistence"): the produce path has no persisted, authoritative market_key.
-- The only reproducible identity across the produce data path is
-- source_id + normalized market label + business_date. This migration uses
-- that as the uniqueness key. Caller-supplied marketKey is NOT used here —
-- two callers using different keys for the same source/label/date must not
-- be able to create duplicate rows.
--
-- Missing row means NOT SUBMITTED. Application code must never treat an
-- absent row as zero expenses / zero cash (see src/lib/white-sheet/persist.ts).
--
-- This table stores only operator-entered inputs. It does not persist any
-- derived/calculated value (expected sales, expected cash, difference,
-- status) — those remain the responsibility of calculateDigitalWhiteSheet
-- and are recomputed on every read.

CREATE TABLE public.digital_white_sheet_cash_entries (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id               text        NOT NULL,
  market_label_normalized text        NOT NULL,
  business_date           date        NOT NULL,

  labor                   numeric(12,2) NOT NULL DEFAULT 0,
  location_fee            numeric(12,2) NOT NULL DEFAULT 0,
  bag                     numeric(12,2) NOT NULL DEFAULT 0,
  snack                   numeric(12,2) NOT NULL DEFAULT 0,
  other                   numeric(12,2) NOT NULL DEFAULT 0,
  other_note              text,
  actual_cash_submitted   numeric(12,2) NOT NULL DEFAULT 0,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT digital_white_sheet_cash_entries_identity_key
    UNIQUE (source_id, market_label_normalized, business_date),

  CONSTRAINT digital_white_sheet_cash_entries_labor_nonneg
    CHECK (labor >= 0),
  CONSTRAINT digital_white_sheet_cash_entries_location_fee_nonneg
    CHECK (location_fee >= 0),
  CONSTRAINT digital_white_sheet_cash_entries_bag_nonneg
    CHECK (bag >= 0),
  CONSTRAINT digital_white_sheet_cash_entries_snack_nonneg
    CHECK (snack >= 0),
  CONSTRAINT digital_white_sheet_cash_entries_other_nonneg
    CHECK (other >= 0),
  CONSTRAINT digital_white_sheet_cash_entries_actual_cash_nonneg
    CHECK (actual_cash_submitted >= 0),
  CONSTRAINT digital_white_sheet_cash_entries_other_note_length
    CHECK (other_note IS NULL OR char_length(other_note) <= 1000)
);

-- Fast lookup for the exact identity the persistence service reads/writes by.
CREATE INDEX digital_white_sheet_cash_entries_lookup_idx
  ON public.digital_white_sheet_cash_entries (source_id, market_label_normalized, business_date);

ALTER TABLE public.digital_white_sheet_cash_entries ENABLE ROW LEVEL SECURITY;
-- No policies: same pattern as slip_batches/settlement_finalizations — only
-- the service-role server client (which bypasses RLS) reads/writes this
-- table. No new role system is introduced.

CREATE OR REPLACE FUNCTION public.set_digital_white_sheet_cash_entry_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_digital_white_sheet_cash_entries_updated_at
  BEFORE UPDATE ON public.digital_white_sheet_cash_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_digital_white_sheet_cash_entry_updated_at();
