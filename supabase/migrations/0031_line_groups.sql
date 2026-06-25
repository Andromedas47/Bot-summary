-- LINE group registry.
-- Stores display metadata for each LINE source (group/room) that sends events.
-- source_id is the LINE groupId / roomId — the reply-destination identifier only.
-- There is NO one-to-one mapping to a single seller or market; a group may contain
-- multiple sellers, markets, and work rounds on the same business date.

CREATE TABLE public.line_groups (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    text        NOT NULL,
  display_name text,
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id)
);

CREATE INDEX line_groups_active_idx ON public.line_groups (active) WHERE active = true;

ALTER TABLE public.line_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_read_line_groups ON public.line_groups FOR SELECT TO anon USING (true);
