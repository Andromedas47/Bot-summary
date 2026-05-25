-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────
-- Raw events table
-- Stores every webhook event from LINE verbatim.
-- Idempotent: event_id is unique so retried deliveries are ignored.
-- ─────────────────────────────────────────────
create table if not exists public.line_raw_events (
  id            uuid        primary key default gen_random_uuid(),
  event_id      text        not null unique,       -- LINE's webhookEventId
  destination   text        not null,              -- LINE channel user ID
  event_type    text        not null,              -- message | follow | unfollow | …
  message_type  text,                              -- text | image | video | … (nullable for non-message events)
  source_type   text        not null,              -- user | group | room
  source_id     text        not null,              -- userId / groupId / roomId
  user_id       text,                              -- individual userId when known
  payload       jsonb       not null,              -- full raw event payload
  created_at    timestamptz not null default now()
);

-- Index for time-based queries and pagination
create index if not exists idx_raw_events_created_at
  on public.line_raw_events (created_at desc);

-- Index for filtering by event type
create index if not exists idx_raw_events_event_type
  on public.line_raw_events (event_type);

-- Index for looking up events by source
create index if not exists idx_raw_events_source_id
  on public.line_raw_events (source_id);

-- ─────────────────────────────────────────────
-- Parsed messages table
-- Stores structured output from parser modules.
-- A single raw event can have at most one parsed record.
-- ─────────────────────────────────────────────
create table if not exists public.parsed_messages (
  id              uuid        primary key default gen_random_uuid(),
  raw_event_id    uuid        not null references public.line_raw_events (id) on delete cascade,
  parser_name     text        not null,
  parser_version  text        not null default '1.0.0',
  parsed_data     jsonb       not null default '{}',
  status          text        not null default 'pending'
                              check (status in ('pending', 'parsed', 'error')),
  error_message   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Index for status-based filtering
create index if not exists idx_parsed_status
  on public.parsed_messages (status);

-- Index for joining back to raw events
create index if not exists idx_parsed_raw_event_id
  on public.parsed_messages (raw_event_id);

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger trg_parsed_messages_updated_at
  before update on public.parsed_messages
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────
-- Row-Level Security
-- Anon key can read; service role bypasses RLS for webhook writes.
-- ─────────────────────────────────────────────
alter table public.line_raw_events  enable row level security;
alter table public.parsed_messages  enable row level security;

-- Allow authenticated users (or anon, adjust as needed) to read
create policy "Allow read for authenticated"
  on public.line_raw_events for select
  using (true);

create policy "Allow read for authenticated"
  on public.parsed_messages for select
  using (true);
