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

**Constraint:** Only extracts from same-domain `/menus/*` section URLs. Platform sites that load menu data dynamically via XHR after page load (e.g. pure SPA menus) will return `None` and fall through to the AI pipeline.

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
