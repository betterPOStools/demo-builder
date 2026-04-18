# Changelog

## 2026-04-16 — Shared image library + generation templates + mechanical palette

- **New:** Supabase-backed shared image library (`demo_builder.image_library` + `image-library` Storage bucket). Replaces per-browser IndexedDB. See `docs/adr/001-shared-image-library.md`.
- **New:** Static `GENERATION_TEMPLATES` registry in `lib/generation/templates.ts` (~15 templates across photoreal, design, illustrative kinds). All currently wired.
- **New:** UI components `LibraryPicker` + `TemplateSelector`, embedded in `BrandingEditor` and `ImageGenerator`.
- **New:** `/api/library` (GET/POST/DELETE), `/api/library/search` (tag-scored), `/api/extract-palette` (mechanical regex extraction, free).
- **New:** Default template `pull-from-library` — UI preflight hits `/api/library/search` before any AI route; on miss, falls through to the user's chosen AI template.
- **New:** Auto-save-to-library flywheel — every fresh AI generation fires `addToLibrary` with enriched tags (imagery_keywords + textureWords + tokenized styleHints + restaurantType + restaurantName).
- **Changed:** Four generation routes (`generate-item-image`, `fetch-photo`, `generate-branding`, `generate-logo-sidebar`) now accept an optional `templateId`. FLUX style variants (riso, blobby-gradient, maximalist) dispatch through `lib/generation/promptBuilders.ts:buildFluxPrompt`.
- **Migration:** `supabase/migrations/011_image_library.sql` applied to Supabase DEV (`mqifktmmyiqzrolrvsmy`).
