-- Migration 004: Staged batch pipeline columns
-- Adds per-stage Anthropic Messages Batches tracking + JSONB result columns so
-- the agent can drive jobs through discovery → extraction → modifier inference →
-- branding → assemble, where each AI stage runs as a batch across a pool of jobs.
-- Additive only — no data loss. Safe to run on live Supabase DEV project.

ALTER TABLE demo_builder.batch_queue
  ADD COLUMN IF NOT EXISTS raw_text              TEXT,
  ADD COLUMN IF NOT EXISTS homepage_html         TEXT,

  ADD COLUMN IF NOT EXISTS discover_batch_id     TEXT,
  ADD COLUMN IF NOT EXISTS extract_batch_id      TEXT,
  ADD COLUMN IF NOT EXISTS modifier_batch_id     TEXT,
  ADD COLUMN IF NOT EXISTS branding_batch_id     TEXT,
  ADD COLUMN IF NOT EXISTS stage_custom_id       TEXT,

  ADD COLUMN IF NOT EXISTS extraction_result     JSONB,
  ADD COLUMN IF NOT EXISTS modifier_result       JSONB,
  ADD COLUMN IF NOT EXISTS branding_result       JSONB,

  ADD COLUMN IF NOT EXISTS batch_submitted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_polled_at        TIMESTAMPTZ;

-- Partial index on pool_* statuses — agent scans these each tick to build waves.
CREATE INDEX IF NOT EXISTS idx_batch_queue_stage_pool
  ON demo_builder.batch_queue (status)
  WHERE status IN ('pool_discover', 'pool_extract', 'pool_modifier', 'pool_branding');

-- Partial index on in-flight batch statuses, ordered by last_polled_at so the
-- poller can cheaply find batches that haven't been checked in > 60s.
CREATE INDEX IF NOT EXISTS idx_batch_queue_stage_inflight
  ON demo_builder.batch_queue (status, last_polled_at)
  WHERE status IN ('batch_discover_submitted', 'batch_extract_submitted',
                   'batch_modifier_submitted', 'batch_branding_submitted');
