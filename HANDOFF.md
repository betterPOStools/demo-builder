# Demo Builder — Handoff

**Last updated:** 2026-04-14
**Status:** [IN PROGRESS] — batch pipeline running; ~186 failed jobs need re-queue; Message Batches API (50% cost) deferred.

## Current state

- App deployed + stable. Supabase DEV (`mqifktmmyiqzrolrvsmy`), schema `demo_builder`, Vercel-hosted.
- Deploy agent running as `com.valuesystems.demo-builder-agent`, polling `demo_builder.sessions` every 5s.
- Batch queue pipeline active: `batch_queue` table in Supabase DEV, ~1,600 jobs processed via `agent/deploy_agent.py`.

## Recent session (2026-04-13 → 2026-04-14)

### Prompt caching on extract-url (2026-04-14) ✓

Added `cache_control: { type: "ephemeral" }` to all 4 AI extraction paths in `app/api/extract-url/route.ts`. System prompt must be a block array (not a string) for cache_control to work:
```typescript
system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
```
Cache hits reduce input token cost to ~10%. All 4 paths: rawText, PDF-text, PDF-visual Sonnet, HTML.

### max_tokens truncation fix (2026-04-14) ✓

Large menus (~73k chars) were hitting `max_tokens: 24000` and returning truncated JSON — error logged as "JSON parse error at position 73175" (Valentino Italian).

Fix 1 — `app/api/extract-url/route.ts`: after each `finalMessage()` call:
```typescript
if (response.stop_reason === "max_tokens") {
  return Response.json({ error: "Response truncated..." }, { status: 500 });
}
```
Fix 2 — `agent/deploy_agent.py`: added `"truncated"` to `_JS_CONTENT_ERRORS` so Playwright fallback fires instead of marking job failed.

### process route markFailed bug fix (2026-04-14) ✓

Root cause of "Job is in state 'failed', expected 'processing'" errors (seen on Genova's Pizza):
- `app/api/batch/process/route.ts` catch block was calling `await markFailed(msg)`, setting `status='failed'`
- Agent continued to GEN/CF/PW fallback chain, but process route then rejected with 409 (already failed)
- Fix: removed `markFailed()` from process route catch block — route just returns 500; agent owns the failure lifecycle

### batch_dashboard.py (2026-04-14) ✓

New Python terminal dashboard at `agent/batch_dashboard.py`. Run with `python3 agent/batch_dashboard.py`.
- Polls 5 parallel Supabase count queries per status every 5s
- ANSI clear-screen loop, `█`/`░` progress bar, stat grid, jobs/hr rate + ETA
- Tails last N bytes of agent log file via seek

### /api/batch/feed endpoint (2026-04-14) ✓

New route at `app/api/batch/feed/route.ts` — cross-origin batch feed for NomadHQ.
- 5 parallel per-status counts + 60 most-recent jobs
- `Access-Control-Allow-Origin: *` — required for NomadHQ cross-origin polling
- Polled every 5s by BatchQueueCard in NomadHQ Tools tab

### BatchFeed card on demo-builder home page (2026-04-14) ✓

`components/batch/BatchFeed.tsx` — collapsible card at top of page with:
- Animated count increments (ease-out cubic via requestAnimationFrame)
- Progress bar, stat chips (done/fail/queued/pdf/%)
- 168px scrollable job feed (processing jobs pinned top)

## Next up

1. **Re-queue ~186 failed jobs** — many failed due to Anthropic API rate limit outage, not bad URLs. Requeue all `status='failed'` from that window.
2. **Anthropic Message Batches API** — 50% token cost reduction, async (up to 24h). Defer until current batch completes. Implementation: `client.messages.batches.create()` with array of requests.
3. **Menu URL Discovery + full ld+json** — plan at `~/.claude/plans/shiny-spinning-pebble.md`. Resolves homepage → actual menu URL, fetches all sections concurrently, sets `needs_pdf` for PDF links.

## Live URLs / infra

- **App:** https://demo-builder-seven.vercel.app
- **GitHub:** `betterPOStools/demo-builder`
- **Supabase DEV project:** `mqifktmmyiqzrolrvsmy`
- **Deploy target (tablet):** `100.112.68.19:3306` (DB `pecandemodb`, root/123456)
- **Agent logs:** `~/Library/Logs/demo-builder-agent.{log,err}`
- **Batch feed API:** `https://demo-builder-seven.vercel.app/api/batch/feed`

## Known gotchas

- Browser Supabase client (`lib/supabase/client.ts`) must NOT have `{ db: { schema: "demo_builder" } }` — auth breaks (auth uses `public` schema). Only server clients get the schema override.
- Stage route uploads data-URI images to Vercel Blob before upsert — large base64 in JSONB was what killed PROD on 2026-04-10.
- `pending_images` JSON keys are **snake_case** (`image_url`, `dest_path`) — the agent reads these exact field names.
- Prompt caching requires system as block array: `[{ type: "text", text: ..., cache_control: { type: "ephemeral" } }]` — passing a plain string silently skips caching.
- `status='needs_pdf'` is terminal for the current batch pass — no AI call fired, agent moves on. Second vision queue TBD.
