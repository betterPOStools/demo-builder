# CLAUDE.md — Demo Builder

Unified POS pipeline app: Extract menus → Design templates → Deploy to MariaDB.

## Stack

- **Framework:** Next.js 15 (App Router, TypeScript)
- **Styling:** Tailwind CSS 4 + shadcn/ui
- **State:** Zustand (4 slices: extraction, design, modifier, deploy)
- **DnD:** @dnd-kit/core + sortable
- **AI:** Anthropic SDK (Haiku 4.5 text, Sonnet 4.6 vision)
- **Image rendering:** html2canvas (branding), SVG-to-PNG (item icons)
- **Database:** Supabase DEV (`mqifktmmyiqzrolrvsmy`), schema `demo_builder`
- **File storage:** Vercel Blob
- **Hosting:** Vercel

## Dev Commands

```bash
npm run dev          # Start dev server on port 3002
npm run build        # Production build
npm run lint         # ESLint
```

## Architecture

- `app/` — Next.js App Router pages + API routes
- `lib/` — Business logic (extraction, SQL generation, types)
- `store/` — Zustand store with 4 slices
- `components/` — React components (layout, extract, design, deploy, ui)
- `agent/` — Local deploy agent (Python, runs on laptop)

## Port

| Port | Service |
|------|---------|
| 3002 | Next.js dev server |

## Pipeline

```
Step 1: Extract → Step 2: Design → Step 3: Deploy
```

Data flows through Zustand store:
1. Extraction produces `MenuRow[]` + modifier suggestions
2. `parseMenuRows()` converts to `ImportedMenuItem[]` → creates `GroupNode[]` + `ItemNode[]`
3. `serializeDesignConfig()` produces `DesignConfigV2` → SQL generation
4. SQL staged in Supabase → local deploy agent polls and executes against MariaDB

## Key Features

### AI Image Generation
- **Item images:** `POST /api/generate-item-image` — accepts `templateId` (Recraft V3 primary, FLUX Schnell or Claude SVG via template). Returns data URI.
- **Branding/background/sidebar:** `POST /api/fetch-photo` — accepts `templateId`; dispatches to FLUX Pro, Ideogram V3 (REALISTIC or DESIGN), or Unsplash.
- **HTML/CSS collage:** `POST /api/generate-branding` — Claude Sonnet renders HTML/CSS, rasterized client-side via `lib/htmlToPng.ts` (html2canvas); also serves `type: "palette"` for AI color extraction.
- **Mechanical palette (free):** `POST /api/extract-palette` — regex-based extraction of brand colors from a restaurant homepage, port of `agent/pipeline_shared.py:_extract_branding_mechanical`. No AI spend.
- Generated images save back to the shared library automatically (fire-and-forget).

### Shared Image Library
Cross-device image store backed by Supabase Storage bucket `image-library` + `demo_builder.image_library` table (migration 011). Replaces per-browser IndexedDB.

- **Routes:** `/api/library` (GET/POST/DELETE) + `/api/library/search?intent=&tags=&limit=` (scored match over concept_tags + cuisine + food_category).
- **Storage:** content-hashed paths (`<intent>/<sha256>.<ext>`) give natural dedup; public-read.
- **UI:** `components/ui/LibraryPicker.tsx` (filter pills + grid) and `components/ui/TemplateSelector.tsx` (horizontal card strip) embedded in `BrandingEditor` and `ImageGenerator`.
- **Pull-from-library preflight:** When the selected template is `pull-from-library` (default), the UI calls `/api/library/search` before any AI route; on hit, uses the library entry's public URL; on miss, falls through to the AI template chosen.

### Generation Template Registry (`lib/generation/templates.ts`)
Static Record of ~15 templates. Each has `id`, `surfaces`, `model`, `kind`, `wired`. The four generation routes (`generate-item-image`, `fetch-photo`, `generate-branding`, `generate-logo-sidebar`) accept a `templateId` and dispatch accordingly. Prompt variants for FLUX Pro style modes live in `lib/generation/promptBuilders.ts` (riso, blobby-gradient, maximalist-pattern, etc.).

### Deploy Agent (`agent/deploy_agent.py`)
- Runs as launchd service: `com.valuesystems.demo-builder-agent`
- Polls Supabase `demo_builder.sessions` for `deploy_status = "queued"` every 5s via REST API
- Executes SQL via `mysql.connector` against MariaDB deploy target
- Pushes images via SCP: data URIs decoded via `base64.b64decode()`, URLs via `requests.get()`
- POS image dirs: `C:\Program Files\Pecan Solutions\Pecan POS\images\{Food,Background,Sidebar}\`
- Restarts POS via PsExec (session 1, elevated, `--no-sandbox`) after deploy
- Agent logs: `~/Library/Logs/demo-builder-agent.{log,err}`

### SQL Generation (`lib/sql/deployer.ts`)
- Always freshly generates SQL in `handleStageDeploy` — never uses stale pre-generated SQL
- Item images: data URI in `posImagePath` → converted to `Food\ItemName.png` dest path, added to `pendingImageTransfers`, SQL gets the file path
- Per-item modifier templates: each item gets its own `UPPERCASE_NAME` template (not shared)
- Branding: `Background\generated_bg.png` → `storesettings.Background`; `Sidebar\generated_sidebar.png` → `stationsettingsvalues` via `stationsettingsnames.Key = 'SidebarPicture'`
- Cleanup DELETEs must include FK-dependent tables in order: `menuforcedmodifierlevelmodifiers` → `menuforcedmodifierlevels` → `menumodifiertemplateitemprefixes` → `menumodifiertemplateitems` → `menumodifiertemplatesections` → `menumodifiertemplates`

### Connections
- Saved connections stored in Supabase `demo_builder.connections` table via `/api/connections`
- Active connection selected on deploy page → used as `deploy_target` in staged session
- Connection test: `POST /api/connections/test`

## Sibling Apps (READ ONLY — never modify)

- `../adv-menu-import/` — Source for extraction prompts + file processing patterns
- `../template-builder/` — Source for design types, reducer logic, serializer
- `../pos-scaffold/` — Source for SQL generation, MariaDB deployer

## Database (Supabase)

Uses Supabase DEV project (`mqifktmmyiqzrolrvsmy`), schema `demo_builder`.
Supabase PROD (`nngjtbrvwhjrmbokephl`) went down 2026-04-10 — oversized JSONB upsert (~300–600KB base64 images) hit statement timeout. Turso was attempted as replacement but was unreachable on the demo location network — rolled back to Supabase DEV same day.

- **Client (server):** `lib/supabase/server.ts` — uses service role key, includes `{ db: { schema: "demo_builder" } }`
- **Client (browser):** `lib/supabase/client.ts` — uses anon key, **NO schema override** (auth breaks if schema override is present)
- **Agent:** polls via Supabase REST API with `Accept-Profile: demo_builder` + `Content-Profile: demo_builder` headers
- **Tables (schema `demo_builder`):**
  - `sessions` — project sessions: `generated_sql`, `pending_images JSONB`, `deploy_target JSONB`, `deploy_status`, `deploy_result JSONB`
  - `connections` — saved MariaDB targets
  - `image_library` — shared cross-device image store (migration 011): `storage_path`, `image_type`, `original_intent`, `template_id`, `concept_tags TEXT[]`, `seamless_pair_id`, etc.
- **Storage buckets:** `image-library` (public-read) — bytes for shared library entries
- `sessions.pending_images` — JSON array of `{ name, image_url, dest_path }` (**snake_case** — critical, agent reads these field names)
- `sessions.deploy_target` — `{ host, port, database, user, password }` or null
- **Image payload fix:** Stage route uploads data URIs to Vercel Blob before upserting to Supabase — stores URL (~100 bytes) not raw base64 (~60KB). Prevents JSONB statement timeout.

## Vercel Blob

Stage route (`app/api/deploy/stage/route.ts`) converts data URIs to Blob URLs before Supabase upsert. If Blob upload fails, data URI is stored directly as fallback.

- Token: `BLOB_READ_WRITE_TOKEN` (set in `.env.local` and Vercel project)
- Path pattern: `deploy/{sessionId}/{imageName}.{ext}`

## Auth

`NEXT_PUBLIC_SKIP_AUTH=true` bypasses auth entirely (baked into client bundle at build time — must be set in Vercel env vars, not just `.env.local`). Email auth for `aaronneece@gmail.com` is configured in Supabase DEV `auth.users` + `auth.identities`.

**Critical:** Never add `{ db: { schema: "demo_builder" } }` to the browser Supabase client (`lib/supabase/client.ts`). Auth operations (`signInWithPassword` etc.) use the `public` schema and will return "Database error querying schema" if a schema override is present. Only server-side clients should have the schema override.
