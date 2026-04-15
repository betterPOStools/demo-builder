# Demo Builder — Handoff

**Last updated:** 2026-04-15
**Status:** [IN PROGRESS] — Batch run complete (737 done / 868 failed of 1,605). PDF pipeline shipped. 4-stage batch pipeline proven at scale.

## Current state

- App deployed + stable. Supabase DEV (`mqifktmmyiqzrolrvsmy`), schema `demo_builder`, Vercel-hosted.
- Deploy agent running as `com.valuesystems.demo-builder-agent` (launchd), polling every 5s.
- Batch pipeline complete: 737 demo databases generated, 868 failed (mostly unrecoverable JS SPAs / menu-as-image sites).
- 664 SQL snapshots in `~/Projects/demo-DBs/`.

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
