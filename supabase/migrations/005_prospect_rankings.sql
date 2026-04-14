-- PT AI ranking results. Keyed by Google place_id — covers all Outscraper prospects
-- whether or not they've been ingested into prospect.records yet.

CREATE TABLE IF NOT EXISTS demo_builder.prospect_rankings (
  place_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  website         TEXT,
  city            TEXT,
  state           TEXT,
  category        TEXT,
  tier            TEXT NOT NULL
                    CHECK (tier IN ('small_indie','mid_market','kiosk_tier','chain_nogo','not_a_fit')),
  score           INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasoning       TEXT,
  fit_signals     JSONB,
  concerns        JSONB,
  sibling_locations INTEGER DEFAULT 1,
  has_html_input  BOOLEAN DEFAULT FALSE,
  rubric_version  TEXT,
  model           TEXT,
  batch_id        TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cache_read_tokens INTEGER,
  ranked_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospect_rankings_tier_score
  ON demo_builder.prospect_rankings (tier, score DESC);

CREATE INDEX IF NOT EXISTS idx_prospect_rankings_ranked_at
  ON demo_builder.prospect_rankings (ranked_at DESC);
