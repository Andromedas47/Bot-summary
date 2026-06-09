-- Phase 2 structured extraction results for private slip evidence.
-- No client policies are added; webhook processing uses the service-role client.

CREATE TABLE public.slip_checks (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id           uuid        NOT NULL UNIQUE
                                  REFERENCES public.slip_evidences(id) ON DELETE CASCADE,
  status                text        NOT NULL,
  slip_type             text        NOT NULL DEFAULT 'UNKNOWN',
  gross_amount          numeric,
  discount_amount       numeric,
  paid_amount           numeric,
  transfer_amount       numeric,
  reference_id          text,
  transaction_time      timestamptz,
  sender_name           text,
  receiver_name         text,
  receiver_account_tail text,
  confidence            numeric,
  extracted_json        jsonb,
  failure_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT slip_checks_status_check
    CHECK (status IN (
      'PROCESSING',
      'EXTRACTED',
      'PARTIAL_EXTRACTED',
      'NEED_REVIEW',
      'FAILED'
    )),
  CONSTRAINT slip_checks_type_check
    CHECK (slip_type IN (
      'BANK_SLIP_QR',
      'BANK_SLIP_NO_QR',
      'THAI_HELP_THAI',
      'GWALLET',
      'NUMBERS_ONLY',
      'WHITE_PAPER',
      'UNKNOWN'
    )),
  CONSTRAINT slip_checks_amounts_check
    CHECK (
      (gross_amount IS NULL OR gross_amount >= 0)
      AND (discount_amount IS NULL OR discount_amount >= 0)
      AND (paid_amount IS NULL OR paid_amount >= 0)
      AND (transfer_amount IS NULL OR transfer_amount >= 0)
    ),
  CONSTRAINT slip_checks_confidence_check
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
);

CREATE INDEX slip_checks_status_created_idx
  ON public.slip_checks (status, created_at DESC);

CREATE INDEX slip_checks_transaction_time_idx
  ON public.slip_checks (transaction_time DESC)
  WHERE transaction_time IS NOT NULL;

ALTER TABLE public.slip_checks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.set_slip_check_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_slip_checks_updated_at
  BEFORE UPDATE ON public.slip_checks
  FOR EACH ROW EXECUTE FUNCTION public.set_slip_check_updated_at();
