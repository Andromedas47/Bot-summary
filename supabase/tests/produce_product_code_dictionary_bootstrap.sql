-- Disposable-DB bootstrap for the Produce Product Code Dictionary migration.
-- Does NOT touch Production. Run against an empty local database only.
--
-- The dictionary migration is standalone: it creates one table, seeds it, and
-- takes no foreign key. So this bootstrap only has to supply what every
-- Supabase migration in this repo assumes exists — the three platform roles and
-- the public schema grant — plus a produce_transactions stand-in the historical
-- immutability assertions can count rows in.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE service_role WITH BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- A minimal stand-in for the produce history the migration must not touch.
-- Only the columns the immutability assertions read are modelled.
CREATE TABLE public.produce_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name     text NOT NULL,
  unit             text,
  quantity         numeric(10,3),
  price_per_unit   numeric(10,2),
  transaction_type text NOT NULL,
  transaction_date date NOT NULL
);

-- Two rows standing in for the 2026-08-11 history that was deliberately left
-- unrepaired: one spelling that has a code, one that never will.
INSERT INTO public.produce_transactions
  (product_name, unit, quantity, price_per_unit, transaction_type, transaction_date)
VALUES
  ('กล้วยน้ำว้า',   'โล', 8.000, 35.00, 'เบิก', DATE '2026-08-11'),
  ('เขียวมรกตเก่า', 'โล', 2.000, 80.00, 'เบิก', DATE '2026-08-11');
