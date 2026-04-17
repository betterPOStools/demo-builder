# Agent Tools

## rebuild_batch.py

**Path:** `agent/rebuild_batch.py`
**Purpose:** Single-shot replacement for the wave-based staged pipeline in `deploy_agent.py`. Classifies every `batch_queue` row mechanically (URL class + content gate + cached ld+json + cached branding tokens) before any AI call, and projects total cost so it can be approved/rejected up front.

**What it achieves:** When run with `--dry-run`, populates `batch_queue.preflight` (JSONB) and `rebuild_run_id` for every selected row, prints bucket counts (url_class, content_gate, ai_needed), and reports projected AI spend using per-stage batch-API rates. PR3 will add real AI batch submission. PR1 (current) is dry-run only — non-`--dry-run` invocations exit 2.

**Inputs / env vars (inherited from deploy_agent's `.env`):**

| Var | Required | Purpose |
|-----|----------|---------|
| `SUPABASE_URL` | ✅ | Supabase DEV project URL |
| `SUPABASE_KEY` | ✅ | Service role key (R+W on `demo_builder.batch_queue`) |

**CLI flags:**

| Flag | Default | Purpose |
|------|---------|---------|
| `--dry-run` | — | Required in PR1. Not passing it hard-errors with exit 2. |
| `--status-filter done,failed,queued` | all | Only classify rows in these statuses. |
| `--run-id RUN` | auto (`dry-YYYYMMDDTHHMMSS-abc123`) | Tag for this batch of preflight verdicts. Lets dry-runs not collide. |
| `--workers 24` | 24 | Parallel preflight workers. Reduce to 16 on a slow network. |
| `--fetch` | off | Re-fetch homepage/menu via curl_cffi if `raw_text`/`homepage_html` missing. Slow (minutes for 1598 rows); off by default for fast-path smoke runs. |
| `--limit N` | — | Cap row count, useful for small smoke runs before the full sweep. |

**Key functions:**

### `classify_url(url: str) -> UrlClass`

Pure-string URL classifier. No network. Expands `deploy_agent._classify_dead_url` (which only handled social) to also distinguish hotel-aggregator landings, PDFs, and direct image URLs. Return values drive stage dispatch in PR3 (`pdf` → Sonnet PDF batch, `direct_image` → Sonnet image batch, `social_dead`/`hotel_dead`/`unreachable` → no AI rescue, `html` → normal extract path).

### `_classify_content_gate(text: str) -> ContentGate`

Replaces `deploy_agent._classify_extract_skip` with relaxed thresholds. The old gate hard-failed at <500 chars; on the 2026-04-15 rebuild, 23% of those failures (36/158) succeeded when retried — it was false-positiving on genuinely short valid pages. New thresholds (see `REFACTOR_PLAN.md` §2):

| Verdict | Trigger | Disposition |
|---------|---------|-------------|
| `hard_fail` | <200 chars AND <30 tokens | No AI call (dead page) |
| `sparse` | 200–500 chars | Tagged, still sent to AI |
| `nav_heavy` | nav_ratio>0.35 AND <3K chars | Tagged, still sent to AI |
| `no_price` | no prices AND >3K chars | Tagged, still sent to AI |
| `ok` | default | Normal extract path |

### `preflight_row(row, fetch=False) -> PreflightVerdict`

Per-row mechanical classifier. Pure-mechanical — no AI. Returns a `PreflightVerdict` carrying `url_class`, `fetch_status`, `ldjson_items`, `branding_tokens`, `image_menu_urls`, `content_gate_verdict`, and `ai_needed` (list of AI stages still needed). `fetch=False` (default) classifies using `batch_queue.raw_text` + `homepage_html` cached from prior wave runs; `fetch=True` re-fetches missing pages via curl_cffi.

### `_compute_ai_needed(...) -> list[AiStage]`

Decides which AI stages remain for a row. Rules summary:
- Dead URL classes or `hard_fail` content → `ai_needed=[]` (fully mechanical; skip AI entirely).
- `pdf` / `direct_image` → Sonnet vision batch + modifier + maybe branding.
- `html` with ≥5 ld+json items → extract is mechanical; only needs modifier + maybe branding.
- `html` with `image_menu_urls` + sparse page → Sonnet image batch + modifier + maybe branding.
- `html` otherwise → maybe discover + extract + modifier + maybe branding.

### `project_cost(verdicts) -> (counts, total_usd)`

Sums per-stage request counts × `COST_PER_REQ_USD` to project total spend. Per-stage rates (from 2026-04-16 actuals — see `memory/feedback_output_tokens_dominate_batch_cost.md`): discover $0.0020, extract $0.0031, modifier $0.0028, branding $0.0015, pdf $0.0250, image_menu $0.0220.

**Constraints & iteration history:**

- **Why single-shot vs daemon:** The wave-based scheduler in `deploy_agent.py` was designed for steady-state throughput (trickle of new PT leads). Bulk rebuilds (1598 rows) forced through a streaming scheduler caused cache creation events to outpace cache reads (<3× amortization on Sonnet), resulting in higher cost than per-row sync calls would have been. See `memory/feedback_batch_caching_cost_regression.md`. Single-shot design amortizes one cache-creation event across 1000+ rows.
- **Why dry-run enforced in PR1:** Before shipping any submission code, we need retroactive validation that preflight bucket counts match observed 2026-04-15 outcomes within ±3%. Letting PR1 submit batches would conflate "preflight is correct" with "submission is correct." See `REFACTOR_PLAN.md` §4 PR sequence.
- **Why import from `deploy_agent` (not `pipeline_shared`):** PR2 is the shared-module extraction. For PR1 we import `_extract_ldjson_menu_text`, `_fetch_homepage_html`, `_extract_branding_mechanical`, `fetch_page_text_curl_cffi` from `deploy_agent` directly. Module-level side effects of `deploy_agent` (env load, prompts load, optional Anthropic client) are tolerated for this PR; PR2 eliminates them.
- **Why `--fetch` default off:** 1598 × ~2s fetch @ 24 workers ≈ 2 minutes on a good network, but can stall on Cloudflare-protected hosts. Default off lets first smoke runs complete in seconds using already-cached `raw_text` / `homepage_html` from prior wave runs.
- **Rejected: inline URL classification in deploy_agent.** Would bloat `_classify_dead_url` and mix URL-class semantics with dead-URL semantics. Cleaner to rewrite into a typed `classify_url`.
- **Rejected: a single mega-batch.** Extract needs the discovered URL; modifier needs extracted items. Dependency graph forces ~3 batch-group boundaries (discover → extract/pdf/image_menu → modifier/branding). Not one batch.

**Known issues:**

- `menu_url_candidate` is not auto-populated in PR1 (the mechanical `discover_menu_url` is network-heavy and lives in `deploy_agent`; PR2 moves it). Without it, more rows get flagged as needing AI `discover` than strictly necessary; the cost projection is slightly conservative as a result.
- `image_menu_urls` is only surfaced from `extraction_result.image_menu_urls` if a prior wave ran `_detect_menu_images`. Rows that never entered the wave pipeline won't have them; PR2/PR3 will run the detector live.
- Row PATCHes are serial-per-row (not batched). For 1598 rows × ~50ms PATCH ≈ 80 seconds at 1 worker; with 24 workers the network is the constraint. Acceptable for PR1; PR3 can bulk-upsert in chunks if needed.

---

## deploy_agent.py

**Path:** `agent/deploy_agent.py`  
**Purpose:** Launchd daemon that polls Supabase for queued sessions and deploys them to the POS tablet — no batch code, no Anthropic calls.

**Current status (2026-04-17):** plist moved to `~/Library/LaunchAgents/disabled/` after an overnight Anthropic budget burn (from the pre-split monolithic version). Re-enable by moving the plist back + `launchctl bootstrap gui/$(id -u) <plist>` — safe to do once PR3 `rebuild_batch.py` is in and the daemon stays batch-free (as the post-PR2 split already ensures).

**What it achieves:** When the browser stages a deploy, this daemon picks it up from `demo_builder.sessions` (`deploy_status='queued'`) and delivers it to the tablet: executes the generated SQL against MariaDB, pushes branding/item images via SCP, and restarts the POS Electron app so changes take effect immediately.

**Inputs / env vars (from `agent/.env`):**

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `SUPABASE_URL` | ✅ | — | Supabase project REST URL |
| `SUPABASE_KEY` | ✅ | — | Service role key (needs read+write on `demo_builder.sessions`) |
| `DB_HOST` | — | `100.112.68.19` | MariaDB host (demo tablet) |
| `DB_PORT` | — | `3306` | MariaDB port |
| `DB_USER` | — | `root` | MariaDB user |
| `DB_PASSWORD` | — | `123456` | MariaDB password |
| `DB_NAME` | — | `pecandemodb` | Database name |
| `SSH_HOST` | — | DB_HOST | SSH target for SCP + POS restart |
| `SSH_USER` | — | `admin` | SSH user on demo tablet |
| `POS_IMAGES_DIR` | — | `C:\Program Files\Pecan Solutions\Pecan POS\images` | Image destination on POS |
| `POLL_INTERVAL` | — | `5` | Seconds between Supabase polls |

**Key functions:**

### `process_queued()`

Main deploy loop. Fetches one session with `deploy_status='queued'`, atomically claims it (`deploy_status='executing'`), runs `execute_sql()` → `push_images_scp()` → `restart_pos()`, then sets `deploy_status='done'` or `'failed'`.

### `push_images_scp(pending_images, ssh_host, ssh_user)`

Transfers each image to the POS tablet via SCP. Handles both data URIs (`base64.b64decode()`) and HTTP URLs (`requests.get()`). Writes to `POS_IMAGES_DIR\{Food,Background,Sidebar}\`.

### `restart_pos(ssh_host, ssh_user)`

Kills `Pecan POS.exe` via SSH + taskkill, writes a VBS launcher, then invokes PsExec `-i {session} -h -d wscript.exe` to launch the Electron app in the interactive desktop session with `--no-sandbox`. VBS is always overwritten unconditionally (prevents stale/corrupt VBS from persisting).

**Constraints & iteration history:**

- **Separated from batch pipeline 2026-04-16:** The monolithic `deploy_agent.py` previously contained both the deploy daemon AND the 4-stage batch pipeline (`run_staged_pipeline`, all `advance_stage_*`, all `submit_stage_wave`, all Anthropic batch calls). Batch code was split to `batch_pipeline.py` and shared primitives to `pipeline_shared.py`. See `agent/SEPARATION_PLAN.md`.

- **Why split:** Batch + prompt-caching cost regression discovered 2026-04-16 — automatic wave submission was spending Anthropic dollars without operator approval. Operator principle: "batch function should never happen automatically. they need direct intervention from me to process." A single daemon doing both meant any bug or restart could trigger AI spend without human action.

- **Turso migration (2026-04-10) — rolled back:** Daemon was rewritten to use Turso HTTP API instead of Supabase. Network-level block — Turso endpoint unreachable from both agent and Vercel on demo-location network. Rolled back same day.

- **JSONB timeout root cause:** Original approach stored base64 data URIs (~60KB) directly in `sessions.pending_images`. With 5–10 images, upsert hit Supabase statement timeout. Fix: stage route uploads to Vercel Blob first; agent receives URLs (~100 bytes). `push_images_scp()` handles both data URIs and URLs.

- **POS restart via PsExec:** Electron crashes with `GPU process launch failed: error_code=18` when started from SSH session 0. PsExec `-i {session_id}` launches into the interactive desktop session. `--no-sandbox` allows GPU access from the remote context.

- **VBS quoting bug (fixed 2026-04-10):** `&&` separator ended up outside `WshShell.Run` string — POS was killed but never restarted. Fixed by single-string command.

- **Schema headers required:** All Supabase requests must include `Accept-Profile: demo_builder` and `Content-Profile: demo_builder` headers.

**Known issues:**
- `execute_sql` splits on `;` — would break if generated SQL contained semicolons inside string literals. Low risk (machine-generated SQL).
- `deploy_agent_local.py` is an older variant for local MariaDB; keep as reference, do not develop.

---

## batch_pipeline.py

**Path:** `agent/batch_pipeline.py`  
**Purpose:** CLI-only operator tool that runs one tick of the staged AI batch pipeline (discover→extract→modifier→branding→assemble) against `demo_builder.batch_queue`. Never runs as a daemon.

**What it achieves:** Advances `batch_queue` rows through the 4-stage pipeline by submitting Anthropic Messages Batch API requests (Haiku 4.5 for extract/modifier/branding, Sonnet 4.6 for PDF/image menus) with prompt caching, polling for results, and assembling completed rows into sessions. One invocation = one tick; repeated ticks require repeated manual invocations (or a shell loop).

**Subcommands:**
```
python3 agent/batch_pipeline.py run-staged   # one tick of all stages
python3 agent/batch_pipeline.py dry-run      # watched run via dryrun_staged.py against TRACKED_IDS
python3 agent/batch_pipeline.py retry-failed # not implemented — use rebuild_batch.py
```

**Inputs / env vars (from `agent/.env`):**

| Var | Required | Purpose |
|-----|----------|---------|
| `SUPABASE_URL` | ✅ | Supabase project REST URL |
| `SUPABASE_KEY` | ✅ | Service role key (R+W on `demo_builder.batch_queue` + `sessions`) |
| `ANTHROPIC_API_KEY` | ✅ | For Haiku/Sonnet batch submissions |
| `WAVE_MIN_SIZE` | — | Min rows before a wave is submitted (default 20) |
| `WAVE_MAX_SIZE` | — | Max rows per wave (default 40) |
| `FORCE_WAVE_AFTER_SECONDS` | — | Submit even if below min size after this delay (default 1800) |
| `BATCH_POLL_INTERVAL_SEC` | — | Seconds between wave status polls (default 30) |

**Key functions (all moved here from the former monolithic deploy_agent.py):**

`run_staged_pipeline()` orchestrates:

| Function | Input status | Output status | AI? |
|----------|-------------|---------------|-----|
| `advance_stage_discover()` | `queued` | `discovering` → `ready_for_extract` / `pool_discover` / `needs_pdf` / `failed` | No (mechanical + AI fallback) |
| `advance_stage_extract()` | `ready_for_extract` | `extracting` → `ready_for_modifier` / `pool_extract` / `failed` | No (ld+json mechanical; AI fallback) |
| `advance_stage_modifier()` | `ready_for_modifier` | `pool_modifier` or `ready_for_branding` | No |
| `advance_stage_branding()` | `ready_for_branding` | `pool_branding` or `ready_to_assemble` | No (mechanical CSS-var extraction) |
| `advance_stage_pdf()` | `needs_pdf` | `pool_pdf` | No |
| `advance_stage_assemble()` | `ready_to_assemble` | `assembling` → `done` / `failed` | No (POST `/api/batch/ingest`) |
| `_submit_pdf_wave()` | `pool_pdf` | `batch_pdf_submitted` | **Sonnet 4.6 vision** |
| `_poll_pdf_waves()` | `batch_pdf_submitted` | `ready_for_modifier` / `failed` | — |
| `submit_stage_wave(stage, ...)` | `pool_*` | `batch_*_submitted` | **Haiku 4.5** |
| `poll_stage_waves(stage, ...)` | `batch_*_submitted` | next stage or `failed` | — |

**Constraints & iteration history:**

- **CLI-only — never a daemon.** Enforced by design: the module only does work when invoked as `__main__`. The launchd plist (`com.valuesystems.demo-builder-agent`) runs `deploy_agent.py` exclusively. Running `batch_pipeline.py` under launchd would cause automatic AI spend without operator approval.

- **Operator principle:** "the batch function should never happen automatically. they need direct intervention from me to process." (2026-04-16, verbatim). This is the architectural axiom for the separation.

- **Batch+cache cost regression (2026-04-16):** When batch + prompt-caching were wired into the always-on daemon, cache-creation events outpaced cache reads on the 2026-04-15 rebuild (1598 rows, ~50 waves). Batch+cache cost MORE than per-row synchronous calls would have. Separation prevents auto-spend and gives the operator cost visibility before each run.

- **Split from deploy_agent.py 2026-04-16:** All `run_staged_pipeline()`, `advance_stage_*()`, `submit_stage_wave()`, `poll_stage_waves()`, `_submit_pdf_wave()`, `_poll_pdf_waves()`, and all Anthropic client code were extracted from `deploy_agent.py` into this file. Shared mechanics (HTTP fetchers, ld+json parsers, URL classifiers) went to `pipeline_shared.py`.

- **`needs_pdf` lifecycle:** `advance_stage_discover()` sets `status='needs_pdf'` + patches `menu_url` with the actual PDF URL. `advance_stage_pdf()` validates `".pdf" in menu_url.lower()` before moving to `pool_pdf`. `_submit_pdf_wave()` submits to Anthropic batch with Sonnet 4.6 document blocks.

- **process_generate_queue removed:** The old sync per-row pipeline that ran alongside the batch pipeline (causing hidden spend invisible to `/v1/messages/batches`) was not ported to this file. Batch-only.

**Known issues:**
- `retry-failed` subcommand is stubbed — exits 1 with a message. Use `rebuild_batch.py` for retries.
- No looping built in — `run-staged` is a single tick. Operator wraps in a shell loop or runs manually.

---

## pipeline_shared.py

**Path:** `agent/pipeline_shared.py`  
**Purpose:** Shared primitives (Supabase client, env load, URL classifiers, HTML/curl fetchers, ld+json extractors, menu-URL discovery) imported by both `deploy_agent.py` and `batch_pipeline.py`.

**What it achieves:** Provides a single source of truth for all mechanical helpers so that changes to fetcher behavior, control-char stripping, URL classification, or ld+json parsing apply to both the daemon and the batch CLI without duplication.

**Inputs / env vars:** Same `.env` file as the other agents — `SUPABASE_URL`, `SUPABASE_KEY`, `ANTHROPIC_API_KEY`. Module loads env at import time.

**Key exports:**
- Supabase REST helpers: `supabase_get`, `supabase_patch`, `HEADERS`, `SUPABASE_URL`, `SUPABASE_KEY`
- HTTP fetchers: `fetch_page_text_curl_cffi`, `fetch_page_text_playwright`, `_fetch_homepage_html`
- ld+json: `_extract_ldjson_menu_text`, `extract_ldjson_full_menu`, `_ldjson_items_to_rows`
- Menu discovery: `discover_menu_url`, `discover_menu_url_ai`, `_extract_menu_index_links`, `_detect_menu_images`
- URL classifiers/constants: `_CF_PHRASES`, `_MENU_HREF_KW`, `_MENU_TEXT_KW`, `_PLATFORM_HOSTS`, `_PDF_RE`, `_COMMON_MENU_PATHS`

**Constraints & iteration history:**

- **Extracted 2026-04-16 (lift-and-shift):** All contents were copied verbatim from `deploy_agent.py` — no behavior changes during extraction. See `agent/SEPARATION_AUDIT.md` for the full classification of every symbol.

- **No wave logic, no POS/SSH/MariaDB, no stage orchestration.** Anything that touches the batch pipeline state machine or the POS tablet stays in `batch_pipeline.py` or `deploy_agent.py` respectively.

- **PostgreSQL control-char stripping in `_fetch_homepage_html`:** Null bytes and control chars (`\x00`–`\x08`, `\x0b`, `\x0c`, `\x0e`–`\x1f`) cause HTTP 400 on Supabase PATCH. Stripping is applied before any Supabase write. Symptom of missing strip: `[POLL] Unhandled error (#1): 400 Client Error` repeating for the same row.

- **`rebuild_batch.py` still imports from here** (as of 2026-04-16 PR1). Prior to the separation, `rebuild_batch.py` imported directly from `deploy_agent.py` and tolerated the daemon's module-level side effects.

**Known issues:**
- `pipeline_shared.py` docstring still mentions `rebuild_batch.py` as a future importer — now current.

---

## deploy_agent_local.py

**Path:** `agent/deploy_agent_local.py`  
**Purpose:** Older variant of the deploy agent targeting a local MariaDB instance instead of the remote demo tablet.  
**Status:** Legacy reference — do not develop. Use `deploy_agent.py`.

---

## test_e2e.py

**Path:** `agent/test_e2e.py`  
**Purpose:** End-to-end integration test that stages a synthetic deploy and verifies the agent picks it up and writes to MariaDB.  
**Status:** Manually run only — not wired into CI.

---

## analyze_failures.py

**Path:** `agent/analyze_failures.py`
**Purpose:** Categorize failed `batch_queue` rows without re-running AI, so failures drive root-cause fixes (upstream URL pruning, code change) instead of blanket retries.

**What it achieves:** Groups failed rows by error pattern + URL class + restaurant-type distribution. Emits a report + optional CSV dump. Never calls Anthropic.

**Inputs:** `SUPABASE_URL`, `SUPABASE_KEY` from `agent/.env`.

**Flags:** `--csv <path>`, `--sample N` (show N URLs per category), `--status <name>` (default: failed).

**Constraints & iteration history:**
- Core principle from 2026-04-15: failures get analysis, not auto-retry. See `memory/feedback_failures_never_auto_retry.md`.
- Error categorization is regex-based over `batch_queue.error`. Add new buckets as new failure modes appear.

---

## test_extract.py

**Path:** `agent/test_extract.py`
**Purpose:** Single-query extraction tester for iterating on fetch logic and prompts without submitting a batch.

**What it achieves:** Runs the full fetch → Haiku extract pipeline against one URL (or batch_queue row id, or a file of URLs) and prints item count + first few items. ~20s per URL vs. ~10 min batch roundtrip.

**Inputs:** `SUPABASE_URL`, `SUPABASE_KEY`, `ANTHROPIC_API_KEY`.

**Flags:** `<url>`, `--row <id>`, `--urls-file <path>`.

**Constraints & iteration history:**
- Imports from `batch_pipeline.py` / `pipeline_shared.py` — changes to the prod pipeline are automatically tested. See `memory/feedback_test_single_query_before_batch.md`.

---

## rebuild_batch.py

**Path:** `agent/rebuild_batch.py`
**Purpose:** Single-shot rebuild CLI (PR1 scope: preflight-only dry-run). Classifies every `batch_queue` row mechanically before any AI call — writes `preflight JSONB` + tags with `rebuild_run_id`, counts buckets, projects AI cost.

**What it achieves:** Replaces the wave-based staged pipeline in `deploy_agent.py` for bulk rebuilds. PR1 populates preflight verdicts + bucket summary. PR3 will add stage batch submission (one Anthropic batch per stage-dependency boundary). Non-dry-run invocations currently hard-error.

**Inputs:** `SUPABASE_URL`, `SUPABASE_KEY` from `agent/.env`. Requires migration `010_preflight_column.sql` applied.

**Flags:** `--run-id <uuid>` (default: new uuid), `--limit N`, `--yes` (rejected in PR1).

**Constraints & iteration history:**
- PR1 is read-only classification. No status mutation, no AI spend.
- Mechanical verdict shape covers url_class, fetch_status, menu_url_candidate, ldjson_items, branding_tokens, image_menu_urls, content_gate_verdict, ai_needed[].
- See `agent/REFACTOR_PLAN.md` for the three-PR sequence.

---

## rebuild_all.py

**Path:** `agent/rebuild_all.py`
**Purpose:** Destructive full-corpus reset: flips every `batch_queue` row back to `queued` and clears every derived field so the agent reprocesses from scratch through the current pipeline.

**What it achieves:** Fresh cost data + fresh output quality on the whole corpus. Required when pipeline improvements (menu-index follower, image-menu, WCAG, zero-price flip) need to be applied to already-shipped rows.

**Inputs:** same env as `deploy_agent.py`. `~/Projects/demo-DBs/` optional snapshot dir.

**Flags:** `--yes` (commit — without it, prints counts only), `--exclude-done` (preserve sessions.deploy_status='done' rows).

**Constraints & iteration history:**
- Orphans `sessions` rows linked via `session_id` — do not run mid-demo. See `memory/feedback_rebuild_preserves_existing_sessions.md`.
- pt_record_id prefix caveat: batch_queue stores bare ChIJ..., sessions prepend `db_`. `--exclude-done` joins with prepend.

---

## fix_contrast.py

**Path:** `agent/fix_contrast.py`
**Purpose:** Retroactively repair WCAG-AA contrast violations on already-deployed demo snapshots and Supabase `sessions.generated_sql` rows.

**What it achieves:** For each SQL file in `~/Projects/demo-DBs/` and each session in Supabase, parses the `ButtonsBackgroundColor` + `ButtonsFontColor` UPDATEs, computes the WCAG contrast ratio, and rewrites the font colour to `#FFFFFF` or `#000000` (whichever has the higher ratio) when the existing combo is below 4.5. Idempotent — no-ops on already-fixed rows.

**Inputs:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` from `../.env.local`. Snapshot dir: `~/Projects/demo-DBs/`.

**Flags:** `--yes` (commit), `--snapshots-only`, `--sessions-only`. Dry-run is the default.

**Constraints & iteration history:**
- Original pipeline could produce AI-generated palettes like white-on-grey that failed WCAG AA — see `memory/feedback_wcag_button_contrast.md`. The root fix now lives in the pipeline (`lib/presets/typePalettes.ts` hardcoded contrast-safe pairs + the extractor clamps at AA). This script cleans up the pre-fix corpus.
- SQL rewrite is purely regex-based — no parsing of the full dump. Safe because the two target UPDATE lines are predictable.

---

## fix_price_nulls.py

**Path:** `agent/fix_price_nulls.py`
**Purpose:** Retroactively flip `IsOpenPriceItem = 1` on deployed items whose `DefaultPrice` ended up NULL/0, so the POS prompts the cashier instead of ringing $0.

**What it achieves:** Scans `~/Projects/demo-DBs/*.sql` + Supabase `sessions.generated_sql`. For every `menuitems` INSERT row where the default-price column is 0 or NULL, rewrites the `IsOpenPriceItem` column to `1`. Idempotent.

**Inputs:** same env as `fix_contrast.py`. Snapshot dir: `~/Projects/demo-DBs/`.

**Flags:** `--yes` (commit), `--snapshots-only`, `--sessions-only`.

**Constraints & iteration history:**
- Root fix is in `lib/sql/deployer.ts` (auto-flip at SQL-generation time). This script handles the already-shipped corpus.
- Regex key: column index 12 (0-indexed) of the `INSERT INTO menuitems VALUES (...)` row is `IsOpenPriceItem`. Must count commas accurately — single-quoted strings can contain commas (e.g. `'Chips, Salsa'`) so the regex has to walk the value list with quote-awareness.

---

## retag_library.py

**Path:** `agent/retag_library.py`
**Purpose:** Backfill / enrich `concept_tags` on existing `demo_builder.image_library` rows so tag-based search (`/api/library/search`) surfaces cross-restaurant matches for library-pulled image re-use.

**What it achieves:** Raises the average tag count and vocabulary diversity on library entries that were seeded before the 2026-04-16 tag-enrichment rules shipped. First observed run: 133 rows averaged 5.5 tags with a 150-term vocabulary and zero rows had `food_category`; after two passes it's 8.6 avg tags, 362-term vocabulary, 131/133 with `food_category`.

**Modes:**

- `--pass 1` — deterministic, free. Re-tokenises `item_name`, strips noise words (`favorite`, `lexi`, `original`, etc.), fixes the unicode artefact `jalape → jalapeno`, inferred regex categories add semantic tags (`seafood` on "Blackened Mahi", `mexican` on "Quesadilla", `beef` on "Cheesesteak"), and populates `food_category` from an item-name keyword table.
- `--pass 2` — Haiku 4.5 vision. Only fires on rows still under `MIN_TAGS=6` after pass 1. Fetches the image bytes from the public `image-library` bucket, sends with matching `media_type`, parses a JSON array of 6–10 tags, merges. Webp/png/jpeg/gif supported; SVGs are skipped (Anthropic vision doesn't accept SVG — see `memory/feedback_anthropic_vision_formats.md`).
- `--pass both --commit` — runs both back-to-back.

**Inputs / env vars (from `agent/.env`, same shape as `deploy_agent.py`):**

| Var | Required | Purpose |
|-----|----------|---------|
| `SUPABASE_URL` | ✅ | Supabase REST URL |
| `SUPABASE_KEY` | ✅ | Service role key (read + PATCH on `image_library`) |
| `ANTHROPIC_API_KEY` | for pass 2 | Claude Haiku 4.5 key |

**Flags:**

- `--commit` (default off) — actually PATCH rows. Otherwise dry-run with a per-row diff.
- `--limit N` — cap rows processed (handy for testing).
- `--pass {1|2|both}` — which pass(es) to run.

**Constraints & iteration history:**

- **Rejected: single Haiku pass over every row.** ~$0.53 for 133 rows with zero information gain on icons whose `item_name` already determines the category. The deterministic pass is strictly cheaper and handles the majority of the lift. Vision stays gated behind `MIN_TAGS`.
- **Rejected: LLM-based tokenisation of `item_name`.** Same argument — regex catches 90% of the cases and does it deterministically.
- **Rejected: running a single `lib/itemTags.ts` TS port directly.** Only way to run the existing TS logic from here is via `npx tsx`; the regex set needed to grow anyway (cross-cuisine tags like "seafood" on "mahi"), and Python is the rest of the batch-pipeline lingua franca.
- **Gotcha: SVG unsupported by Claude vision.** Initial run got HTTP 400 `"Could not process image"` on every row. Fix: `EXT_MEDIA` lookup + skip SVG rows with a log line. Only 3 SVG rows in the library were eligible — acceptable loss.
- **Gotcha: wrong `media_type`.** First cut hardcoded `"image/png"` / fallback `"image/jpeg"`. WebP files sent as JPEG → HTTP 400. Fixed by extension lookup before the call.
- **Dry-run semantics.** Pass 2 in dry-run mode queries the live rows; it does not re-read anything pass 1 would have modified, so dry-run-both can over-report the target set if pass 1 would have pushed rows past `MIN_TAGS`. To get an accurate preview of pass 2 after pass 1, run `--pass 1 --commit` first then `--pass 2` in dry-run.

**Known issues:**

- 3 SVG rows stay under `MIN_TAGS=6`. Could rasterize with `cairosvg` if it matters; today it doesn't.
- Threshold `MIN_TAGS` is hardcoded at 6; if you want a richer library, bump it (more rows go through vision, linearly more cost).

---

# PT Prospect Ranking (serves Prospect Tracker)

AI-driven prospect ranker for the Prospect Tracker app. Classifies restaurants from
Outscraper scrape exports into fit tiers for Value Systems POS. Code lives in
`demo-builder/agent/` because it shares the Anthropic + Supabase infrastructure, but the
data (Outscraper JSON/XLSX) lives in `prospect-tracker/Scrapes/` and the ranking
output targets PT workflows.

## prompts/pt_rank_rubric_v8.md (current)

**Path:** `agent/prompts/pt_rank_rubric_v8.md` (~8446 tokens)
**Purpose:** Explicit, versioned rubric that drives Haiku's classification decisions.
Current production rubric used by `pt_rank_batch.py`.

**What it achieves:** Stores the ranking logic as a first-class artifact — user can
read, diff, and edit the rubric without touching Python. Every version is a new file
(copy-forward) so `prospect_rankings.rubric_version` points at the exact prompt each row
was scored against. YAML frontmatter captures version, model, token count, change log.

**Loaded by:** `pt_rank_batch._load_rubric()` (strips frontmatter, returns body). The
batch script derives the filename dynamically from `RUBRIC_VERSION` constant — bump the
version string + drop a new `pt_rank_rubric_v{N}.md` to roll forward.

**Output JSON schema (v8 adds 4 fields over v7):**
```json
{
  "tier": "small_indie|mid_market|kiosk_tier|chain_nogo|not_a_fit",
  "score": 0-100,
  "reasoning": "2-4 sentences",
  "fit_signals": [{"signal": "...", "evidence": "...", "weight": "+|-"}],
  "concerns": ["..."],
  "detected_pos": "clover|toast|square|skytab|spoton|lightspeed|touchbistro|revel|aloha|micros|hungerrush|harbortouch|upserve|smorefood|fronteats_zbs|popmenu_bundled|corporate_mandated|unknown|none_detected",
  "detected_pos_evidence": "URL/text snippet",
  "estimated_swipe_volume": "high|medium|low|unknown",
  "swipe_volume_evidence": "reviews + category + hours reasoning"
}
```

**Constraints & iteration history:**
- Rubric must clear 4096 tokens for Haiku 4.5 caching (not the documented 2048 — see
  `project_prompt_caching_gap.md`). v7 was ~4913 tokens, v8 is ~8446 tokens.
- **v7 → v8 changes (2026-04-14):**
  1. Breweries / bar & grills / taverns / gastropubs / pubs are ELIGIBLE by default —
     food-serving venues use POS. v7 dumped ~52 of these into not_a_fit. Added Example E
     (Makai Brewing) making the eligibility explicit.
  2. Expanded competitor-POS URL whitelist: `skytab.com`, `online.skytab.com`,
     `smorefood.com`. v7 classified these as chain_nogo; they're swappable competitors.
  3. Explicit "DO NOT infer corporate structure from owner titles" clause. Outscraper
     artifacts like "branch vice president" were triggering false chain_nogo.
  4. chain_nogo threshold raised to ≥20 locations (East Coast Wings added as example).
  5. Added Hyatt/Hilton/Marriott/IHG hotel-restaurant chain_nogo clause.
  6. **CRITICAL per-swipe residual principle at top of rubric.** VSI revenue = per-swipe
     fee × swipes + % × dollar volume. High-volume low-ticket merchants (coffee, quick
     service, kiosks) can out-earn low-volume high-ticket ones. Kiosk_tier score range
     expanded to 55-70 when volume is high. Sort sales queue by
     `(tier, -estimated_swipe_volume, -score)`. Verbatim user quote embedded in rubric:
     "our residuals come off per swipe so things like coffee house may actually be better
     than they look because it's quick turnover a lot of swipes even if low revenue."
  7. Added `detected_pos` + `estimated_swipe_volume` output fields with controlled
     vocabularies — sales needs to know the current vendor and residual potential.
- v7 reframed the axis around POS decision authority (not location count) after user
  directive: "chains aren't bad. it's the big corporate change that the individuals have
  no say with the pos used." Small regional chains are mid_market; only
  corporate-mandated national franchisees are chain_nogo.
- 5 worked examples anchor rule text against edge cases (Thai Season, Cugino Forno 6-loc,
  Tropical Smoothie Cafe, Takoyaki FrontEats, Makai Brewing).

## prompts/pt_rank_rubric_v7.md (archived)

**Path:** `agent/prompts/pt_rank_rubric_v7.md`
**Status:** Superseded by v8. Retained for `prospect_rankings.rubric_version = 'v7-2026-04-14'`
row lineage. Do not edit. If another revision is needed, copy v8 → v9 and diff.

## scrape_loader.py

**Path:** `agent/scrape_loader.py`
**Purpose:** Unified loader for PT ranking input — Outscraper exports + optional HTML enrich.

**What it achieves:** Reads the 16 Outscraper JSON/XLSX files in `prospect-tracker/Scrapes/`
(the complete prospect corpus — PT product does not store raw HTML archives), dedups by
`place_id` (~2229 unique prospects from 2524 raw rows), annotates `sibling_locations` by
grouping normalized names across place_ids, and optionally left-joins `raw_text` +
`homepage_html` from `demo_builder.batch_queue` for the ~42 prospects that also went
through the demo-builder pipeline.

**Inputs / env vars:**

| Var | Required | Purpose |
|-----|----------|---------|
| `SUPABASE_URL`, `SUPABASE_KEY` | Only with `--enrich` | Read batch_queue.raw_text/homepage_html |

**API:**
- `load_prospects(enrich=False) -> list[dict]` — returns slimmed, deduped, annotated
  prospect dicts. Each dict has the Outscraper fields plus `sibling_locations` (int) and
  optionally `raw_text`/`homepage_html`/`batch_queue_id`.
- `annotate_location_counts(prospects)` — adds `sibling_locations` and `sibling_cities` by
  normalized-name grouping. Critical: this is how we detect multi-location regional chains
  from Outscraper data (boosted tier agreement from 80% → 95% in cross-validation).

**Constraints & iteration history:**
- User statement 2026-04-14: "those 16 files are all the scrapes. some are json. some are
  XLX." PT product never stored raw HTML — Outscraper structured fields ARE the primary
  signal. Earlier design assumed raw HTML was available for all prospects; corrected after
  finding `prospect-tracker/Scrapes/raw/` was empty.
- `_norm_name()` strips `#N` suffixes and `- City` suffixes before grouping, so
  "Margarita's Mexican Restaurant #3" and "Margarita's Mexican Restaurant #7" cluster.
- place_id is present on 100% of Outscraper rows — safe PK for `prospect_rankings`.

## pt_rank_prototype.py

**Path:** `agent/pt_rank_prototype.py`
**Purpose:** Synchronous per-prospect ranker for iteration and spot checks.

**What it achieves:** Runs the rubric against one or N prospects from `batch_queue.raw_text`
live, prints colored per-prospect verdicts (tier, score, reasoning, signals, concerns). Used
to iterate rubric quality before scaling to batch.

**Run:** `python3 agent/pt_rank_prototype.py --limit 25` or `--id <uuid>`.

**Constraints & iteration history:**
- `temperature=0` is required. Default 1.0 caused Big Bull's BBQ to flip between
  `mid_market 68` and `chain_nogo 15` across identical runs — documented in
  `feedback_anthropic_temperature_default.md`.
- Rubric text was refactored out of this file on 2026-04-14 — now loaded from
  `prompts/pt_rank_rubric_v7.md`. File-backed rubric makes version history explicit.

## pt_rank_unified.py

**Path:** `agent/pt_rank_unified.py`
**Purpose:** Ranker that accepts a unified prospect dict (Outscraper + optional HTML).

**What it achieves:** Reuses the rubric from `pt_rank_prototype` but builds a structured
user message from Outscraper fields (name/category/subtypes/phone/address/owner/rating/
hours) plus optional `raw_text`/`homepage_html`. Injects the derived `DERIVED_location_count`
signal from `scrape_loader.annotate_location_counts()` so the ranker sees multi-location
status without needing HTML's Locations nav.

**Run:** `python3 agent/pt_rank_unified.py --limit 15` (random sample), `--with-html`,
`--no-html`, `--name "Big Bull's BBQ"`.

## pt_rank_crosscheck.py

**Path:** `agent/pt_rank_crosscheck.py`
**Purpose:** Cross-validation harness — rank the same prospect twice, once with HTML and
once with HTML stripped, measure tier agreement.

**What it achieves:** Validates that the Outscraper-only path produces verdicts consistent
with the richer HTML-inclusive path. Critical because only 42/2229 prospects have HTML
available — the baseline ranker must work without it.

**Result 2026-04-14:** 95% tier agreement (19/20) on 20-prospect sample at rubric v7 with
sibling_locations annotation. Without sibling_locations: 80%.

## pt_rank_batch.py

**Path:** `agent/pt_rank_batch.py`
**Purpose:** One-shot batch submitter/poller/ingester for the full prospect corpus.

**What it achieves:** Submits all ~2229 prospects as one Anthropic Messages Batch (50%
discount + cache hits after first request). Polls until `ended`, parses each result,
upserts into `demo_builder.prospect_rankings` keyed by `place_id`.

**Run:**
- `python3 agent/pt_rank_batch.py --dry-run` — build requests, print stats
- `python3 agent/pt_rank_batch.py --submit` — submit, exit
- `python3 agent/pt_rank_batch.py --poll` — poll the last submitted batch, ingest results
- `python3 agent/pt_rank_batch.py --run` — submit + poll + ingest (blocks)
- `python3 agent/pt_rank_batch.py --only-missing --run` — skip prospects already ranked
- `python3 agent/pt_rank_batch.py --limit 50 --run` — rank first 50 only

**State file:** `agent/.pt_rank_batch_state.json` (gitignored) — stores `batch_id`,
`submitted_at`, `prospect_place_ids[]`. Needed by `--poll` to map results back to input
prospects.

**Cost projection:** 2229 prospects × Haiku 4.5 batch rate with cache → ~$1.00–1.50 total.
Synchronous would be ~$2.80.

**Constraints & iteration history:**
- `custom_id = place_id` — used for Supabase upsert on ingest, and lets `--only-missing`
  skip already-ranked prospects by diffing against `prospect_rankings.place_id`.
- `--poll` can run after `--submit` without keeping the process alive (state is on disk).
  Anthropic batches have a 24h SLA; empirically 2229-request batches end in ~6 min.
- Results use `Prefer: resolution=merge-duplicates` on the upsert so re-runs replace
  prior rankings for the same place_id.
- **Rubric loading (2026-04-14):** `RUBRIC_VERSION = "v8-2026-04-14"` + `_load_rubric()`
  strips YAML frontmatter and loads `prompts/pt_rank_rubric_v{major}.md` dynamically.
  Bump version + drop a new markdown file to roll forward — no code changes needed.
- **Ingest writes new v8 fields:** `detected_pos`, `detected_pos_evidence`,
  `estimated_swipe_volume`, `swipe_volume_evidence`. All nullable — older `v7-*` rows
  have NULL for these until re-ranked.

## pt_rank_v8_sample.py

**Path:** `agent/pt_rank_v8_sample.py`
**Purpose:** Targeted sanity harness — re-rank a flagged subset with a new rubric
synchronously before committing to a full batch.

**What it achieves:** Loads prospects flagged by category keyword (brewery/tavern/
bar & grill/pub/gastropub/sports bar) or URL (skytab/smorefood), fetches the stored
v7 row from `prospect_rankings`, re-ranks each synchronously with v8 rubric,
prints the flip matrix (old tier → new tier counts + regression flags). Does NOT write
to Supabase — purely a dry-run QA tool.

**Run:** `python3 agent/pt_rank_v8_sample.py` (uses hardcoded flag heuristics).

**Constraints & iteration history:**
- Created 2026-04-14 specifically to validate v8 changes (brewery eligibility + SkyTab/
  Smorefood whitelist) before paying for a full 2229-row re-rank. 186 flagged prospects
  confirmed: 40 not_a_fit→small_indie, 2 chain_nogo→small_indie, 132 unchanged, 1
  regression. 96% cache hit rate, $0.49 synchronous.
- Pattern is reusable: any future rubric revision should be sanity-checked against the
  prospects the new rules are designed to affect before full re-rank.

## Storage: demo_builder.prospect_rankings

**Migrations:**
- `supabase/migrations/005_prospect_rankings.sql` — base table (v7)
- `supabase/migrations/006_prospect_rankings_detected_pos.sql` — adds `detected_pos` +
  `detected_pos_evidence` + partial index excluding `unknown`/`none_detected`
- `supabase/migrations/007_prospect_rankings_swipe_volume.sql` — adds
  `estimated_swipe_volume` (CHECK constraint for high/medium/low/unknown) +
  `swipe_volume_evidence` + composite partial index
  `(tier, estimated_swipe_volume, score DESC) WHERE tier IN (...)` for sales queue

| Column | Type | Purpose |
|--------|------|---------|
| `place_id` | TEXT PK | Google place_id from Outscraper — covers all 2229 prospects |
| `name`, `website`, `city`, `state`, `category` | TEXT | Denormalized Outscraper fields for direct queries |
| `tier` | TEXT CHECK | small_indie / mid_market / kiosk_tier / chain_nogo / not_a_fit |
| `score` | INT 0–100 | Numeric fit score |
| `reasoning` | TEXT | 2–4 sentence AI explanation |
| `fit_signals`, `concerns` | JSONB | AI-produced signal array + concern array |
| `detected_pos` | TEXT | Controlled vocab: current POS vendor for sales intel (006) |
| `detected_pos_evidence` | TEXT | URL/text snippet backing the detection (006) |
| `estimated_swipe_volume` | TEXT CHECK | high/medium/low/unknown — residual value proxy (007) |
| `swipe_volume_evidence` | TEXT | reviews+category+hours reasoning (007) |
| `sibling_locations` | INT | Count of place_ids sharing normalized name in scrape corpus |
| `has_html_input` | BOOL | True if HTML was available at ranking time |
| `rubric_version` | TEXT | e.g. `v8-2026-04-14` — points at rubric markdown file |
| `model`, `batch_id` | TEXT | claude model + Anthropic batch id for audit |
| `input_tokens`, `output_tokens`, `cache_read_tokens` | INT | Per-request usage |
| `ranked_at` | TIMESTAMPTZ | When this row was scored |

**Indexes:**
- `(tier, score DESC)` — leaderboard queries
- `(ranked_at DESC)` — audit
- `(detected_pos) WHERE detected_pos NOT IN ('unknown','none_detected')` — competitor-POS
  filter for prospects where VSI can actively pitch a swap
- `(tier, estimated_swipe_volume, score DESC) WHERE tier IN ('small_indie','mid_market','kiosk_tier')`
  — sales queue sort: best fit first, then highest volume, then highest score

**Sales queue SQL pattern (weighted by residual potential):**
```sql
SELECT place_id, name, city, state, tier, score, detected_pos, estimated_swipe_volume
FROM demo_builder.prospect_rankings
WHERE tier IN ('small_indie','mid_market','kiosk_tier')
ORDER BY
  CASE tier WHEN 'small_indie' THEN 1 WHEN 'mid_market' THEN 2 ELSE 3 END,
  CASE estimated_swipe_volume WHEN 'high' THEN 1 WHEN 'medium' THEN 2
       WHEN 'low' THEN 3 ELSE 4 END,
  score DESC;
```

## Full v8 re-rank (2026-04-14)

- Batch ID: `msgbatch_01V2dgHJPsGa8buwUX2F2s1R`
- 2229/2229 succeeded, 0 errors, ~6 min wall time
- **Tier distribution:** small_indie 48%, chain_nogo 19%, not_a_fit 19%, kiosk_tier 10%,
  mid_market 5%. (v7 had chain_nogo 41%, not_a_fit 29%, small_indie <1% — v8 corrected
  the over-exclusion.)
- **Volume distribution:** high 51%, medium 22%, low 10%, unknown 18%
- **Detected POS:** 715 none_detected (greenfield), 225 corporate_mandated, plus
  explicit Square 3, SpotOn 3, Toast 2, Smorefood 2, Clover 1, FrontEats 1
- **Cost:** $4.39 batch total (measured from ingested token counts). Breakdown:
  uncached input 950K tokens = $0.48, cache reads 18.6M tokens = $0.93, output 1.19M
  tokens = $2.98. Synchronous equivalent would have been ~$8.77.
- **Projection lesson:** pre-v8 cost estimate was ~$1.50 — undershot by ~3× because v8
  added 4 new output fields (detected_pos + evidence + swipe_volume + evidence) which
  roughly doubled average response length vs v7. Future rubric revisions with new
  output fields: re-estimate output tokens, not just input.
