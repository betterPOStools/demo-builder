# ADR-001: Shared Image Library (Supabase Storage, not IndexedDB)

- **Status:** Accepted (shipped 2026-04-16)
- **Date:** 2026-04-16
- **Scope:** demo-builder image generation subsystem

## Context

Generated images were stored in a single `imageLibrary` Zustand slice, mirrored to IndexedDB via `lib/hooks/useImageLibrarySync.ts`. The whole `GeneratedImage[]` array lived under one key; every add/delete rewrote the blob. This had three hard costs:

1. The library only existed inside one browser on one device. Working from a laptop and a demo tablet meant two independent caches with no overlap.
2. The batch pipeline (`agent/batch_pipeline.py`, runs server-side) could not read the library, so it regenerated every asset.
3. Every generation hit an AI endpoint — no shared cache meant no deduplication across restaurants, across users, or even across browser sessions for the same user.

At the same time, the four generation routes (`fetch-photo`, `generate-item-image`, `generate-branding`, `generate-logo-sidebar`) had hardcoded one-model-one-prompt flows. Git history had ~11 variants that had shipped at different points (riso, blobby-gradient, maximalist, typographic-quote, digital vs vector vs flat-sticker icons, SVG fallback). None were user-selectable.

## Decision

Use a Supabase Storage bucket (`image-library`, public-read) plus a Postgres row (`demo_builder.image_library`) as the single source of truth for every generated asset. Keep the existing Zustand slice as a thin cache that reads through `/api/library`. Introduce a static `GENERATION_TEMPLATES` registry so the UI can pick a model + style, and default the selection to a `pull-from-library` template that searches by tags before any AI call.

**Why this shape:**

- Every other shared artifact in the app already uses "Supabase row for metadata + Blob bytes" (see `app/api/deploy/stage/route.ts` — `sessions.pending_images` + Vercel Blob). Mirroring it keeps the pattern uniform.
- Supabase Storage is public-read by default for this bucket so `<img src={publicUrl}>` works with no signed-URL round-trip. Writes go through `/api/library` (service role) — browser never talks to Storage directly.
- Content-hashed paths (`<intent>/<sha256>.<ext>`) give free dedup: the same bytes always produce the same storage path, even across restaurants.
- Pull-from-library as the default template means the system saves money automatically on repeat generations — a burger icon generated for Restaurant A surfaces as the top search result when Restaurant B's burger is generated, with zero AI spend.
- Template registry lives as a static `Record<string, GenerationTemplate>` (mirrors `lib/presets/typePalettes.ts`). Templates with unfinished backends carry `wired: false` so the UI can show a disabled card.
- Pull-from-library check happens in the caller (`BrandingEditor`, `ImageGenerator`), not inside the routes. See `feedback_ui_preflight_over_route_refactor.md`. This avoids a four-route refactor for a check that's trivial at the call site.

## Consequences

**Positive**
- Cross-device library: incognito + second device see the same images.
- Batch pipeline will eventually read the same library (follow-up work).
- Output tokens are no longer the bottleneck for repeat-shape generations; the second request is free.
- New templates (riso, Ideogram DESIGN, FLUX Schnell, flat-sticker) ship via registry entries and prompt-suffix modifiers rather than dedicated routes.

**Costs / follow-ups**
- Old IndexedDB library is not auto-migrated. The plan specifies a user-triggered "Seed from local IndexedDB" button (deferred — existing `useImageLibrarySync` still runs during the transition so nothing breaks).
- `store/designSlice.ts` still defines the old `imageLibrary` slice. Harmless (nothing writes to it from new flows), scheduled for cleanup.
- Storage costs at 40-80 KB/image × ~20 KB Postgres row × N restaurants. The free tier (1 GB Storage) covers ~15-25k images, enough for years at current cadence. A retention policy can prune `image_type='item'` entries with `created_at < NOW() - INTERVAL '1 year'` when needed.

## Alternatives considered

- **Refactor the four generation routes to dispatch by `templateId` with library-preflight inside each route.** Rejected: four parallel changes for one check that lives fine in two UI components.
- **Use Vercel Blob for library bytes.** Rejected: Supabase's RLS + Postgres metadata is a tighter fit for filterable queries, and Vercel Blob is already reserved for ephemeral deploy staging.
- **One global `GeneratedImage[]` in Zustand persisted to localStorage.** Rejected: same cross-device limitation as IndexedDB, same whole-array rewrite cost, and localStorage is ~5 MB.

## Verification

- `npm run build` + `npx tsc --noEmit` — green.
- Direct route probes — `/api/library`, `/api/library/search`, `/api/extract-palette` all return 200.
- Runtime browser test of the full picker UI was blocked by a dev-server HMR thrash issue (unrelated to this work) — tracked as task #7.
