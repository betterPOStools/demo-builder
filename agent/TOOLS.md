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

**Constraints & iteration history:**

- **Turso migration (2026-04-10) — rolled back:** Agent was rewritten to use Turso HTTP API (`/v2/pipeline`) instead of Supabase. Hit a network-level block — Turso endpoint was unreachable from both the agent and Vercel edge functions on the demo location network. Rolled back to Supabase within the same day.

- **JSONB timeout root cause:** Original Supabase approach stored base64 image data URIs (~60KB each) directly in the `sessions.pending_images` JSONB column. With 5–10 images, the upsert payload exceeded Supabase statement timeout limits and killed the PROD project. Fix: the stage route now uploads images to Vercel Blob first; the agent receives URLs (~100 bytes) instead of raw bytes. Agent's `push_images_scp()` already handled both data URIs and URLs (lines 204–211), so no agent change was needed for this fix.

- **POS restart via PsExec:** SSH + taskkill + PsExec is required because Electron crashes with `GPU process launch failed: error_code=18` when started from SSH session 0. PsExec `-i {session_id}` launches into the interactive desktop session. VBS wrapper hides the cmd.exe window. `--no-sandbox` allows GPU access from the remote session context. See parent CLAUDE.md for full pattern.

- **Session ID detection:** `query session` may write to stderr and exit non-zero on some Windows builds. Agent parses both stdout and stderr regardless of return code, defaults to session 1 if detection fails.

- **Schema headers required:** All Supabase requests must include `Accept-Profile: demo_builder` and `Content-Profile: demo_builder` headers, or PostgREST will 406 (schema not in exposed list) or default to `public` schema.

- **SUPABASE_URL must use `https://`:** Supabase REST API is HTTPS only. An early iteration used the `libsql://` prefix accidentally copied from Turso config.

**Known issues:**
- No retry logic on transient network failures — a single poll failure prints an error and continues
- `deploy_agent_local.py` is an older variant for local MariaDB; keep as reference, do not develop

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
