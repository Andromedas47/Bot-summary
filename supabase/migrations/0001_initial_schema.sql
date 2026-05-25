-- ═══════════════════════════════════════════════════════════════════
-- Migration 0001 — Initial schema
-- Tables: raw_messages · weigh_entries · parse_errors
-- ═══════════════════════════════════════════════════════════════════

-- ─── Extensions ──────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ─── Enum types ──────────────────────────────────────────────────────

create type public.line_source_type as enum (
  'user',
  'group',
  'room'
);

create type public.line_event_type as enum (
  'message',
  'follow',
  'unfollow',
  'join',
  'leave',
  'memberJoined',
  'memberLeft',
  'postback',
  'beacon',
  'accountLink',
  'unsend',
  'videoPlayComplete'
);

create type public.line_message_type as enum (
  'text',
  'image',
  'video',
  'audio',
  'file',
  'location',
  'sticker',
  'imagemap',
  'template',
  'flex'
);

create type public.parse_error_type as enum (
  'format_error',       -- message text didn't match expected pattern
  'validation_error',   -- value out of acceptable range
  'unknown_format',     -- no parser could handle this message
  'parser_crash',       -- unhandled exception inside parser
  'timeout',            -- parser exceeded time limit
  'unsupported_type'    -- message type (image, sticker, …) not yet supported
);

-- ═══════════════════════════════════════════════════════════════════
-- Table: raw_messages
-- Every LINE webhook event is stored here verbatim.
-- Idempotent via UNIQUE(line_event_id) — duplicate deliveries are ignored.
-- ═══════════════════════════════════════════════════════════════════
create table public.raw_messages (
  id              uuid                      primary key default gen_random_uuid(),

  -- LINE identifiers
  line_event_id   text                      not null,
  destination     text                      not null,   -- LINE channel userId
  event_type      public.line_event_type    not null,
  source_type     public.line_source_type   not null,
  source_id       text                      not null,   -- userId | groupId | roomId
  user_id         text,                                 -- individual userId (null in anonymous group sources)

  -- Message fields (null for non-message events like follow/unfollow)
  message_id      text,
  message_type    public.line_message_type,
  raw_text        text,                                 -- text content when message_type = 'text'

  -- Full payload preserved for re-processing
  payload         jsonb                     not null,

  -- Processing state
  is_processed    boolean                   not null default false,
  processed_at    timestamptz,

  created_at      timestamptz               not null default now(),

  constraint raw_messages_line_event_id_unique unique (line_event_id),
  constraint raw_messages_processed_at_check
    check (processed_at is null or is_processed = true)
);

-- ═══════════════════════════════════════════════════════════════════
-- Table: weigh_entries
-- Structured weight data parsed from raw_messages.
-- One raw_message can produce at most one weigh_entry.
-- ═══════════════════════════════════════════════════════════════════
create table public.weigh_entries (
  id              uuid        primary key default gen_random_uuid(),
  raw_message_id  uuid        not null
                              references public.raw_messages (id)
                              on delete cascade,

  -- Denormalised for query performance (avoids join for per-user history)
  line_user_id    text        not null,

  -- Core measurement
  weight_kg       numeric(6, 3) not null,

  -- Optional body composition fields (future parsers can populate these)
  body_fat_pct    numeric(5, 2),
  muscle_mass_kg  numeric(6, 3),
  bmi             numeric(5, 2),

  -- Free-form note extracted alongside the measurement
  note            text,

  -- When the user actually took the measurement (defaults to message time)
  recorded_at     timestamptz not null default now(),

  created_at      timestamptz not null default now(),

  constraint weigh_entries_raw_message_id_unique unique (raw_message_id),
  constraint weigh_entries_weight_range    check (weight_kg    > 0   and weight_kg    < 999),
  constraint weigh_entries_body_fat_range  check (body_fat_pct >= 0  and body_fat_pct <= 100),
  constraint weigh_entries_muscle_range    check (muscle_mass_kg > 0 and muscle_mass_kg < weight_kg),
  constraint weigh_entries_bmi_range       check (bmi > 0 and bmi < 100)
);

-- ═══════════════════════════════════════════════════════════════════
-- Table: parse_errors
-- Records every failed parse attempt for debugging and retry.
-- Multiple errors can exist for the same raw_message (if retried).
-- ═══════════════════════════════════════════════════════════════════
create table public.parse_errors (
  id              uuid                      primary key default gen_random_uuid(),
  raw_message_id  uuid                      not null
                                            references public.raw_messages (id)
                                            on delete cascade,

  -- Parser that attempted (and failed)
  parser_name     text                      not null,
  parser_version  text                      not null default '1.0.0',

  -- Error classification
  error_type      public.parse_error_type   not null,
  error_message   text                      not null,
  error_detail    jsonb,          -- stack trace, regex match groups, raw value, etc.

  created_at      timestamptz               not null default now()
);

-- ═══════════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════════

-- raw_messages ─────────────────────────────────────────────────────

-- Primary time-range scan (dashboard pagination)
create index idx_raw_messages_created_at
  on public.raw_messages (created_at desc);

-- Per-user message history
create index idx_raw_messages_user_id
  on public.raw_messages (user_id)
  where user_id is not null;

-- Filter by event type
create index idx_raw_messages_event_type
  on public.raw_messages (event_type);

-- Filter by message type
create index idx_raw_messages_message_type
  on public.raw_messages (message_type)
  where message_type is not null;

-- Processing queue: SELECT … WHERE NOT is_processed
create index idx_raw_messages_unprocessed
  on public.raw_messages (created_at)
  where is_processed = false;

-- Lookup by LINE source (group/room)
create index idx_raw_messages_source_id
  on public.raw_messages (source_id);

-- weigh_entries ────────────────────────────────────────────────────

-- Per-user weight history (most common dashboard query)
create index idx_weigh_entries_user_recorded
  on public.weigh_entries (line_user_id, recorded_at desc);

-- Global timeline
create index idx_weigh_entries_recorded_at
  on public.weigh_entries (recorded_at desc);

-- Join back to source message
create index idx_weigh_entries_raw_message_id
  on public.weigh_entries (raw_message_id);

-- parse_errors ─────────────────────────────────────────────────────

-- Recent error feed
create index idx_parse_errors_created_at
  on public.parse_errors (created_at desc);

-- Filter by error type
create index idx_parse_errors_error_type
  on public.parse_errors (error_type);

-- Filter by parser name (debug which parser is failing most)
create index idx_parse_errors_parser_name
  on public.parse_errors (parser_name);

-- Join back to source message
create index idx_parse_errors_raw_message_id
  on public.parse_errors (raw_message_id);

-- ═══════════════════════════════════════════════════════════════════
-- Trigger: auto-update processed_at when is_processed flips to true
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.set_processed_at()
returns trigger language plpgsql as $$
begin
  if new.is_processed = true and old.is_processed = false then
    new.processed_at = now();
  end if;
  return new;
end;
$$;

create trigger trg_raw_messages_processed_at
  before update on public.raw_messages
  for each row execute function public.set_processed_at();

-- ═══════════════════════════════════════════════════════════════════
-- Row-Level Security
-- Anon key  → read-only (dashboard)
-- Service role → bypasses RLS entirely (webhook writes)
-- ═══════════════════════════════════════════════════════════════════
alter table public.raw_messages   enable row level security;
alter table public.weigh_entries  enable row level security;
alter table public.parse_errors   enable row level security;

create policy "anon_read_raw_messages"
  on public.raw_messages for select using (true);

create policy "anon_read_weigh_entries"
  on public.weigh_entries for select using (true);

create policy "anon_read_parse_errors"
  on public.parse_errors for select using (true);
