-- Settlement entries: manual เงินโอน / เงินสด per financial-summary group.
-- Key: (date, time, staff, market) — mirrors the GroupRow key in the Financial Summary page.
-- settlement_time stores "" when the session has no transaction_time.

CREATE TABLE public.settlement_entries (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_date DATE          NOT NULL,
  settlement_time TEXT          NOT NULL DEFAULT '',
  staff_name      TEXT          NOT NULL DEFAULT '',
  market_name     TEXT          NOT NULL DEFAULT '',
  money_transfer  NUMERIC(12,2) NOT NULL DEFAULT 0,
  money_cash      NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (settlement_date, settlement_time, staff_name, market_name)
);

COMMENT ON TABLE public.settlement_entries IS
  'Manual settlement values entered on the Financial Summary page. '
  'One row per (date × time × seller × market) group. Never auto-populated.';
