-- Migration 008: PDF batch pipeline support
-- Adds pdf_batch_id column to track Anthropic batch IDs for the needs_pdf stage.
-- PDFs use claude-sonnet-4-6 (vision) submitted as a batch; results flow into
-- extraction_result → ready_for_modifier, same as the text extraction stage.

ALTER TABLE demo_builder.batch_queue
  ADD COLUMN IF NOT EXISTS pdf_batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_batch_queue_pdf_submitted
  ON demo_builder.batch_queue (status, pdf_batch_id)
  WHERE status = 'batch_pdf_submitted';
