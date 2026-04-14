# Agent Tools

## deploy_agent.py

**Path:** `agent/deploy_agent.py`  
**Purpose:** Polls Supabase for queued deployments and executes them: runs SQL against MariaDB, pushes images via SCP, and restarts the POS.

**What it achieves:** When AutoPilot stages a deploy from the browser, this agent picks it up from Supabase and delivers it to the POS tablet — executing the generated SQL, pushing branding/item images via SCP, and restarting the POS Electron app so changes take effect immediately.

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

### `discover_menu_url(homepage_url: str) -> dict`

Resolves a restaurant homepage (or any URL) to an actual menu page before extraction. Returns `{"type": str, "url": str}` where `type` is one of:

| Type | Meaning | Dispatch |
|------|---------|----------|
| `ldjson` | ld+json Menu data found on the provided URL itself | Extract directly via `extract_ldjson_full_menu()` |
| `html` | Nav link to a menu page on the same domain | Proceed with extraction on discovered URL |
| `platform` | Menu hosted on a known platform (Toast, Square, Popmenu, etc.) | Standard pipeline on discovered URL |
| `pdf` | Menu link resolves to a `.pdf` file | Set `batch_queue.status = 'needs_pdf'`, skip |
| `not_found` | No credible menu link found | Fall through to extraction on original URL |

Scoring: exact path match (`/menu`, `/menus`, `/food`) > href keyword > anchor text keyword. Never throws — exceptions return `not_found`.

Constants used: `_MENU_HREF_KW`, `_MENU_TEXT_KW`, `_PLATFORM_HOSTS`, `_PDF_RE`.

### `extract_ldjson_full_menu(menu_url: str) -> str | None`

Extracts complete menu text from schema.org `application/ld+json` blocks across all section pages. Returns merged plain text (up to 40,000 chars) or `None` if < 100 chars found.

1. `curl_cffi GET menu_url` — parse ld+json from first page + collect same-domain `/menus/*` section URLs from HTML nav
2. `ThreadPoolExecutor(max_workers=8)` — concurrent `curl_cffi GET` on remaining section URLs
3. Merge all `_extract_ldjson_menu_text()` results
4. Logs `[LD] N sections, M items`

**Why:** Restaurant platforms (Popmenu, BentoBox, schema.org-compliant sites) embed full structured menu data as ld+json for SEO. Extracting this way is free (~3–5s, zero AI tokens), vs 30–90s + ~$0.03–0.05/restaurant via the AI pipeline.

**Constraint:** Only extracts from same-domain `/menus/*` section URLs. Platform sites that load menu data dynamically via XHR after page load (e.g. pure SPA menus) will return `None` and fall through to the AI pipeline. **Popmenu-specific caveat:** Section pages (`/menus/salads`, etc.) only carry `@type: Restaurant` ld+json; menu items are loaded client-side. Only the first section's items are available from the static ld+json on the main `/food-menu` page — this is still useful for demos but is not a full menu. Full coverage on Popmenu requires Playwright or the AI pipeline.

### `_handle_process_result(job, jid, result, label) -> bool`

DRY helper — given a process-route response `result` dict, calls `save_snapshot()` on success and marks the job failed on error. Returns `True` if the job completed successfully. `label` is a short string (`[GEN]`, `[CF]`, `[PW]`, `[LD]`) used in log output. Eliminates duplicate success/failure handling across the four dispatch paths in `process_generate_queue()`.

### `process_generate_queue()` dispatch order

```
For each queued job:
1. Claim → status = "processing"
2. discover_menu_url(menu_url)
   → pdf:       PATCH status = "needs_pdf", continue
   → other:     use discovered URL; PATCH menu_url if different
3. extract_ldjson_full_menu(menu_url)
   → text:      POST /api/batch/process with {queue_id, raw_text}  [LD path]
   → None:      fall through
4. POST /api/batch/process with {queue_id}                         [GEN path — Vercel fetches URL]
   → success:   save_snapshot, done
   → CF/JS err: fall through
5. curl_cffi fetch → POST with {queue_id, raw_text}                [CF path]
   → success:   save_snapshot, done
   → fail:      fall through
6. Playwright fetch → POST with {queue_id, raw_text}               [PW path]
   → CF detected: fail
   → success:   save_snapshot, done
   → fail:      mark failed
```

### `needs_pdf` status lifecycle

Set by `process_generate_queue()` when `discover_menu_url()` returns `type = "pdf"`. The agent PATCHes `batch_queue.status = "needs_pdf"` and moves to the next job — no extraction is attempted. This status is terminal for the mechanical batch pass.

**Second queue (not yet implemented):** A separate agent pass will pick up `needs_pdf` rows and use Sonnet vision to extract the PDF menu. Until then, rows in this state stay at `needs_pdf` indefinitely. Resetting them to `queued` will cause the agent to re-discover the PDF link and set `needs_pdf` again.

---

**Constraints & iteration history:**

- **Turso migration (2026-04-10) — rolled back:** Agent was rewritten to use Turso HTTP API (`/v2/pipeline`) instead of Supabase. Hit a network-level block — Turso endpoint was unreachable from both the agent and Vercel edge functions on the demo location network. Rolled back to Supabase within the same day.

- **JSONB timeout root cause:** Original Supabase approach stored base64 image data URIs (~60KB each) directly in the `sessions.pending_images` JSONB column. With 5–10 images, the upsert payload exceeded Supabase statement timeout limits and killed the PROD project. Fix: the stage route now uploads images to Vercel Blob first; the agent receives URLs (~100 bytes) instead of raw bytes. Agent's `push_images_scp()` handles both data URIs and URLs.

- **POS restart via PsExec:** SSH + taskkill + PsExec is required because Electron crashes with `GPU process launch failed: error_code=18` when started from SSH session 0. PsExec `-i {session_id}` launches into the interactive desktop session. VBS wrapper hides the cmd.exe window. `--no-sandbox` allows GPU access from the remote session context. See parent CLAUDE.md for full pattern.

- **VBS quoting bug (fixed 2026-04-10):** Original VBS content was built from two Python string literals with implicit concatenation. The `&&` separator ended up outside the `WshShell.Run` string, so `cd` ran but `Pecan POS.exe` never launched — POS was killed but not restarted. Fixed by keeping the full command in a single string. Now always unconditionally overwrites the VBS on every restart (`deploy_restart_script`) rather than checking existence, so a corrupt VBS can never persist.

- **Session ID detection:** `query session` exits non-zero on some Windows builds and may write to stderr. Agent parses both stdout and stderr regardless of return code, defaults to session 1.

- **Schema headers required:** All Supabase requests must include `Accept-Profile: demo_builder` and `Content-Profile: demo_builder` headers, or PostgREST defaults to `public` schema.

- **Supabase schema permissions (2026-04-10):** `demo_builder` schema was created and exposed to PostgREST but `GRANT USAGE` and `GRANT ALL ON TABLES` were never run for `anon/authenticated/service_role`. Every API call returned `permission denied for schema demo_builder`. Fixed via Supabase MCP.

**Known issues:**
- `execute_sql` splits on `;` — would break if generated SQL contained semicolons inside string literals. Low risk (machine-generated SQL), but not robust.
- `deploy_agent_local.py` is an older variant for local MariaDB; keep as reference, do not develop.

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

# PT Prospect Ranking (serves Prospect Tracker)

AI-driven prospect ranker for the Prospect Tracker app. Classifies restaurants from
Outscraper scrape exports into fit tiers for Value Systems POS. Code lives in
`demo-builder/agent/` because it shares the Anthropic + Supabase infrastructure, but the
data (Outscraper JSON/XLSX) lives in `prospect-tracker/Scrapes/` and the ranking
output targets PT workflows.

## prompts/pt_rank_rubric_v7.md

**Path:** `agent/prompts/pt_rank_rubric_v7.md`
**Purpose:** Explicit, versioned rubric that drives Haiku's classification decisions.

**What it achieves:** Stores the ranking logic as a first-class artifact — the user can
read, diff, and edit the rubric without touching Python. Every version is a new file
(copy-forward) so `prospect_rankings.rubric_version` points at the exact prompt each row
was scored against. YAML frontmatter captures version, model, token count, change log.

**Loaded by:** `pt_rank_prototype._load_rubric()` (strips frontmatter, returns body).

**Constraints & iteration history:**
- Rubric must clear 4096 tokens for Haiku 4.5 caching (not the documented 2048 — see
  `project_prompt_caching_gap.md`). v7 is ~4913 tokens.
- v7 reframed the axis around POS decision authority (not location count) after user
  directive: "chains aren't bad. it's the big corporate change that the individuals
  have no say with the pos used." Small regional chains are mid_market; only
  corporate-mandated national franchisees are chain_nogo.
- Added 4 worked examples (Thai Season / Cugino Forno 6-loc / Tropical Smoothie /
  Takoyaki) because rule text alone didn't hold against edge cases like Cugino Forno's
  unified website.
- Added competitor POS URL whitelist (cloveronline.com, toasttab.com, etc.) — these are
  PURSUE signals, not closed ecosystems.

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
  Anthropic batches have a 24h SLA; a 2229-request batch typically ends in minutes.
- Results use `Prefer: resolution=merge-duplicates` on the upsert so re-runs replace
  prior rankings for the same place_id.

## Storage: demo_builder.prospect_rankings

**Migration:** `supabase/migrations/005_prospect_rankings.sql`

| Column | Type | Purpose |
|--------|------|---------|
| `place_id` | TEXT PK | Google place_id from Outscraper — covers all 2229 prospects |
| `name`, `website`, `city`, `state`, `category` | TEXT | Denormalized Outscraper fields for direct queries |
| `tier` | TEXT CHECK | small_indie / mid_market / kiosk_tier / chain_nogo / not_a_fit |
| `score` | INT 0–100 | Numeric fit score |
| `reasoning` | TEXT | 2–4 sentence AI explanation |
| `fit_signals`, `concerns` | JSONB | AI-produced signal array + concern array |
| `sibling_locations` | INT | Count of place_ids sharing normalized name in scrape corpus |
| `has_html_input` | BOOL | True if HTML was available at ranking time |
| `rubric_version` | TEXT | e.g. `v7-2026-04-14` — points at rubric markdown file |
| `model`, `batch_id` | TEXT | claude model + Anthropic batch id for audit |
| `input_tokens`, `output_tokens`, `cache_read_tokens` | INT | Per-request usage |
| `ranked_at` | TIMESTAMPTZ | When this row was scored |

Indexed on `(tier, score DESC)` for leaderboard queries and `(ranked_at DESC)` for audit.
