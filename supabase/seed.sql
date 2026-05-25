-- ═══════════════════════════════════════════════════════════════════
-- Seed data — development only
-- Run after 0001_initial_schema.sql
-- ═══════════════════════════════════════════════════════════════════

-- ─── Deterministic UUIDs so seed is idempotent ──────────────────────
-- raw_messages
\set msg1  '\'00000000-0000-0000-0001-000000000001\''
\set msg2  '\'00000000-0000-0000-0001-000000000002\''
\set msg3  '\'00000000-0000-0000-0001-000000000003\''
\set msg4  '\'00000000-0000-0000-0001-000000000004\''
\set msg5  '\'00000000-0000-0000-0001-000000000005\''
\set msg6  '\'00000000-0000-0000-0001-000000000006\''

-- weigh_entries
\set we1   '\'00000000-0000-0000-0002-000000000001\''
\set we2   '\'00000000-0000-0000-0002-000000000002\''
\set we3   '\'00000000-0000-0000-0002-000000000003\''
\set we4   '\'00000000-0000-0000-0002-000000000004\''
\set we5   '\'00000000-0000-0000-0002-000000000005\''

-- parse_errors
\set pe1   '\'00000000-0000-0000-0003-000000000001\''
\set pe2   '\'00000000-0000-0000-0003-000000000002\''

-- ─── raw_messages ────────────────────────────────────────────────────
insert into public.raw_messages (
  id, line_event_id, destination, event_type, source_type,
  source_id, user_id, message_id, message_type, raw_text,
  payload, is_processed, processed_at, created_at
) values

-- Somchai: plain weight
(
  :msg1,
  'evt-somchai-001',
  'Uc8a6b9d2e1f3a4b5c6d7e8f9a0b1c2d3',
  'message',
  'user',
  'Ucafe1234cafe1234cafe1234cafe1234a',
  'Ucafe1234cafe1234cafe1234cafe1234a',
  'msg-somchai-001',
  'text',
  '75.3',
  '{"type":"message","webhookEventId":"evt-somchai-001","timestamp":1748131200000,"source":{"type":"user","userId":"Ucafe1234cafe1234cafe1234cafe1234a"},"message":{"type":"text","id":"msg-somchai-001","text":"75.3","quoteToken":"q1"}}'::jsonb,
  true,
  now() - interval '2 days',
  now() - interval '2 days'
),

-- Somchai: weight with note
(
  :msg2,
  'evt-somchai-002',
  'Uc8a6b9d2e1f3a4b5c6d7e8f9a0b1c2d3',
  'message',
  'user',
  'Ucafe1234cafe1234cafe1234cafe1234a',
  'Ucafe1234cafe1234cafe1234cafe1234a',
  'msg-somchai-002',
  'text',
  '74.8 หลังออกกำลังกาย',
  '{"type":"message","webhookEventId":"evt-somchai-002","timestamp":1748217600000,"source":{"type":"user","userId":"Ucafe1234cafe1234cafe1234cafe1234a"},"message":{"type":"text","id":"msg-somchai-002","text":"74.8 หลังออกกำลังกาย","quoteToken":"q2"}}'::jsonb,
  true,
  now() - interval '1 day',
  now() - interval '1 day'
),

-- Somchai: weight with body fat
(
  :msg3,
  'evt-somchai-003',
  'Uc8a6b9d2e1f3a4b5c6d7e8f9a0b1c2d3',
  'message',
  'user',
  'Ucafe1234cafe1234cafe1234cafe1234a',
  'Ucafe1234cafe1234cafe1234cafe1234a',
  'msg-somchai-003',
  'text',
  '74.5 ไขมัน 18.2%',
  '{"type":"message","webhookEventId":"evt-somchai-003","timestamp":1748304000000,"source":{"type":"user","userId":"Ucafe1234cafe1234cafe1234cafe1234a"},"message":{"type":"text","id":"msg-somchai-003","text":"74.5 ไขมัน 18.2%","quoteToken":"q3"}}'::jsonb,
  true,
  now() - interval '12 hours',
  now() - interval '12 hours'
),

-- Malee: plain weight
(
  :msg4,
  'evt-malee-001',
  'Uc8a6b9d2e1f3a4b5c6d7e8f9a0b1c2d3',
  'message',
  'user',
  'Ubeef5678beef5678beef5678beef5678b',
  'Ubeef5678beef5678beef5678beef5678b',
  'msg-malee-001',
  'text',
  '58.1',
  '{"type":"message","webhookEventId":"evt-malee-001","timestamp":1748131200000,"source":{"type":"user","userId":"Ubeef5678beef5678beef5678beef5678b"},"message":{"type":"text","id":"msg-malee-001","text":"58.1","quoteToken":"q4"}}'::jsonb,
  true,
  now() - interval '2 days',
  now() - interval '2 days'
),

-- Malee: weight in group chat
(
  :msg5,
  'evt-malee-002',
  'Uc8a6b9d2e1f3a4b5c6d7e8f9a0b1c2d3',
  'message',
  'group',
  'Cdeadbeefdeadbeefdeadbeefdeadbeef',
  'Ubeef5678beef5678beef5678beef5678b',
  'msg-malee-002',
  'text',
  '57.9 🎉',
  '{"type":"message","webhookEventId":"evt-malee-002","timestamp":1748217600000,"source":{"type":"group","groupId":"Cdeadbeefdeadbeefdeadbeefdeadbeef","userId":"Ubeef5678beef5678beef5678beef5678b"},"message":{"type":"text","id":"msg-malee-002","text":"57.9 🎉","quoteToken":"q5"}}'::jsonb,
  true,
  now() - interval '1 day',
  now() - interval '1 day'
),

-- Danai: sticker — will fail to parse
(
  :msg6,
  'evt-danai-001',
  'Uc8a6b9d2e1f3a4b5c6d7e8f9a0b1c2d3',
  'message',
  'user',
  'Udead9999dead9999dead9999dead9999c',
  'Udead9999dead9999dead9999dead9999c',
  'msg-danai-001',
  'sticker',
  null,
  '{"type":"message","webhookEventId":"evt-danai-001","timestamp":1748304000000,"source":{"type":"user","userId":"Udead9999dead9999dead9999dead9999c"},"message":{"type":"sticker","id":"msg-danai-001","packageId":"11537","stickerId":"52002734","stickerResourceType":"STATIC","quoteToken":"q6"}}'::jsonb,
  false,
  null,
  now() - interval '3 hours'
)

on conflict (line_event_id) do nothing;

-- ─── weigh_entries ────────────────────────────────────────────────────
insert into public.weigh_entries (
  id, raw_message_id, line_user_id, weight_kg,
  body_fat_pct, muscle_mass_kg, note, recorded_at, created_at
) values

-- Somchai entry 1
(
  :we1,
  :msg1,
  'Ucafe1234cafe1234cafe1234cafe1234a',
  75.300,
  null, null, null,
  now() - interval '2 days',
  now() - interval '2 days'
),

-- Somchai entry 2 — with note
(
  :we2,
  :msg2,
  'Ucafe1234cafe1234cafe1234cafe1234a',
  74.800,
  null, null,
  'หลังออกกำลังกาย',
  now() - interval '1 day',
  now() - interval '1 day'
),

-- Somchai entry 3 — with body fat
(
  :we3,
  :msg3,
  'Ucafe1234cafe1234cafe1234cafe1234a',
  74.500,
  18.2, null, null,
  now() - interval '12 hours',
  now() - interval '12 hours'
),

-- Malee entry 1
(
  :we4,
  :msg4,
  'Ubeef5678beef5678beef5678beef5678b',
  58.100,
  null, null, null,
  now() - interval '2 days',
  now() - interval '2 days'
),

-- Malee entry 2
(
  :we5,
  :msg5,
  'Ubeef5678beef5678beef5678beef5678b',
  57.900,
  null, null, null,
  now() - interval '1 day',
  now() - interval '1 day'
)

on conflict (raw_message_id) do nothing;

-- ─── parse_errors ─────────────────────────────────────────────────────
insert into public.parse_errors (
  id, raw_message_id, parser_name, parser_version,
  error_type, error_message, error_detail, created_at
) values

-- Sticker cannot be parsed by weight parser
(
  :pe1,
  :msg6,
  'weight-parser',
  '1.0.0',
  'unsupported_type',
  'Parser does not support message type: sticker',
  '{"messageType":"sticker","packageId":"11537","stickerId":"52002734"}'::jsonb,
  now() - interval '3 hours'
),

-- Simulate a validation error on a past message (reuse msg6 for demo)
(
  :pe2,
  :msg6,
  'weight-parser',
  '1.0.0',
  'unsupported_type',
  'Retry attempt also failed: sticker type not supported',
  '{"attempt":2,"messageType":"sticker"}'::jsonb,
  now() - interval '2 hours'
)

on conflict do nothing;
