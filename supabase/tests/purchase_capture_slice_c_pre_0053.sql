-- Disposable-DB only: remove Slice A/B inventory_movements stub so 0053 can CREATE TABLE.
DROP TABLE IF EXISTS public.inventory_movements CASCADE;

-- Restore FK after 0053 creates the real ledger table (see slice_c_post_0053.sql).
