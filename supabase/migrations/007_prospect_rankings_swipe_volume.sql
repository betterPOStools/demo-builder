-- Add swipe-volume estimation to prospect_rankings. VSI earns per-swipe + %
-- residuals, so high-volume low-ticket merchants (coffee, quick-service) can
-- out-earn low-volume high-ticket sit-down restaurants. These columns let
-- sales sort residual value alongside tier.

ALTER TABLE demo_builder.prospect_rankings
  ADD COLUMN IF NOT EXISTS estimated_swipe_volume TEXT
    CHECK (estimated_swipe_volume IN ('high','medium','low','unknown') OR estimated_swipe_volume IS NULL),
  ADD COLUMN IF NOT EXISTS swipe_volume_evidence  TEXT;

COMMENT ON COLUMN demo_builder.prospect_rankings.estimated_swipe_volume IS
  'Transaction-volume bucket used to weight residual value. Controlled vocab: high, medium, low, unknown. Sort sales queue by (tier, -swipe_volume, -score).';

COMMENT ON COLUMN demo_builder.prospect_rankings.swipe_volume_evidence IS
  'Short string citing the signal (reviews + category + hours) that drove the volume estimate.';

-- Composite sort index for sales queue: best fit first, then highest-volume,
-- then highest score within volume band
CREATE INDEX IF NOT EXISTS idx_prospect_rankings_sales_queue
  ON demo_builder.prospect_rankings (tier, estimated_swipe_volume, score DESC)
  WHERE tier IN ('small_indie','mid_market','kiosk_tier');
