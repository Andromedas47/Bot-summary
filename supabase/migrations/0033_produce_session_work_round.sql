-- Link produce_sessions to a Work Round.
-- Nullable so that historical rows and legacy-path sessions can remain without a
-- work_round_id; V2 sessions will always have one.
--
-- is_append_session flags "ชั่งคืนเพิ่ม" append sessions that must not mutate
-- prior produce_items rows.  Append sessions count toward return totals in
-- reconciliation but are stored as separate sessions for full audit history.

ALTER TABLE public.produce_sessions
  ADD COLUMN work_round_id     uuid REFERENCES public.work_rounds(id),
  ADD COLUMN is_append_session boolean NOT NULL DEFAULT false;

CREATE INDEX produce_sessions_work_round_id_idx
  ON public.produce_sessions (work_round_id)
  WHERE work_round_id IS NOT NULL;
