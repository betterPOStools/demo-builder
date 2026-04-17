-- Migration 012: batch resume semantics
--
-- Adds the two columns PR3's rebuild_batch.py needs to own an in-flight
-- Anthropic batch across process restarts and to triage rows that land
-- in needs_review without overloading the existing `status` column.
--
-- See agent/REFACTOR_PLAN.md §1, §2.5, §2.10.

ALTER TABLE demo_builder.batch_queue
  ADD COLUMN IF NOT EXISTS active_batch_run_id TEXT,
  ADD COLUMN IF NOT EXISTS review_reason       TEXT;

-- Resume authority: find ACTIVE rows for a given run by batch_id presence + run match
CREATE INDEX IF NOT EXISTS idx_batch_queue_active_run
  ON demo_builder.batch_queue (active_batch_run_id)
  WHERE active_batch_run_id IS NOT NULL;

-- Review dashboard / --recover-review filter
CREATE INDEX IF NOT EXISTS idx_batch_queue_needs_review
  ON demo_builder.batch_queue (review_reason)
  WHERE status = 'needs_review';
