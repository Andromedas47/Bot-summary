-- Cached daily aggregation per (date, staff, market).
-- Recalculated after every session save; produce_items remains source of truth.

CREATE TABLE daily_summaries (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_date        date        NOT NULL,
  staff_name          text        NOT NULL DEFAULT '',
  market_name         text        NOT NULL DEFAULT '',
  borrow_total        numeric     NOT NULL DEFAULT 0,
  return_total        numeric     NOT NULL DEFAULT 0,
  bad_return_total    numeric     NOT NULL DEFAULT 0,
  net_sales           numeric     NOT NULL DEFAULT 0,
  transaction_count   integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT daily_summaries_unique_key UNIQUE (summary_date, staff_name, market_name)
);

CREATE INDEX daily_summaries_date_idx       ON daily_summaries (summary_date);
CREATE INDEX daily_summaries_staff_idx      ON daily_summaries (staff_name);
CREATE INDEX daily_summaries_market_idx     ON daily_summaries (market_name);

ALTER TABLE daily_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY anon_read_daily_summaries ON daily_summaries FOR SELECT TO anon USING (true);
