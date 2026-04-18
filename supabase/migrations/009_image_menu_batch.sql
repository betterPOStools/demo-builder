-- Migration 009: Image-menu batch pipeline support
-- Adds image_menu_batch_id column for restaurants whose /menu page is a gallery
-- of large image files (Wix / Squarespace / GoDaddy photo uploads). Same
-- Sonnet-vision flow as PDFs, but multiple image blocks per request.

ALTER TABLE demo_builder.batch_queue
  ADD COLUMN IF NOT EXISTS image_menu_batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_batch_queue_image_menu_submitted
  ON demo_builder.batch_queue (status, image_menu_batch_id)
  WHERE status = 'batch_image_menu_submitted';
