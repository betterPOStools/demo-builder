-- Migration 010: Preflight column for single-shot rebuild pipeline
-- Stores the mechanical preflight verdict produced by agent/rebuild_batch.py
-- before any AI call is made. Additive only — existing extraction_result,
-- modifier_result, branding_result, *_batch_id columns all stay so the
-- wave-based pipeline (deploy_agent.py) and /api/batch/ingest are unaffected.
--
-- preflight JSONB shape (see PreflightVerdict in agent/rebuild_batch.py):
--   { row_id, url_class, fetch_status, menu_url_candidate, ldjson_items,
--     branding_tokens, image_menu_urls, content_gate_verdict, ai_needed[],
--     error, classified_at }
-- rebuild_run_id groups all rows classified in the same rebuild invocation
-- so dry-runs don't collide with each other (each --run-id gets its own row
-- set; re-running clears and re-populates by run_id).

ALTER TABLE demo_builder.batch_queue
  ADD COLUMN IF NOT EXISTS preflight          JSONB,
  ADD COLUMN IF NOT EXISTS preflight_run_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rebuild_run_id     TEXT;

-- Rows still needing preflight classification for a given run — the preflight
-- worker scans this index every tick.
CREATE INDEX IF NOT EXISTS idx_batch_queue_preflight_pending
  ON demo_builder.batch_queue (rebuild_run_id, preflight_run_at)
  WHERE preflight IS NULL;

-- GIN on the ai_needed array so we can cheaply count rows needing each stage
-- (e.g. "how many rows need discover?" for cost projection).
CREATE INDEX IF NOT EXISTS idx_batch_queue_preflight_ai_needed
  ON demo_builder.batch_queue USING GIN ((preflight -> 'ai_needed'));

-- url_class is used to shard cost projection and to drive stage dispatch
-- (e.g. url_class='pdf' → Sonnet PDF batch, url_class='direct_image' → vision).
CREATE INDEX IF NOT EXISTS idx_batch_queue_preflight_url_class
  ON demo_builder.batch_queue ((preflight ->> 'url_class'))
  WHERE preflight IS NOT NULL;
