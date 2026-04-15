-- Add detected-current-POS fields to prospect_rankings. Sales-intel columns:
-- which POS vendor the prospect appears to run today, and the evidence that
-- determined it (URL domain, schema.org markup, etc.). Filled by the ranker.

ALTER TABLE demo_builder.prospect_rankings
  ADD COLUMN IF NOT EXISTS detected_pos          TEXT,
  ADD COLUMN IF NOT EXISTS detected_pos_evidence TEXT;

COMMENT ON COLUMN demo_builder.prospect_rankings.detected_pos IS
  'Current POS vendor inferred from scrape. Controlled vocab: clover, toast, square, skytab, spoton, lightspeed, touchbistro, revel, aloha, micros, hungerrush, harbortouch, upserve, fronteats_zbs, popmenu_bundled, corporate_mandated, unknown, none_detected.';

COMMENT ON COLUMN demo_builder.prospect_rankings.detected_pos_evidence IS
  'Short string naming the signal (URL domain, schema.org org, menu platform) that drove the detection.';

CREATE INDEX IF NOT EXISTS idx_prospect_rankings_detected_pos
  ON demo_builder.prospect_rankings (detected_pos)
  WHERE detected_pos IS NOT NULL AND detected_pos NOT IN ('unknown', 'none_detected');
