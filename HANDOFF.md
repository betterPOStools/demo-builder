# Demo Builder — Handoff

**Last updated:** 2026-04-22
**Status:** [IN PROGRESS] — Deploy agent re-enabled and pushing sessions to tablet. Batch pipeline still manual CLI only. RLS hardening complete on DEV.

## Current state

- App deployed + stable. Supabase DEV (`mqifktmmyiqzrolrvsmy`), schema `demo_builder`, Vercel-hosted.
- Deploy agent running as `com.valuesystems.demo-builder-agent` (launchd), polling every 5s. **Re-enabled 2026-04-21.**
- **744+ done** / 861 failed of 1,605 (57 rows requeued from last failure analysis session).
- 747 SQL snapshots in `~/Projects/demo-DBs/` (backfilled 80 missing via `agent/backfill_snapshots.py`).

## Recent session (2026-04-22) — Supabase RLS hardening

**Trigger:** Supabase security advisor email flagging `rls_disabled_in_public` + `sensitive_columns_exposed` on both PROD and DEV.

**Changes:**
- `supabase/migrations/015_remaining_tables_rls.sql` — enable RLS on all 6 `demo_builder` tables with service_role-only policy. Pushed to DEV (`mqifktmmyiqzrolrvsmy`) and verified.
- `agent/pipeline_shared.py` — replaced `os.environ.setdefault()` with direct assignment in `load_env()` so `.env` file always wins over launchd global env. Added fail-fast `RuntimeError` if `SUPABASE_URL` points to wrong project ref.

**Verified after migration 015:**
- `demo_builder.connections` (MariaDB passwords): service_role sees 1 row, anon sees 0 ✅
- `demo_builder.sessions` (1252 rows): anon-blocked ✅
- All 5 other `demo_builder` tables: anon-blocked ✅

**PROD (`nngjtbrvwhjrmbokephl`) still pending Aaron's sign-off** — demo_builder.sessions and connections are anon-readable on PROD. Migration ready; awaiting authorization.

**Root cause of launchd contamination:** `launchctl setenv SUPABASE_URL=mqgjrfgbiqmmvsjfgoya` (set by rezd install.sh) polluted all launchd processes. `setdefault()` let the global var win. Fix: direct `os.environ[key] = val` overwrite in `load_env()` + project-ref assertion. See commit `f68218a`.

## Recent session (2026-04-21) — Deploy agent re-enable

**Problem:** Deploy agent (`com.valuesystems.demo-builder-agent`) was stuck in a crash loop. Two separate blockers:

1. **Governor `allow_daemon: false`** — `deploy_agent.py` imports the governor wrapper at startup as a guard, and `apps.yaml` had no `allow_daemon: true` for this app. Fixed by setting `allow_daemon: true` in `batch-governor/config/apps.yaml`. Note: the original burn was from the old inline batch pipeline; the current deploy_agent has zero Anthropic calls — the guard is a backstop.

2. **Wrong Supabase URL from global launchd env** — A `launchctl setenv SUPABASE_URL` was pointing to `mqgjrfgbiqmmvsjfgoya` (agent-rpc project). `pipeline_shared.py` uses `os.environ.setdefault`, so the `.env` value lost to the global env → 401 errors. Fixed by pinning `SUPABASE_URL=https://mqifktmmyiqzrolrvsmy.supabase.co` in the launchd plist's `EnvironmentVariables` block.

**Result:** Agent running at PID ~57000, polling correctly. Sessions 37c476a0 (972 SQL rows) and 9bb1405c (1083 SQL rows) deployed to tablet successfully. POS restart via PsExec showed "Not running after 60s — may need UAC approval on tablet" (non-fatal warning; POS may still have launched, UAC prompt waits on tablet screen).

**Key files changed:**
- `batch-governor/config/apps.yaml` — `allow_daemon: true` for `demo-builder-deploy-agent`
- `~/Library/LaunchAgents/com.valuesystems.demo-builder-agent.plist` — SUPABASE_URL pinned (not in repo)

## Recent session (2026-04-16) — Failure analysis + bug fixes

### layoutKey crash in `/api/batch/ingest` ✓

AI extraction returned freeform restaurant types (`"sandwich"`, `"burger"`) that aren't valid `RestaurantType` keys. `extraction.restaurantType` overwrote the valid `job.restaurant_type`, causing `TYPE_PRESETS[restaurantType]` to return `undefined` → crash on `typePreset.layoutKey` for 7 rows.

Fix (commit `f17d827`): validate against `VALID_TYPES` whitelist in `app/api/batch/ingest/route.ts`. Requeued all 7 → all 7 now `done`.

```typescript
const VALID_TYPES: RestaurantType[] = [
  "pizza", "bar_grill", "fine_dining", "cafe", "fast_casual", "fast_food",
  "breakfast", "mexican", "asian", "seafood", "other",
];
const restaurantType = (
  extractedType && VALID_TYPES.includes(extractedType as RestaurantType)
    ? extractedType : (job.restaurant_type ?? "other")
) as RestaurantType;
```

### Snapshot save bug in `advance_stage_assemble()` ✓

`save_snapshot(None, name, ...)` passed `None` as `pt_record_id`. `get_snapshot_path` called `None.replace("-", "")` → `AttributeError` silently caught → 80 sessions assembled without local SQL snapshots.

Fix (commit `c17cfe6`): fetch `pt_record_id` in the select query, pass `job.get("pt_record_id")`. Also ran `agent/backfill_snapshots.py` to write the 80 missing files retroactively.

### Failure requeue (57 rows) ✓

| Error | Count | Requeued to |
|-------|-------|-------------|
| `Could not fetch menu page text` | 39 | `queued` |
| `not JSON` | 4 | `queued` |
| `PDF batch errored` | 14 | `needs_pdf` |
| `layoutKey` crash | 7 | `ready_to_assemble` |

### Failure taxonomy (from Opus analysis)

| Error class | Count | Notes |
|-------------|-------|-------|
| Extraction returned no menu items | 440 | JS SPA nav chrome — dominant issue |
| no items | 227 | AI extracted 0 items from raw text |
| no url returned | 89 | Discovery failed completely |
| Homepage unreachable (CF) | 45 | Cloudflare block |
| Could not fetch | 39 | Network/timeout (requeued) |
| PDF batch errored | 14 | PDF Sonnet failures (requeued) |
| not JSON | 4 | Malformed AI response (requeued) |

JS SPA nav chrome (~667 combined) is the ceiling. Playwright `wait_for_selector` on menu-specific elements + ordering portal follow-through (Olo, Punchh) are the next levers.

## Recent session (2026-04-15) — PDF pipeline + bug fixes

### PDF URL bug fix ✓

`advance_stage_discover()` was storing the homepage URL in `menu_url` instead of the discovered PDF URL when a PDF was found. Sonnet's document block received a webpage instead of a PDF → errored every time.

Fix (commit `b3d99b0`): Write `pdf_url or ""` (not `pdf_url or None` — `menu_url` has NOT NULL constraint):
```python
supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
    "status": "needs_pdf",
    "menu_url": pdf_url or "",
    "homepage_html": homepage_trimmed or None,
    "updated_at": _now_iso(),
})
```

### `.pdf` guard in `advance_stage_pdf()` ✓

Added guard to reject non-PDF URLs that somehow reach the PDF stage (commit `0571dd4`):
```python
if not url or ".pdf" not in url.lower():
    supabase_patch(..., {"status": "failed", "error": f"menu_url is not a PDF URL: {url[:120]}"})
    continue
```

### PostgreSQL control-char bug fix ✓

`_fetch_homepage_html()` and `advance_stage_extract()` stored raw HTML without stripping null bytes and control characters that PostgreSQL TEXT columns reject → persistent `400 Client Error: Bad Request` on PATCH, row stuck in infinite discovery/extraction loop.

Symptom: `[POLL] Unhandled error (#1): 400 Client Error: Bad Request` repeating for same row.

Fix (strip before storage):
```python
import re as _re
html = _re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", html)[:max_chars]
```
Applied to both `_fetch_homepage_html()` and `raw_text` storage in `advance_stage_extract()`.

### PDF batch run complete ✓

All 39 PDF-menu restaurants processed via Sonnet 4.6 vision (document blocks, batch API). 9 succeeded (items extracted → session generated), remainder failed (scanned images, password-protected, or Sonnet returned 0 items).

### Final batch totals

| Status | Count |
|--------|-------|
| done | 737 |
| failed | 868 |
| **Total** | **1,605** |

### Tiny Anthropic batch workaround

1–2 request batches can take 40+ min while 20–22 request batches finish in 5–10 min. When final stragglers are stuck: cancel batch via API + push `ready_to_assemble` directly (branding falls back to static palette) rather than waiting indefinitely.

## Recent session (2026-04-14) — 4-stage batch pipeline

### 4-stage pipeline shipped ✓
Full `discover → extract → modifier → branding → assemble` pipeline running via Anthropic Messages Batch API. Migration 004 applied. ~$0.84 total for 108 successful pipeline requests vs $30+ for uncached non-batched first run.

### Prompt caching on extract-url (2026-04-14) ✓

Added `cache_control: { type: "ephemeral" }` to all 4 AI extraction paths in `app/api/extract-url/route.ts`. System prompt must be a block array (not a string) for cache_control to work:
```typescript
system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
```

### max_tokens truncation fix (2026-04-14) ✓

Large menus (~73k chars) were hitting `max_tokens: 24000` and returning truncated JSON.

Fix 1 — `app/api/extract-url/route.ts`: detect `stop_reason === "max_tokens"` and return clean 500.
Fix 2 — `agent/deploy_agent.py`: added `"truncated"` to `_JS_CONTENT_ERRORS` so PW fallback fires.

### process route markFailed bug fix (2026-04-14) ✓

`app/api/batch/process/route.ts` catch block was calling `markFailed()`, preventing the GEN/CF/PW fallback chain. Removed — route returns 500 only; agent owns failure lifecycle.

### batch_dashboard.py (2026-04-14) ✓

Terminal dashboard at `agent/batch_dashboard.py`. `python3 agent/batch_dashboard.py` — polls status counts, tails agent log, ANSI progress bar.

### /api/batch/feed endpoint (2026-04-14) ✓

Cross-origin batch feed at `app/api/batch/feed/route.ts`. Used by NomadHQ BatchQueueCard + home page BatchFeed component.

## Next up

1. **Failure analysis** — 868 failed rows. Understand breakdown: JS SPA vs CF-blocked vs bad discovery vs menu-as-image. Are any retry-worthy with new techniques?
2. **SQL quality audit** — 664 snapshots in `~/Projects/demo-DBs/`. Item counts, modifier coverage, price fill rate, category distribution.
3. **Deeper Playwright waits** — ordering portals (Olo, Punchh) return nav chrome only; adding wait-for-selector could recover some.
4. **Stuck-row detection** — add automatic reset of rows in `discovering`/`extracting` for >15 min (orphaned from killed agent).

## Live URLs / infra

- **App:** https://demo-builder-seven.vercel.app
- **GitHub:** `betterPOStools/demo-builder`
- **Supabase DEV project:** `mqifktmmyiqzrolrvsmy`
- **Deploy target (tablet):** `100.112.68.19:3306` (DB `pecandemodb`, root/123456)
- **Agent logs:** `~/Library/Logs/demo-builder-agent.{log,err}`
- **Batch feed API:** `https://demo-builder-seven.vercel.app/api/batch/feed`
- **SQL snapshots:** `~/Projects/demo-DBs/` (664 files)

## Known gotchas

- Browser Supabase client (`lib/supabase/client.ts`) must NOT have `{ db: { schema: "demo_builder" } }` — auth breaks (auth uses `public` schema). Only server clients get the schema override.
- Stage route uploads data-URI images to Vercel Blob before upsert — large base64 in JSONB was what killed PROD on 2026-04-10.
- `pending_images` JSON keys are **snake_case** (`image_url`, `dest_path`) — the agent reads these exact field names.
- Prompt caching requires system as block array: `[{ type: "text", text: ..., cache_control: { type: "ephemeral" } }]` — plain string silently skips caching.
- `menu_url` column has NOT NULL constraint — use `""` not `None` when clearing it.
- Scraped HTML/text must be stripped of control chars before Supabase PATCH: `re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)`.
- Haiku 4.5 prompt caching minimum is **4096 tokens** empirically (not 2048 as documented). Pad prompts past 4200 to be safe.
- Tiny Anthropic batches (1–2 requests) can take 40+ min. Cancel + bypass rather than waiting.
