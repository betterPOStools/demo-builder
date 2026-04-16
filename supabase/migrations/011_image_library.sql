-- Migration 011: Shared image library — cross-device, cross-surface
-- Replaces per-browser IndexedDB in lib/hooks/useImageLibrarySync.ts.
-- Bytes live in Supabase Storage bucket "image-library"; this table carries
-- metadata + lookup dimensions. Matches the pattern used by
-- sessions.pending_images (see app/api/deploy/stage/route.ts).
--
-- original_intent = what it was GENERATED for (item | sidebar | background | logo-composite).
-- image_type      = same enum, but cross-type usage is permitted — a user
--                   may select an 'item' image as a sidebar picture.
-- concept_tags, cuisine_type, food_category, restaurant_type populate from
-- lib/itemTags.ts + lib/presets/typePalettes.ts so the search route can
-- match by any dimension.

CREATE TABLE IF NOT EXISTS demo_builder.image_library (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_type       TEXT NOT NULL,
  original_intent  TEXT NOT NULL,
  storage_path     TEXT NOT NULL UNIQUE,
  template_id      TEXT,
  item_name        TEXT,
  seamless_pair_id UUID,
  concept_tags     TEXT[] DEFAULT '{}',
  cuisine_type     TEXT,
  food_category    TEXT,
  restaurant_type  TEXT,
  dimensions       JSONB,
  generated_for    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_library_intent_type
  ON demo_builder.image_library (original_intent, image_type);

CREATE INDEX IF NOT EXISTS idx_image_library_concept_tags
  ON demo_builder.image_library USING GIN (concept_tags);

CREATE INDEX IF NOT EXISTS idx_image_library_seamless_pair
  ON demo_builder.image_library (seamless_pair_id)
  WHERE seamless_pair_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_image_library_restaurant_type
  ON demo_builder.image_library (restaurant_type)
  WHERE restaurant_type IS NOT NULL;

ALTER TABLE demo_builder.image_library ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read the library; writes go through /api/library
-- (service role) so the anon key never touches INSERT/DELETE directly.
CREATE POLICY "image_library_read_authenticated"
  ON demo_builder.image_library
  FOR SELECT
  TO authenticated
  USING (true);
