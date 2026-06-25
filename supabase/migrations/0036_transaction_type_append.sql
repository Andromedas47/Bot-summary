-- Add "ชั่งคืนเพิ่ม" as a distinct transaction type for append-return sessions.
-- ชั่งคืนเพิ่ม must not mutate prior produce_items rows; a new append session is
-- created and is_append_session=true is set on the produce_sessions row.
-- In reconciliation, ชั่งคืนเพิ่ม amounts count toward total return.

-- produce_items.transaction_type is TEXT with no explicit CHECK (enforced in
-- application layer). This comment documents the supported values.
-- Supported values after this migration:
--   เบิก | เบิกเพิ่ม | คืน | คืนเสีย | ชั่งคืนเพิ่ม

COMMENT ON COLUMN public.produce_items.transaction_type IS
  'Transaction type. Supported values: เบิก, เบิกเพิ่ม, คืน, คืนเสีย, ชั่งคืนเพิ่ม';
