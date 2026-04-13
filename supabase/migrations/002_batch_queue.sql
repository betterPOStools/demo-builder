-- Migration 002: Batch generation queue + PT record linkage
-- Additive only — no data loss. Safe to run on live Supabase DEV project.

-- Link sessions to Prospect Tracker records so PT can find its demos
ALTER TABLE demo_builder.sessions
  ADD COLUMN IF NOT EXISTS pt_record_id UUID;

CREATE INDEX IF NOT EXISTS idx_sessions_pt_record
  ON demo_builder.sessions (pt_record_id)
  WHERE pt_record_id IS NOT NULL;

-- Batch generation queue — one row per prospect enqueued from PT
-- BUSINESS RULE: status flow is queued → processing → done | failed
-- The deploy agent polls for status='queued', calls /api/batch/process, saves local SQL snapshot.
CREATE TABLE IF NOT EXISTS demo_builder.batch_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pt_record_id    UUID        NOT NULL,
  name            TEXT        NOT NULL,
  menu_url        TEXT        NOT NULL,
  restaurant_type TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'queued',
  session_id      UUID        REFERENCES demo_builder.sessions(id),
  error           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batch_queue_status
  ON demo_builder.batch_queue (status)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_batch_queue_pt_record
  ON demo_builder.batch_queue (pt_record_id);
