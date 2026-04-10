# CLAUDE.md — Demo Builder

Unified POS pipeline app: Extract menus → Design templates → Deploy to MariaDB.

## Stack

- **Framework:** Next.js 15 (App Router, TypeScript)
- **Styling:** Tailwind CSS 4 + shadcn/ui
- **State:** Zustand (4 slices: extraction, design, modifier, deploy)
- **DnD:** @dnd-kit/core + sortable
- **AI:** Anthropic SDK (Haiku 4.5 text, Sonnet 4.6 vision)
- **Image rendering:** html2canvas (branding), SVG-to-PNG (item icons)
- **Database:** Turso (LibSQL/SQLite) — migrated from Supabase 2026-04-10
- **File storage:** Vercel Blob (replaces Supabase Storage)
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
4. SQL staged in Turso → local deploy agent polls and executes against MariaDB

## Key Features

### AI Image Generation
- **Item images:** `POST /api/generate-item-image` — Claude Haiku generates 90×90px SVG icons with transparent backgrounds; converted to PNG via `lib/svgToPng.ts`
- **Branding:** `POST /api/generate-branding` — returns HTML/CSS `<div>` for sidebar (70×600px) or background (800×600px); rasterized client-side via `lib/htmlToPng.ts` (html2canvas)
- **Color palette:** same route, `type: "palette"` — returns `{ background, buttons_background_color, buttons_font_color }`
- Images stored as data URIs in Zustand `imageLibrary`; auto-assign matches by item name

### Deploy Agent (`agent/deploy_agent.py`)
- Runs as launchd service: `com.valuesystems.demo-builder-agent`
- Polls Turso `sessions` table for `deploy_status = "queued"` every 5s via HTTP API
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
- Saved connections stored in Turso `connections` table via `/api/connections`
- Active connection selected on deploy page → used as `deploy_target` in staged session
- Connection test: `POST /api/connections/test`

## Sibling Apps (READ ONLY — never modify)

- `../adv-menu-import/` — Source for extraction prompts + file processing patterns
- `../template-builder/` — Source for design types, reducer logic, serializer
- `../pos-scaffold/` — Source for SQL generation, MariaDB deployer

## Database (Turso)

Migrated from Supabase to Turso (LibSQL) on 2026-04-10. Supabase PROD became unresponsive.

- **URL:** `libsql://demo-builder-db-betterpostools.aws-us-east-1.turso.io`
- **Client:** `lib/turso.ts` — shared `turso` client + `parseJson`/`toJson` helpers
- **Tables:**
  - `sessions` — project sessions: `generated_sql`, `pending_images TEXT` (JSON), `deploy_target TEXT` (JSON), `deploy_status`, `deploy_result TEXT` (JSON)
  - `connections` — saved MariaDB targets
- `sessions.pending_images` — JSON array of `{ name, image_url, dest_path }` (**snake_case** — critical, agent reads these field names)
- `sessions.deploy_target` — `{ host, port, database, user, password }` or null

## Vercel Blob

Images uploaded to Vercel Blob before staging to Turso. Stage route (`app/api/deploy/stage/route.ts`) converts data URIs to Blob URLs. If Blob upload fails, data URI is stored directly in Turso as fallback.

- Token: `BLOB_READ_WRITE_TOKEN` (set in `.env.local` and Vercel project)
- Path pattern: `deploy/{sessionId}/{imageName}.{ext}`

## Auth

`NEXT_PUBLIC_SKIP_AUTH=true` bypasses auth entirely (set in `.env.local` and Vercel production). Full auth TBD.

## Migration Notes (2026-04-10)

- All API routes rewritten to use `@libsql/client`
- Deploy agent updated to poll Turso HTTP API (`/v2/pipeline`) — URL must use `https://` not `libsql://`
- `PendingImageTransfer` fields are snake_case throughout (`image_url`, `dest_path`, `entity_id`) — camelCase was a silent bug that broke image deploys
- Full migration log: `/Users/nomad/Projects/app-suite-docs/SUPABASE_TO_TURSO_MIGRATION.md`
