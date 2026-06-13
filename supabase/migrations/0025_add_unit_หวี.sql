-- Extend the unit check constraint to support หวี (hand/bunch, e.g. bananas).
ALTER TABLE produce_items
  DROP CONSTRAINT IF EXISTS produce_items_unit_check;

ALTER TABLE produce_items
  ADD CONSTRAINT produce_items_unit_check
  CHECK (unit IN ('โล', 'ลูก', 'กล่อง', 'แพค', 'กำ', 'มัด', 'ถุง', 'หัว', 'หวี'));
