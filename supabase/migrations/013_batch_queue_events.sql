-- Migration 013: batch_queue_events append-only history log
--
-- Per-row event log for the rebuild pipeline. Status on batch_queue stays
-- as the fast-lookup denormalized cache; this table is the operator's
-- decision substrate. If status and history ever diverge, history wins.
--
-- See agent/REFACTOR_PLAN.md §2.9.

CREATE TABLE IF NOT EXISTS demo_builder.batch_queue_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_queue_id  UUID NOT NULL REFERENCES demo_builder.batch_queue(id) ON DELETE CASCADE,
  rebuild_run_id  TEXT NOT NULL,
  stage           TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  batch_id        TEXT,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),

  input_tokens          INT,
  output_tokens         INT,
  cache_creation_tokens INT,
  cache_read_tokens     INT,
  cost_usd              NUMERIC(10,6),

  error_text       TEXT,
  review_reason    TEXT,
  http_status      INT
);

CREATE INDEX IF NOT EXISTS idx_batch_queue_events_row_ts
  ON demo_builder.batch_queue_events (batch_queue_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_batch_queue_events_run
  ON demo_builder.batch_queue_events (rebuild_run_id);

CREATE INDEX IF NOT EXISTS idx_batch_queue_events_stage_event_ts
  ON demo_builder.batch_queue_events (stage, event_type, ts DESC);
