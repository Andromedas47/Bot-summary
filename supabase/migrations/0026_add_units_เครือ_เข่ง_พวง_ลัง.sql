-- Extend the unit check constraint to support เครือ (whole banana stalk),
-- เข่ง (basket/crate), พวง (cluster, e.g. grapes/longan), and ลัง (case/crate).
ALTER TABLE produce_items
  DROP CONSTRAINT IF EXISTS produce_items_unit_check;

ALTER TABLE produce_items
  ADD CONSTRAINT produce_items_unit_check
  CHECK (unit IN ('โล', 'ลูก', 'กล่อง', 'แพค', 'กำ', 'มัด', 'ถุง', 'หัว', 'หวี', 'เครือ', 'เข่ง', 'พวง', 'ลัง'));
