-- Phase 1 slip evidence ingestion.
-- The storage bucket is private and the table has no anon/authenticated policies;
-- webhook writes use the service-role client.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'slip-evidence',
  'slip-evidence',
  false,
  52428800,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE public.slip_evidences (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id   uuid        NOT NULL REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  line_message_id  text        NOT NULL UNIQUE,
  source_id        text        NOT NULL,
  source_type      text        NOT NULL,
  line_user_id     text,
  storage_bucket   text        NOT NULL DEFAULT 'slip-evidence',
  storage_path     text        NOT NULL,
  mime_type        text,
  byte_size        integer,
  sha256           text        NOT NULL,
  status           text        NOT NULL DEFAULT 'RECEIVED',
  received_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT slip_evidences_status_check
    CHECK (status IN ('RECEIVED', 'DOWNLOAD_FAILED', 'STORAGE_FAILED')),
  CONSTRAINT slip_evidences_sha256_check
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slip_evidences_download_hash_check
    CHECK (
      status = 'DOWNLOAD_FAILED'
      OR sha256 <> repeat('0', 64)
    )
);

CREATE INDEX slip_evidences_raw_message_idx
  ON public.slip_evidences (raw_message_id);

CREATE INDEX slip_evidences_source_received_idx
  ON public.slip_evidences (source_id, received_at DESC);

CREATE INDEX slip_evidences_sha256_idx
  ON public.slip_evidences (sha256)
  WHERE status <> 'DOWNLOAD_FAILED';

ALTER TABLE public.slip_evidences ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.set_slip_evidence_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_slip_evidences_updated_at
  BEFORE UPDATE ON public.slip_evidences
  FOR EACH ROW EXECUTE FUNCTION public.set_slip_evidence_updated_at();

