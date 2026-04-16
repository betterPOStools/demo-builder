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
- **Item images:** `POST /api/generate-item-image` — Claude Haiku generates 90×90px SVG icons with transparent backgrounds; converted to PNG via `lib/svgToPng.ts`
- **Branding:** `POST /api/generate-branding` — returns HTML/CSS `<div>` for sidebar (70×600px) or background (800×600px); rasterized client-side via `lib/htmlToPng.ts` (html2canvas)
- **Color palette:** same route, `type: "palette"` — returns `{ background, buttons_background_color, buttons_font_color }`
- Images stored as data URIs in Zustand `imageLibrary`; auto-assign matches by item name

### Agent files (`agent/`)

**`deploy_agent.py`** — launchd daemon (`com.valuesystems.demo-builder-agent`). Always-on, always-stable. Polls `demo_builder.sessions` for `deploy_status='queued'` every 5s. On match: executes SQL via `mysql.connector`, pushes images via SCP (data URIs + URLs both handled), restarts POS via PsExec (session 1, elevated, `--no-sandbox`). No Anthropic calls, no batch logic. Logs: `~/Library/Logs/demo-builder-agent.{log,err}`.

**`batch_pipeline.py`** — CLI-only, **never a daemon**. Subcommands: `run-staged` (one tick of discover→extract→modifier→branding→assemble), `retry-failed` (stub — not implemented), `dry-run` (watched run via `dryrun_staged.py` against `TRACKED_IDS`). Uses Anthropic Messages Batches API (Haiku 4.5) with prompt caching. Spends money — operator must invoke manually. Wave constants: `WAVE_MIN_SIZE=20`, `WAVE_MAX_SIZE=40`, `FORCE_WAVE_AFTER_SECONDS=1800`. See `agent/rebuild_batch.py` for bulk preflight+rebuild.

**`pipeline_shared.py`** — shared primitives imported by both. Supabase REST client, env load, URL classifiers, HTML/curl fetchers, ld+json extractors, menu-URL discovery. No wave logic, no POS/SSH/MariaDB.

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
