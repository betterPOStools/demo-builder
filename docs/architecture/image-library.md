# Shared Image Library + Template Registry

The demo-builder has a cross-device image store that every image-choice surface (branding background, sidebar, item icons, seamless pairs, logo composites) reads from before spending AI dollars. It also has a static registry of ~15 generation templates so the UI can offer model + style variants (Recraft, FLUX Pro, FLUX Schnell, Ideogram V3, Claude Sonnet HTML/CSS, Claude Haiku SVG) without per-route branching at the call site.

## Storage model

- **Table** — `demo_builder.image_library` (migration `011_image_library.sql`). Row columns: `image_type`, `original_intent`, `storage_path`, `template_id`, `item_name`, `seamless_pair_id`, `concept_tags TEXT[]`, `cuisine_type`, `food_category`, `restaurant_type`, `dimensions JSONB`, `generated_for`, `created_at`.
- **Bytes** — Supabase Storage bucket `image-library` (public-read). Paths are content-hashed: `<original_intent>/<sha256>.<ext>`. Dedup is natural — the same bytes always land at the same path.
- **Writes** — always via `/api/library` (service role). Browser never writes directly.
- **Separation** — this is a long-lived library. `sessions.pending_images` (Vercel Blob) is a short-lived staging store for one specific deploy.

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/library` | GET | List entries. Query params: `intent`, `image_type`, `restaurant_type`, `limit` |
| `/api/library` | POST | Add an entry. Accepts `{ image_type, original_intent, data_uri, concept_tags, ... }` |
| `/api/library` | DELETE | Remove by `id` (also deletes the object from Storage) |
| `/api/library/search` | GET | Tag-scored search. Params: `intent`, `tags` (csv), `item_name`, `food_category`, `restaurant_type`, `limit`. Returns `{ entries, matched }` |
| `/api/extract-palette` | POST | Mechanical (regex) brand-color extraction from a restaurant homepage. Zero AI spend |

Client wrappers live in `lib/library/client.ts` (`listLibrary`, `addToLibrary`, `deleteLibraryEntry`, `searchLibrary`).

## Template registry

`lib/generation/templates.ts` — a `Record<string, GenerationTemplate>`. Each entry declares:

- `id` — kebab-case (e.g. `flux-pro-photo`, `recraft-flat-sticker`)
- `surfaces` — which picker surfaces it's valid for (`background`, `sidebar`, `seamless`, `item`, `logo-composite`)
- `model` — which backend actually runs (`fal-flux-pro`, `fal-recraft-v3`, `claude-haiku`, …)
- `kind` — category for the horizontal card strip (`library`, `photoreal`, `design`, `illustrative`)
- `wired: boolean` — when `false`, the card renders as a disabled "Coming soon" chip

**Prompt variants for the same backend** (e.g. FLUX Pro with riso/blobby-gradient/maximalist suffixes) are assembled by `lib/generation/promptBuilders.ts:buildFluxPrompt(templateId, basePrompt)`. The four generation routes all accept an optional `templateId` and dispatch through this helper — no per-template route file.

## UI surfaces

- `components/ui/LibraryPicker.tsx` — filter pills (default to the page's intent, but cross-type usage is allowed: an item icon can be selected as a sidebar) + grid + detail/delete. Used by `BrandingEditor` (background, sidebar) and `ImageGenerator` (item).
- `components/ui/TemplateSelector.tsx` — horizontal card strip. Defaults to `pull-from-library`.

## Pull-from-library preflight (UI pattern, not a route)

The caller (BrandingEditor, ImageGenerator) branches *before* calling the AI route:

```
if (templateId === "pull-from-library") {
  const { entries, matched } = await searchLibrary({ intent, tags, ... });
  if (matched) return entries[0].public_url;   // zero AI spend
}
// otherwise fall through to /api/fetch-photo or /api/generate-item-image
```

The feedback memory `feedback_ui_preflight_over_route_refactor.md` captures *why* this lives in the UI instead of the four routes — it avoids a cross-cutting refactor of `/api/fetch-photo`, `/api/generate-branding`, `/api/generate-item-image`, and `/api/generate-logo-sidebar` for a check that's trivially cheap at the caller.

## Auto-save-to-library flywheel

Every successful fresh AI generation fires `addToLibrary(...)` fire-and-forget with enriched tags — `imagery_keywords + textureWords + tokenized styleHints + restaurantType + restaurantName`, deduped and lowercased. Library-pulled images (URLs, not data URIs) skip this save. Seamless pairs share a `seamless_pair_id` so both halves re-surface together.

## Adding a new template

1. Add an entry to `GENERATION_TEMPLATES` in `lib/generation/templates.ts` with a `wired: false` flag so the card surfaces as a preview.
2. If the template uses an existing route (e.g. FLUX Pro with a new style suffix), add the suffix to `FLUX_STYLE_SUFFIX` in `lib/generation/promptBuilders.ts`.
3. If it uses a new backend, branch inside the relevant route (`generate-item-image` for items, `fetch-photo` for bg/sidebar/seamless) on `templateId === "your-new-id"`.
4. Flip `wired: true` once the route returns images end-to-end.

## Adding a new image type

1. Add the intent to `ImageIntent` in `lib/library/types.ts`.
2. Extend the `image_type` CHECK constraint in `011_image_library.sql` (write a new migration).
3. Teach `LibraryPicker` about the new filter pill.
