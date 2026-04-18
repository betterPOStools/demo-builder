# Refactor Plan — Wave Daemon → Single-Shot Rebuilder

**Status:** PR1 shipped 2026-04-16 (migration + preflight dry-run). PR2-6 remaining. See `ROLLBACK.md` for current agent state.

**Revision log:**
- 2026-04-16: Initial plan.
- 2026-04-16 (post-PR1): Patched gap analysis into plan — reset semantics (§2.0), in-flight cleanup (§2.0b), assemble dedup (§2.4), live discover in preflight, P95 cost gate, prompt-load assertion, additional PR2 callers, advisory lock (§7.12), unit tests (§7.14).
- 2026-04-16 (PR3 review): Patched 10 PR3-specific holes — operator policy is **no automatic resubmission, failures exfilled to `needs_review`**. New column `active_batch_run_id` (§2.5) gives resume a per-row run↔batch authority. §2.0b routes orphans to `needs_review` (not `queued`). §2.4 adds `deploy_status` 409 guard. §2.6 catches `max_tokens` truncation. §2.7 coerces invalid `restaurant_type` to `"other"`. §7.6 rewritten as drain-only resume. §7.16/17/18 added for post-flight variance, assemble concurrency, image-menu reroute. §7.12 upgraded to `pg_try_advisory_lock` + atexit/signal release with port-5432 requirement.
- 2026-04-16 (PR3 review, cache fallback): Added §2.8 — per-batch `select_cache_mode` decision (off/5min/1h) based on N, T_sys, est drain time. Runtime empirical override demotes to `off` if `cache_creation > cache_read` per stage. CLI flag `--cache-mode {auto,off,force-5min,force-1h}`. First production run uses `off` to baseline. §7.16 extended with per-stage cache stats table. Defensive unit test for prompt-prefix byte-identity across rows.

**Goal:** Replace the wave-based staged pipeline in `deploy_agent.py` with a single-shot `rebuild_batch.py` that runs all mechanical work first, then submits one Anthropic batch per stage-dependency boundary. Target ~$8 per 1598-row full rebuild (vs ~$40-65 currently) with predictable cost before submission.

---

## 1. Supabase Migrations

### `010_preflight_column.sql` (SHIPPED in PR1)

```sql
ALTER TABLE demo_builder.batch_queue
  ADD COLUMN IF NOT EXISTS preflight          JSONB,
  ADD COLUMN IF NOT EXISTS preflight_run_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rebuild_run_id     TEXT;

CREATE INDEX IF NOT EXISTS idx_batch_queue_preflight_pending
  ON demo_builder.batch_queue (rebuild_run_id, preflight_run_at)
  WHERE preflight IS NULL;

CREATE INDEX IF NOT EXISTS idx_batch_queue_preflight_ai_needed
  ON demo_builder.batch_queue USING GIN ((preflight -> 'ai_needed'));

CREATE INDEX IF NOT EXISTS idx_batch_queue_preflight_url_class
  ON demo_builder.batch_queue ((preflight ->> 'url_class'))
  WHERE preflight IS NOT NULL;
```

Additive only — existing `extraction_result`, `modifier_result`, `branding_result`, `*_batch_id` columns all stay so `/api/batch/ingest` is unaffected.

### `011_batch_resume_semantics.sql` (ships in PR3)

```sql
ALTER TABLE demo_builder.batch_queue
  ADD COLUMN IF NOT EXISTS active_batch_run_id TEXT,
  ADD COLUMN IF NOT EXISTS review_reason       TEXT;

-- Resume authority: find ACTIVE rows for a given run by batch_id presence + run match
CREATE INDEX IF NOT EXISTS idx_batch_queue_active_run
  ON demo_builder.batch_queue (active_batch_run_id)
  WHERE active_batch_run_id IS NOT NULL;

-- Review dashboard / --recover-orphans filter
CREATE INDEX IF NOT EXISTS idx_batch_queue_needs_review
  ON demo_builder.batch_queue (review_reason)
  WHERE status = 'needs_review';
```

See §2.5 for usage.

### `012_batch_queue_events.sql` (ships in PR3)

Per-row append-only event log. Status column on `batch_queue` stays as the
fast-lookup denormalized cache; history is the operator's decision substrate.
If status and history ever diverge, history wins.

```sql
CREATE TABLE demo_builder.batch_queue_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_queue_id  UUID NOT NULL REFERENCES demo_builder.batch_queue(id) ON DELETE CASCADE,
  rebuild_run_id  TEXT NOT NULL,
  stage           TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  batch_id        TEXT,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),

  input_tokens          INT,
  output_tokens         INT,
  cache_creation_tokens INT,
  cache_read_tokens     INT,
  cost_usd              NUMERIC(10,6),

  error_text       TEXT,
  review_reason    TEXT,
  http_status      INT
);

CREATE INDEX ON demo_builder.batch_queue_events (batch_queue_id, ts DESC);
CREATE INDEX ON demo_builder.batch_queue_events (rebuild_run_id);
CREATE INDEX ON demo_builder.batch_queue_events (stage, event_type, ts DESC);
```

See §2.9 for write-side wiring and event vocabulary. Read-side analysis CLI deferred to PR6.

---

## 2. New File — `agent/rebuild_batch.py` (~1000 lines)

Single-shot CLI. Not a daemon. Phases (strict barriers between each):

```
0.  --reset (optional)      clear derived cols on rows matching status filter — see §2.0
0b. In-flight cleanup       reclassify stuck batch_*/pool_*/ready_* rows — see §2.0b
1.  Preflight                mechanical classification for every row, parallel
1b. Cost gate                project spend from preflight.ai_needed counts — see §6
2.  (reserved — phase 1+1b run together before submit)
3.  Stage batches            one batch per stage, dependency-ordered
4.  Assemble                 POST /api/batch/ingest per ready row — see §2.4 on dedup
5.  Report                   counts, cost actuals, failure histogram
```

### §2.0 — `--reset` semantics (explicit)

The reset flag is destructive by design. To avoid the "break PT mid-route"
footgun (see `memory/feedback_rebuild_preserves_existing_sessions.md`), rules:

**Default scope:** `status in ('failed', 'queued', 'pool_discover', 'pool_extract',
'pool_modifier', 'pool_branding', 'pool_pdf', 'pool_image_menu',
'ready_for_extract', 'ready_for_modifier', 'ready_to_assemble', 'discovering',
'assembling')`. **Never touches `done`.**

**Columns cleared:** `extraction_result`, `modifier_result`, `branding_result`,
`raw_text`, `homepage_html`, `discover_batch_id`, `extract_batch_id`,
`modifier_batch_id`, `branding_batch_id`, `pdf_batch_id`, `image_menu_batch_id`,
`stage_custom_id`, `batch_submitted_at`, `last_polled_at`, `error`.

**Columns preserved:** `id`, `pt_record_id`, `name`, `menu_url`, `restaurant_type`,
`created_at`, `session_id` (preserved so any existing demo stays linked — PT's
`/api/pt/demos/[id]` keeps finding it), `preflight` (preflight re-runs regardless).

**Status reset:** rows transition to `queued`.

**`--include-done` flag:** explicit opt-in to also reset rows in status `done`.
When set, additionally clears `session_id` (ingest will then create a fresh
session row; existing session rows remain in `demo_builder.sessions` but lose
their back-pointer — that is the expected behavior of a "fresh rebuild").

### §2.0b — In-flight cleanup (orphan handling)

On every rebuild_batch invocation (even without `--reset`), the first step
after `fetch_rows()` is:

```python
def reclaim_stuck(rows, current_run_id, stale_after_minutes=30):
    """Rows stuck in batch_*_submitted / pool_* / ready_* / *ing past the
    stale threshold whose ownership is NOT the current run route to
    needs_review (not queued). Under operator policy 'no automatic
    resubmission', orphans must be human-reviewed before re-entering
    the pipeline."""
```

**Critical — own-run exclusion (hole #4):** scope must exclude the current
run's own in-flight work, else a 31-min resume reclaims its own batches.

```sql
WHERE updated_at < now() - (interval '1 minute' * :stale_after_minutes)
  AND status IN ('batch_discover_submitted','batch_extract_submitted',
                 'batch_modifier_submitted','batch_branding_submitted',
                 'batch_pdf_submitted','batch_image_menu_submitted',
                 'pool_discover','pool_extract','pool_modifier',
                 'pool_branding','pool_pdf','pool_image_menu',
                 'ready_for_extract','ready_for_modifier',
                 'ready_to_assemble','discovering','assembling')
  AND rebuild_run_id     IS DISTINCT FROM :current_run_id
  AND active_batch_run_id IS DISTINCT FROM :current_run_id
```

**Disposition:** status → `needs_review`, `review_reason = 'stuck_orphan'`.
Clear `*_batch_id`, `batch_submitted_at`, `last_polled_at`,
`active_batch_run_id`. Preserve `extraction_result` / `modifier_result` /
`branding_result` / `preflight` (the work already done stays visible
during review).

**Recovery:** operator runs `rebuild_batch.py --recover-orphans` to move
`status='needs_review' AND review_reason='stuck_orphan'` rows back to
`queued` (preflight stays, only rebuild_run_id clears). Never automatic.

### §2.4 — Assemble dedup + mid-deploy guard

`/api/batch/ingest` today creates a new `sessions` row per call. If the same
`pt_record_id` is re-processed (rebuild of a done row, `--include-done`),
we get a duplicate session. Fix in PR3:

**Option A (preferred — in-route fix):** change `/api/batch/ingest` to
upsert `sessions` by `pt_record_id`. Single source of truth, works regardless
of caller.

**Option B (rebuild-only):** rebuild_batch skips rows where
`batch_queue.session_id IS NOT NULL` unless `--replace-session` is set. Older
sessions remain untouched.

Decision: ship Option A. Stale/orphan sessions in `demo_builder.sessions`
with no back-pointer are cleaned up by a separate `--gc-sessions` subcommand
(out of scope for PR3).

**Mid-deploy collision guard (hole #1):** upsert must NOT overwrite a session
whose `deploy_status IN ('queued','executing')` — the deploy agent has
already picked it up and is mid-transit. Rewriting `generated_sql` or
`pending_images` under a running deploy ships half-old/half-new SQL to the
tablet. `/api/batch/ingest` returns **409 Conflict** with a body including
the current `deploy_status`; `run_assemble` on the rebuild side treats 409
as **skip + log** (not a row-level failure — the row already has a live
deploy in flight). Rows where ingest 409s get status `needs_review`,
`review_reason='deploy_in_flight_collision'` so the operator can decide
whether to wait + retry or force via `--replace-session` after the deploy
completes.

`app/api/batch/ingest/route.ts` sketch:

```ts
const existing = await supabase
  .from("sessions")
  .select("id, deploy_status")
  .eq("pt_record_id", pt_record_id)
  .maybeSingle();
if (existing.data?.deploy_status &&
    ["queued", "executing"].includes(existing.data.deploy_status)) {
  return new Response(JSON.stringify({
    error: "deploy_in_flight",
    deploy_status: existing.data.deploy_status,
    session_id: existing.data.id,
  }), { status: 409 });
}
// ... proceed with upsert
```

### §2.5 — Resume authority: `active_batch_run_id` + `needs_review` status

Today there is no per-row pairing between a run and an in-flight batch:
`rebuild_run_id` is written once at preflight, `{stage}_batch_id` is
written at submit, nothing joins them. A fresh `--run-id R2` invocation
cannot distinguish "R1's extract_batch_id is still running" from "R1's
extract_batch_id is stale from a dead R1."

Migration 011 adds two columns (see §1):

- **`active_batch_run_id TEXT`** — "this run owns this in-flight batch."
  Written in `submit_batch` alongside `{stage}_batch_id`. Cleared in
  `wait_and_drain` when the row transitions out of `batch_*_submitted`
  (on drain success, errored, or canceled). This is the authority for
  the ACTIVE predicate in §7.6.
- **`review_reason TEXT`** — discriminator for the new `needs_review`
  status (see below). Vocabulary: `'errored'`, `'canceled'`, `'expired'`,
  `'truncated'`, `'stuck_orphan'`, `'deploy_in_flight_collision'`,
  `'deadletter_post_drain'`.

**New terminal status: `needs_review`.** Rows land here when something
weird happened and human inspection is required before they can re-enter
the pipeline. Not surfaced to PT — `/api/batch/load` filter stays
`deploy_status IN ('idle','done','failed')` (unchanged); `batch_queue.status
= 'needs_review'` never has a deploy. Operator tools:

- `agent/analyze_failures.py` learns `--review-reason X` filter
- `rebuild_batch.py --recover-orphans` (see §2.0b) moves
  `status='needs_review' AND review_reason='stuck_orphan'` → `queued`
- No other automatic path out of `needs_review`. Every other
  `review_reason` requires code or data change before recovery.

**Submit-time writes (in `submit_batch`):**

```python
patch = {
    f"{stage}_batch_id": anth_batch.id,
    "active_batch_run_id": current_run_id,
    "batch_submitted_at": now_iso,
    "status": f"batch_{stage}_submitted",
}
# Idempotency guard: only write if currently unset for this row+stage
# (prevents cost-doubling if submit is retried mid-write)
supabase.update(patch, where=f"{stage}_batch_id.is.null")
```

**Drain-time writes (in `wait_and_drain`):**

```python
# On successful drain of a row:
patch = {
    f"{stage}_result": result_json,
    "active_batch_run_id": None,   # release ownership
    "status": next_stage_pool,
}
```

### §2.6 — `max_tokens` truncation detection (hole #3)

Three call sites today submit with `max_tokens=32000` and never inspect
`response.stop_reason`: `deploy_agent.py:1433`, `1638`, `1797`. Monster
menus emit >32K output tokens and get silently truncated mid-item.

`wait_and_drain` must inspect `result.message.stop_reason` for every
succeeded Anthropic request in a batch. If `stop_reason == 'max_tokens'`:

1. Do NOT parse the truncated JSON (high corruption risk).
2. Route the row to `status='needs_review'`,
   `review_reason='truncated'`.
3. Preserve the raw response in `extraction_result.raw_truncated_response`
   for operator inspection.

Under operator policy "no automatic resubmission," truncated rows stay
in `needs_review` until the operator manually handles them (e.g. by
bumping `max_tokens` in a code change and running `--recover-orphans`
equivalent for truncated — TBD, probably just `--reset` with explicit
status filter).

### §2.7 — `restaurant_type` normalization at assemble (hole #10)

`/api/batch/ingest` today validates `restaurant_type` against an 11-entry
allowlist. AI occasionally returns off-list strings like
`"fast_casual_mexican"`. Under operator policy "as long as it's a
restaurant, we want it":

1. `run_assemble` catches the 400 response body indicating
   `restaurant_type_invalid`, coerces the value to `"other"` locally, and
   retries the POST **once**. Not a re-AI-call — pure string normalization.
2. If the retry still fails (different 400 cause), row goes to
   `needs_review`, `review_reason='assemble_validation'`.
3. Hotels/gas-stations are not in scope for coercion — those should be
   filtered upstream in PT or at preflight `url_class`. `classify_url`
   already filters hotel aggregators via `_HOTEL_HOST_SUFFIXES`;
   gas-station filtering is a PT-side data concern, not PR3.

### §2.8 — Cache-mode selection per batch submission

Pre-submit decision per batch: should this submission attach
`cache_control: {type: "ephemeral", ttl: ...}` to the system prompt, or
not? The 2026-04-16 regression (memory `feedback_batch_caching_cost_regression.md`)
showed batch+cache cost MORE than per-row sync at small N or when TTL
expired mid-batch. Mathematically:

- WITH cache:  `0.5 × [W·T_sys + (N−1)·0.10·T_sys + N·T_row]`
- NO cache:    `0.5 × [N·T_sys + N·T_row]`

Where `W` is the cache-write multiplier: **1.25** for 5-min TTL, **2.0**
for 1h TTL. Break-even N: ≥2 for 5-min, ≥3 for 1h. Below threshold,
attaching `cache_control` is a pure premium with no recoupment.

```python
def select_cache_mode(stage: str, n_requests: int, t_sys: int,
                      est_drain_minutes: float) -> Literal["off","5min","1h"]:
    """Pre-submit cache-mode decision. Default policy:
       - <4096-token system prompt: cache_control silently ignored on Haiku
         (per project_prompt_caching_gap.md); always 'off'
       - N=1: 5-min cache costs 25% × T_sys premium with no read; 'off'
       - drain >4 min AND N<50: 5-min TTL likely expires mid-batch ('off')
       - drain >50 min: only worth 1h TTL, and only if N≥3
       - otherwise: '5min'
    """
    if t_sys < 4096:
        return "off"
    if n_requests == 1:
        return "off"
    if est_drain_minutes > 4 and n_requests < 50:
        return "off"
    if est_drain_minutes > 50:
        return "1h" if n_requests >= 3 else "off"
    return "5min"
```

`ESTIMATED_DRAIN_MINUTES` per stage starts as a constant table calibrated
from prior runs (memory `feedback_anthropic_batch_sla.md`: ~6 min for 2229
requests, but 1-2 request tiny batches can take 40+ min). After each batch
drains, record actual wallclock and update an in-process moving average for
subsequent stages in the same run.

**CLI override:** `--cache-mode {auto,off,force-5min,force-1h}` defaulting
to `auto`. First production run after PR3 lands SHOULD use `--cache-mode off`
to re-baseline cost data before trusting the auto-selector. See §4 PR3 validation.

**Empirical override during run:** every drained batch records
`cache_creation_input_tokens` + `cache_read_input_tokens` per stage. If
`cache_creation > cache_read` at the end of a stage's batches, log
WARNING and force `cache_mode='off'` for any subsequent stages in the
same run — the cache is not amortizing as projected.

**Per-row content drift guard (defensive):** the cacheable system block
must be assembled from constants only. Every per-row variable goes
AFTER the `cache_control` marker in the message structure. Add a unit
test: pass two distinct row dicts through `_build_{stage}_msg` and
assert the prefix bytes (up to the cache_control marker position) are
byte-identical. If they ever differ, every request creates its own
cache (the suspected 2026-04-16 root cause).

### §2.9 — Per-row batch process history (`batch_queue_events`)

Append-only event log per `batch_queue` row. Purpose: let the operator
(and future `analyze_failures.py --by-row`) answer "what actually
happened to this pt_record_id across runs?" without reconstructing
from `status`/`deploy_status` snapshots. Complements §2.5's terminal
status — status says *where the row is*, events say *how it got there*.

**Schema:** migration 012 (already defined in §1). Table
`demo_builder.batch_queue_events`, FK to `batch_queue.id` with
`ON DELETE CASCADE`. Rows are write-once — no UPDATE path.

**Event vocabulary (emitted by PR3 orchestrator):**

| event_type | When emitted | Key fields populated |
|---|---|---|
| `preflight_classified` | end of preflight per row | `stage='preflight'`, no batch_id |
| `submitted` | `submit_batch` returns 200 | `batch_id`, `input_tokens` (estimate) |
| `drained_success` | `wait_and_drain` parses a row's result | `input/output/cache_*_tokens`, `cost_usd` |
| `drained_errored` | result has `result.type='errored'` | `error_text`, `review_reason='errored'` |
| `drained_truncated` | result has `stop_reason='max_tokens'` | `review_reason='truncated'`, `output_tokens` |
| `drained_canceled` | batch returned canceled/expired for this row | `review_reason='canceled'` or `'expired'` |
| `rerouted` | extract→image_menu reroute fires (§7.18) | new stage in `error_text` for traceability |
| `assemble_attempted` | `POST /api/batch/ingest` sent | `http_status` |
| `assemble_succeeded` | 2xx response | — |
| `assemble_failed` | 4xx/5xx after retries | `http_status`, `error_text`, `review_reason='assemble_validation'` |
| `marked_orphan` | §2.0b `reclaim_stuck` routes to `needs_review` | `review_reason='stuck_orphan'` |
| `recovered` | `--recover-orphans` moves back to `queued` | — |

**Helper signature** (`agent/rebuild_batch.py`):

```python
def log_event(
    supabase,
    *,
    batch_queue_id: str,
    rebuild_run_id: str,
    stage: str,
    event_type: str,
    batch_id: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cache_creation_tokens: int | None = None,
    cache_read_tokens: int | None = None,
    cost_usd: Decimal | None = None,
    error_text: str | None = None,
    review_reason: str | None = None,
    http_status: int | None = None,
) -> None:
    """Single-row INSERT into batch_queue_events. Never raises — event
    write failure must not mask the underlying operation. On any
    exception, log WARNING and continue. Event loss is preferable to
    stage failure (operator still has status column as fallback)."""
```

**Call sites in PR3:**
- `submit_batch` → `submitted` (one per row in the batch, right after
  the Anthropic batch POST succeeds)
- `wait_and_drain` → one of `drained_{success,errored,truncated,canceled}`
  per row parsed from the batch result stream
- `_transition_between_stages` → `rerouted` when §7.18's image-menu
  detection triggers
- `run_assemble` (PR5 territory, but event-write lands in PR3) →
  `assemble_attempted` / `assemble_succeeded` / `assemble_failed`
- `reclaim_stuck` (§2.0b) → `marked_orphan`
- `--recover-orphans` CLI → `recovered`
- `preflight_row` (PR1 already shipped — add backfill in PR3) →
  `preflight_classified` on each verdict

**Cost accounting alignment:** `cost_usd` is computed from the token
fields using the model's published per-MTok rate × 0.5 (batch
discount) × cache multipliers. Summed per `rebuild_run_id`, this
reconciles with Anthropic's `/v1/messages/batches` billing within
rounding — exposes any drift (e.g., the 2026-04-16 cache regression
would have shown up as `cache_creation_tokens >> cache_read_tokens`
across an entire run, flagged by the post-flight report).

**Operator mental model:** `batch_queue` row is the state; events are
the history. When a row sits in `needs_review`, operator runs
`analyze_failures.py --by-row <id>` (deferred to PR6) to see every
event chronologically and decide: re-preflight, re-queue, or prune.
No automatic inference — policy is still "no auto-retry" per
`feedback_failures_never_auto_retry.md`.

### Dependency graph for Phase 3
```
group A: discover                              (must finish first)
   ↓
group B: extract + pdf + image_menu            (parallel submit, join)
   ↓
group C: modifier + branding                   (parallel submit, join)
```

### preflight_row: live menu-URL discovery

Per-row preflight must call `discover_menu_url` (mechanical-only — nav scoring
+ common-path probing + ld+json sniff) for every `url_class='html'` row.
Without this, `menu_url_candidate` stays null → every html row gets
`discover` added to `ai_needed` → cost projection is systematically 15-20%
high and PR3 submits an oversized discover batch. Plan PR2 must wire this
into `preflight_row` (same pattern as `_extract_branding_mechanical`: if
mechanical wins, skip the AI stage). Observed in PR1 validation: 1430
rows flagged for `discover` vs actual need around ~200.

**Tradeoff:** adds ~1 curl_cffi GET per html row that doesn't already have
`homepage_html` cached (PR1 showed 385 such rows). Acceptable — preflight
already has the budget.

### PreflightVerdict dataclass (per row, serialized to `preflight` JSONB)
```python
@dataclass
class PreflightVerdict:
    row_id: str
    url_class: Literal["html","pdf","social_dead","hotel_dead","direct_image","unreachable"]
    fetch_status: Literal["ok","cf_blocked","timeout","404","redirect_offdomain","error"]
    menu_url_candidate: Optional[str]
    ldjson_items: int
    branding_tokens: Optional[dict]
    image_menu_urls: list[str]
    content_gate_verdict: Literal["ok","sparse","nav_heavy","no_price","hard_fail"]
    ai_needed: list[Literal["discover","extract","modifier","branding","pdf","image_menu"]]
    error: Optional[str]
    classified_at: str
```

### Content gate relaxation (fixes 23% false-positive rate)
Current `_classify_extract_skip` at deploy_agent.py:427 hard-fails at `<500 chars`. Replace with:
- `hard_fail` ONLY if `<200 chars AND <30 tokens` (no AI call)
- `sparse` 200-500 chars → still goes to AI, just tagged
- `nav_heavy` / `no_price` → still goes to AI, tagged

### Per-request cost model (from 2026-04-16 actuals)
```python
COST_PER_REQ_USD = {
    "discover":   0.0020,
    "extract":    0.0031,
    "modifier":   0.0028,
    "branding":   0.0015,
    "pdf":        0.0250,
    "image_menu": 0.0220,
}
```

**These are population means, not per-row upper bounds.** Output tokens
dominate cost (64% Haiku / 83% Sonnet, per
`memory/feedback_output_tokens_dominate_batch_cost.md`) and output length is
a long-tailed distribution — a 300-item monster menu emits 20-25× the output
of a 10-item quick-serve menu. Projections on outlier-heavy workloads can
miss by 40%+.

**Guardrail:** `project_cost()` reports both the mean-based estimate AND a
P95-conservative estimate using a 1.5× multiplier on `extract`/`modifier`/
`pdf`/`image_menu` lines. Budget enforcement (§6) uses the P95 number, not
the mean. If real spend on a live run exceeds P95 by >10%, regenerate the
cost model from fresh batch usage data before the next rebuild.

### Code reuse inventory (lift-and-shift from deploy_agent.py → pipeline_shared.py)
| Function | Line | Disposition |
|---|---|---|
| `_fetch_homepage_html` | 887 | Lift |
| `_extract_ldjson_menu_text` | 285 | Lift |
| `fetch_page_text_curl_cffi` | 319 | Lift |
| `fetch_page_text_playwright` | 589 | Lift |
| `discover_menu_url` | 654 | Lift |
| `extract_ldjson_full_menu` | 790 | Lift |
| `_ldjson_items_to_rows` | 907 | Lift |
| `_extract_branding_mechanical` | 1240 | Lift |
| `_extract_menu_index_links` | 460 | Lift |
| `_detect_menu_images` | 529 | Lift |
| `_classify_dead_url` | 975 | **Expand** → `classify_url` adds hotel_dead/pdf/direct_image |
| `_classify_extract_skip` | 427 | **Rewrite** → relaxed thresholds (above) |
| `_build_{discover,extract,modifier,branding}_msg` | 1907-1987 | Lift |
| `_submit_pdf_wave` PDF builder | 1397 | **Extract inline** → `build_pdf_content` |
| `_submit_image_menu_wave` image builder | 1588 | **Extract inline** → `build_image_menu_content` |
| `advance_stage_assemble` | 1299 | **Lift body**, wrap in ThreadPoolExecutor |
| `_submit_wave` / `_poll_waves` | 1752/1832 | **Rewrite** → `submit_batch` / `wait_and_drain` |

### Deleted (wave-specific, gone in new arch)
- `_wave_is_ready` (945)
- `WAVE_MIN_SIZE`, `WAVE_MAX_SIZE`, `FORCE_WAVE_AFTER_SECONDS`
- All `advance_stage_*` per-row state-transition functions
- `process_generate_queue` (2175) — legacy sync path, the "hidden spend" source
  (verified 2026-04-16: grepped for callers, only referenced inside deploy_agent.py itself)

### PR2 must also update three agent-tree callers
- `agent/dryrun_staged.py` — imports `deploy_agent as da`, references `WAVE_*` constants
- `agent/check_cache.py` — imports `deploy_agent as da`, references `WAVE_MAX_SIZE`
- `agent/test_extract.py` — imports functions from `deploy_agent`

All three must switch to `from pipeline_shared import ...` when PR2 lands, or
be deleted if obsolete. Plan §3 originally only mentioned `deploy_agent.py`
reduction; this is the complete list of files that break if we only touch
the one file.

### Prompt-file load must hard-assert on startup
`_load_stage_prompts()` regex-parses `lib/extraction/prompts.ts`. If the TS
file moves, is renamed, or switches from template-literal to string-concat
syntax, the regex silently yields `{}` and PR3 submits empty system prompts
(batch-wide garbage output, thousands of dollars of bad tokens). PR2's
`pipeline_shared.load_stage_prompts()` must:
1. Assert all 4 expected prompt names loaded (`DISCOVERY_SYSTEM_PROMPT`,
   `MENU_EXTRACTION_SYSTEM_PROMPT`, `MODIFIER_INFERENCE_SYSTEM_PROMPT`,
   `BRANDING_TOKENS_SYSTEM_PROMPT`).
2. Assert each is >500 chars.
3. Fail fast (`SystemExit(3)`) if either assertion fails. Do not run with
   degraded prompts.

---

## 3. `deploy_agent.py` Reduction — 2759 → ~750 lines

**Delete (line ranges):**
| Range | What |
|---|---|
| 81–93 | Wave config constants |
| 104–139 | Anthropic client setup (deploy doesn't call Anthropic) |
| 285–574 | Fetchers, gates, regexes → pipeline_shared |
| 577–647 | Playwright → pipeline_shared |
| 654–943 | Discover, ld+json, utils → pipeline_shared |
| 945–987 | wave_is_ready + dead-url classifier → pipeline_shared |
| 991–1356 | All `advance_stage_*` |
| 1364–1747 | PDF + image-menu wave plumbing |
| 1752–1903 | `_submit_wave` / `_poll_waves` |
| 1907–1987 | Stage builders/parsers → pipeline_shared |
| 1992–2135 | `_poll_discover_waves`, `run_staged_pipeline`, `_handle_process_result` |
| **2175–2337** | **`process_generate_queue` — legacy sync path (critical to delete)** |
| 2727–2736 | `use_staged` dual-pipeline branch in main() |

**Keep (deploy-only):**
- Lines 1–80 (imports, config, load_env)
- Lines 145–188 (ssh_cmd, supabase_get/patch)
- Lines 189–283 (save_snapshot)
- Lines 2339–2614 (execute_sql, push_images_scp, POS lifecycle)
- Lines 2616–2704 (process_queued)
- Lines 2706–2759 (main — simplified to poll_queued() only)

**Final structure:**
```
deploy_agent.py  (~750 lines, deploy-only)
├── Config + load_env
├── SSH helpers
├── Supabase REST helpers
├── Snapshot helpers
├── MariaDB execute_sql
├── SCP push_images_scp
├── POS lifecycle (pos_is_running, restart_pos, etc.)
├── process_queued (deploy loop body)
└── main (poll loop, calls only process_queued)
```

---

## 4. PR Sequence (each atomic, production stays usable between)

### PR 1 — Schema + preflight skeleton (dry-run only) — SHIPPED 2026-04-16
- Migration `010_preflight_column.sql`
- `rebuild_batch.py` with only: dataclasses, `classify_url`, `_classify_content_gate`, `preflight_row`, `run_preflight`, `project_cost`, `print_preflight_summary`, `main --dry-run`
- Non-dry-run invocations hard-error
- **Add unit tests:** `agent/tests/test_classify_url.py` + `agent/tests/test_content_gate.py`. Pure functions with obvious edge cases; ~40 lines of pytest total. Catches regressions in PR2's shared-module extraction.
- **Validate:** preflight populates all 1598 rows; counts match retroactive analysis within ±3% on url_class buckets (`html`/`pdf`/`direct_image` passed; `social_dead`/`hotel_dead` were loose retroactive estimates, not classifier bugs).

### PR 2 — Extract shared module
- Create `agent/pipeline_shared.py` with all lift-and-shift functions
- Replace `deploy_agent.py` usages with `from pipeline_shared import ...`
- `rebuild_batch.py` switches imports too
- **Also update:** `agent/dryrun_staged.py`, `agent/check_cache.py`, `agent/test_extract.py` (all three import from `deploy_agent` today — see §3 "PR2 must also update three agent-tree callers")
- **Wire live discover into preflight_row** (see §2 "preflight_row: live menu-URL discovery"). Without this, PR3's discover batch is ~6× larger than needed.
- **Add prompt-load assertions** (see §3 "Prompt-file load must hard-assert on startup").
- **Validate:** deploy_agent.py smoke test still works; existing dryrun_staged.py still works; rebuild_batch.py `--dry-run` rerun shows `discover` request count drops from ~1430 to ~200-400.

### PR 3 — AI batch submission + drain-only resume

**Schema** (migrations `011_batch_resume_semantics.sql` + `012_batch_queue_events.sql` per §1):
- 011: Add `active_batch_run_id TEXT` column + index; add `review_reason TEXT` column + partial index on `needs_review`
- 012: Create `batch_queue_events` append-only history table (§2.9) with indexes on `(batch_queue_id, ts DESC)`, `(rebuild_run_id)`, `(stage, event_type, ts DESC)`

**Core functions:**
- `build_stage_batch`, `submit_batch`, `wait_and_drain`, `run_stage_group`, `_transition_between_stages`, `run_assemble`, `print_report`
- `log_event(supabase, *, batch_queue_id, rebuild_run_id, stage, event_type, **kwargs)` helper per §2.9 — single-row INSERT into `batch_queue_events`, never raises
- `submit_batch` writes `active_batch_run_id` atomically with `{stage}_batch_id` per §2.5; tags Anthropic batch with `metadata={rebuild_run_id}` for §7.16; emits `submitted` event per row
- `wait_and_drain` inspects `stop_reason=='max_tokens'` per §2.6; clears `active_batch_run_id` on drain; emits one of `drained_{success,errored,truncated,canceled}` per row with full token+cost accounting
- `_transition_between_stages` handles image-menu reroute per §7.18; emits `rerouted` event
- `run_assemble` emits `assemble_attempted` / `assemble_succeeded` / `assemble_failed`
- `reclaim_stuck` (§2.0b) emits `marked_orphan`; `--recover-orphans` emits `recovered`
- `preflight_row` backfill: emit `preflight_classified` for rows preflighted in PR3's reset path (PR1 ran pre-events; PR3 re-preflights on reset and writes the event going forward)

**Flags:** `--force-budget`, `--skip-assemble`, `--include-done`, `--replace-session`, `--recover-orphans`, `--cache-mode {auto,off,force-5min,force-1h}`. `--run-id` and `--reset` mutually exclusive (see §7.6).

**Orchestration:**
- `§2.0` reset + `§2.0b` orphan handling runs every invocation (own-run exclusion per hole #4 fix)
- Per-stage resume partitioning (FRESH/ACTIVE/DRAINED buckets per §7.6); drain-only, no auto-resubmit
- Per-batch `select_cache_mode()` decision per §2.8 + runtime empirical override
- `ASSEMBLE_WORKERS=4` default + 429 retry-with-jitter per §7.17
- Advisory lock via `pg_try_advisory_lock` + atexit/signal release per §7.12
- Unit test: prompt-prefix byte-identity across rows (§2.8 per-row drift guard)

**Route changes:**
- `/api/batch/ingest` upsert by `pt_record_id` (§2.4 Option A)
- `/api/batch/ingest` returns 409 if target session `deploy_status IN ('queued','executing')` (§2.4 mid-deploy guard); `run_assemble` catches 409 → row becomes `needs_review`, reason `deploy_in_flight_collision`
- `/api/batch/ingest` accepts off-list `restaurant_type` and coerces to `"other"` per §2.7 (or `run_assemble` retries once with coerced value if the route stays strict)

**Validate:**
- Full run on a Supabase branch (scratch copy of batch_queue)
- End-to-end assemble on 30 rows
- Idempotent re-run on `done` row creates no duplicate session (§2.4)
- Resume mid-run: kill rebuild_batch while ACTIVE; relaunch with same `--run-id`; verify it drains the in-flight batch instead of resubmitting (§7.6)
- Own-run exclusion: resume at t=31m does NOT reclaim its own ACTIVE batches (hole #4)
- Mid-deploy guard: mark a session `deploy_status=executing`, trigger ingest for that `pt_record_id` → expect 409 + row marked `needs_review` with correct reason
- `max_tokens` truncation: inject a stubbed Anthropic response with `stop_reason='max_tokens'` → row routes to `needs_review` with reason `truncated`
- `restaurant_type` coercion: submit off-list string → ingest accepts as `"other"` (or retries once from assemble side)
- Post-flight variance: verify `print_report` prints PROJECTED vs ACTUAL and warns on >10% drift (§7.16)
- Cache stats table prints per stage with cache_create/cache_read ratios (§7.16 cache section)
- **Event log coverage:** after the 30-row end-to-end run, every row has ≥2 events (`submitted` + one of the `drained_*`); successful rows have `assemble_succeeded`; `needs_review` rows have the terminal event matching their `review_reason`. SQL check: `SELECT COUNT(*) FROM batch_queue WHERE rebuild_run_id=:r AND NOT EXISTS (SELECT 1 FROM batch_queue_events WHERE batch_queue_id=batch_queue.id)` must be 0.
- **Event-write failure isolation:** inject a forced error in `log_event` → stage still completes successfully (event loss is non-fatal per §2.9).
- **First production run discipline:** ship with `--cache-mode off` for the first full run after PR3 lands. Capture per-stage cost actuals as the new baseline. Second run uses `--cache-mode auto` and `print_report` quantifies cache savings vs the off baseline (cf. memory `feedback_batch_caching_cost_regression.md` "do not re-enable without measured A/B").

### PR 4 — Delete legacy from deploy_agent.py
- Delete all ranges above
- Update `.env` docstring, CLAUDE.md, HANDOFF.md
- **Validate:** process_queued still works on a manually-inserted dummy session

### PR 5 — Re-enable deploy daemon
- Rename `com.valuesystems.demo-builder-agent.plist.suspended` back to `.plist`
- `launchctl load`
- Confirm heartbeat on connections.agent_last_seen
- **Validate:** deploy agent alive 10 min, test deploy lands on tablet

### PR 6 (optional) — Observability + per-row analysis
- Next.js admin page `/admin/rebuild-runs` grouping by `rebuild_run_id`; joins `batch_queue_events` for per-row history drill-down
- `agent/analyze_failures.py --by-row <batch_queue_id>`: prints full chronological event list for one row (all runs) with tokens + cost per event; decision aid for "re-preflight vs re-queue vs prune" per §2.9 operator mental model
- `agent/analyze_failures.py --history <rebuild_run_id>`: per-run summary — row-count by terminal event + total cost reconciled against Anthropic's `/v1/messages/batches` billing
- `agent/analyze_failures.py --stuck-in-review`: groups `status='needs_review'` rows by `review_reason`, shows first+last event per row; helps operator batch-decide recovery actions

---

## 5. Dry-run Validation Plan

After PR1, run `python3 agent/rebuild_batch.py --dry-run --status-filter done,failed,queued` and verify:

| Bucket | Expected count | SQL check |
|---|---|---|
| `url_class='social_dead'` | ~91 | `SELECT COUNT(*)... GROUP BY preflight->>'url_class'` |
| `url_class='hotel_dead'` | ~28 | same |
| `url_class='pdf'` | ~38 | same |
| `url_class='direct_image'` | ~6 | same |
| `url_class='html'` | ~1435 | same |
| Fully mechanical (`ai_needed=[]`) | ~287 | `WHERE preflight->'ai_needed' = '[]'::jsonb` |
| AI-needed | ~1186 | complement |
| Projected cost | ~$8 | `project_cost` output |

±3% tolerance. >5% delta in any bucket = `classify_url` bug; fix before PR3.

**False-positive spot check on content gate:** pull 20 rows with `content_gate_verdict='hard_fail'` and open menu_url in a browser. If any have visible menus → tighten threshold or downgrade 'hard_fail' to 'sparse' before live run.

---

## 6. Budget Enforcement

**Point of enforcement:** `rebuild_batch.py:main`, immediately after `run_preflight()`:

```python
ai_counts = _count_ai_needs(run_id)
projected_mean, projected_p95 = project_cost(ai_counts)
enforce_budget(projected_p95, cap, force)   # use P95, not mean — see §2 cost model
# sys.exit(2) if projected_p95 > cap AND not --force-budget
```

**Timing:** the user sees the budget gate only after `run_preflight()` finishes.
For a 1598-row sweep with `--fetch` and live discover that's 5-15 min. If they
want to abort before fetching, `rebuild_batch.py --project-only` runs just
`classify_url` + cached-column checks (no network, completes in <60s) and
prints the same projection. Pre-flight + pre-submit = two hold points.

**Cap source (priority):**
1. `--force-budget FLOAT` CLI flag
2. `BATCH_BUDGET_USD` env var (reused from deploy_agent.py:90, finally wired)
3. Hardcoded default `15.0`

**Abort behavior:**
- Exit code 2 (distinct from generic error exit 1)
- Preflight data preserved — re-run resumes without re-classifying
- No rows transitioned to pool_* yet → no orphan state

---

## 7. Open Questions / Risks

1. **PREFLIGHT_WORKERS=24 concurrency** — verify fetches don't pile up on dev run; reduce to 16 or extend timeout if needed.
2. **Playwright in preflight?** Option A: cap <8 parallel. Option B: stash `needs_playwright_retry=true` and re-try serially at end of Phase 1. **Recommend Option B** — simpler threading model.
3. **Content gate thresholds** — verify relaxed gate doesn't blow past budget. If sparse-bucket AI spend dominates, reconsider whether 'sparse' should still go to AI.
4. **Unknown URL patterns** — rows that fall through to `url_class='html'` then fail in preflight get `url_class='unreachable'`. Proposal: new verdict `content_gate_verdict='unknown'` + status `preflight_review` so humans can see them. Defer unless >1% land here.
5. **Anthropic batch size cap** — 10K req / 256 MB. 1186 extract rows × 20K tokens ≈ 190 MB. Add `MAX_REQS_PER_BATCH=5000` safety; split if needed.
6. **Resume semantics — `--run-id R` (drain-only).** Operator policy: NO automatic resubmission. Invocations of `rebuild_batch.py --run-id R`:
   - If `R` is new (no rows match) → fresh run, business as usual.
   - If `R` matches existing rows → **drain-only resume mode.** No resubmit flags exist.
   - Preflight skips rows where `rebuild_run_id=R AND preflight_run_at > now()-7d`.
   - `--run-id` and `--reset` are **mutually exclusive** (reject with usage error at startup).

   **Per-stage S partitioning** (authority is `{stage}_batch_id` + `active_batch_run_id`, not `status`):

   | Bucket | Condition | Action |
   |---|---|---|
   | GONE | `rebuild_run_id != R` | Don't touch. |
   | DRAINED | `{stage}_result IS NOT NULL` | Skip. |
   | FRESH | `rebuild_run_id = R AND {stage}_batch_id IS NULL AND preflight.ai_needed ⊃ {S}` | First-time submit (not a resubmit). |
   | ACTIVE | `rebuild_run_id = R AND {stage}_batch_id IS NOT NULL AND active_batch_run_id = R` | Poll Anthropic, drain per below. |

   **ACTIVE batch disposition** (group rows by distinct `{stage}_batch_id`, one Anthropic call per batch):

   | Anthropic `processing_status` | Action | Row result |
   |---|---|---|
   | `in_progress`, `canceling` | wait + retry | stay ACTIVE |
   | `ended`, all `request_counts.succeeded` | drain JSON results | per §2.5 drain-time writes |
   | `ended`, mixed `errored`/`canceled`/`expired` | drain whatever succeeded | for the rest → `needs_review`, `review_reason` in `{'errored','canceled','expired'}` |
   | `ended`, all errored/canceled/expired | skip drain | all rows → `needs_review` |

   **Drain must also inspect `stop_reason=='max_tokens'`** per §2.6 — those rows go to `needs_review` with `review_reason='truncated'` regardless of batch-level status.

   **Edge case — `--run-id R_new` with an existing-but-expired Anthropic batch owned by a past run:** the row has `{stage}_batch_id` set but `active_batch_run_id != R_new`. §2.0b reclaim routes it to `needs_review` with `review_reason='stuck_orphan'`. Operator recovers via `--recover-orphans`.
7. **Hot-path `/api/batch/process`** — preserve the route file (only `process_generate_queue` calls it, being deleted). Mark with comment "HOT-PATH ONLY — sync extraction for single PT lead". Re-evaluate in follow-up.
8. **Reset semantics + MEMORY.md "don't break PT mid-route"** — default `--reset` scope is `status in ('failed','queued','pool_*')`, never `done`. Add `--include-done` flag (dangerous, explicit opt-in only).
9. **Legacy BATCH_BUDGET_USD env** — if any runbook sets this to 5.0, new pipeline now treats it as hard cap. Audit before cutover.
10. **Assemble-stage parallelism + Vercel Blob** — 8 parallel × ~12 images/row could saturate Blob. Drop to 4 if 429s appear.
11. **Supabase PATCH bulk limit** — 1598 single-row PATCHes work but slow. Optional optimization: bulk upsert in 50-row chunks.
12. **Concurrency lock between rebuild_batch runs (hole #9).** Two parallel invocations must not fight over the same rows. PR3 uses `pg_try_advisory_lock(hashtext('rebuild_batch'))` at startup.

    - **Connection-string requirement (footgun).** Supabase exposes two pooled URLs: port `6543` is the transaction-mode pooler (PgBouncer), port `5432` is the session/direct pool. **Session-level advisory locks are RELEASED at end-of-transaction in pgbouncer transaction mode** — the lock would silently no-op against the 6543 URL. PR3 must:
      1. Pin the lock connection to Supabase's port `5432` URL via a dedicated env var (e.g. `SUPABASE_DIRECT_URL`, separate from any pooled URL the app uses).
      2. Hold that connection open for the lifetime of the rebuild process — do NOT close + reconnect between stages, or the lock dies.
      3. On startup, sanity-check by issuing `SHOW server_version;` and `SELECT pg_advisory_lock_held(hashtext('rebuild_batch'));` after acquisition; the second must return true. If false → bail with "DATABASE_URL appears to be transaction-pooled; use SUPABASE_DIRECT_URL." (Cite: `lock-advisory.md` + `conn-pooling.md` from `.agents/skills/supabase-postgres-best-practices/references/`.)

    - **Lock acquisition.** If `pg_try_advisory_lock` returns false → exit immediately with `ERROR: another rebuild_batch process holds the lock`. No block/wait (we'd rather fail fast than hang behind a zombie holder).

    - **Release via three paths, all required** because the holding session may stay open after SIGKILL:
      1. `atexit.register(release_lock)` for clean exits
      2. `signal.signal(SIGTERM, ...)` and `SIGINT` handlers that call `release_lock` + re-raise
      3. On startup, if lock acquisition fails, probe `pg_stat_activity` for the holding PID + query start time; if the holder is >30m idle, log the PID and exit 3 with instructions for operator to run `SELECT pg_terminate_backend(<pid>)` in Supabase SQL editor. Never auto-kill.

    - Lock also covers `/api/batch/ingest` when called from rebuild_batch. Steady-state PT lead conversion that calls ingest directly does NOT take the lock (single-row path; idempotent via §2.4 dedup + §2.4 deploy-status guard).
13. **Playwright scope in preflight** — `_detect_menu_images` uses Playwright. Do NOT run it for every html row in preflight — that's 1400+ browser contexts. Only run when the content gate returns `sparse` or `nav_heavy` AND the page has no ld+json items — i.e. the cases where image-menu dispatch is plausible. Estimated ~100-200 pages, serial, <5 min total.
14. **Unit tests** — `agent/tests/test_classify_url.py` + `test_content_gate.py` added in PR1. PR2 must add `test_discover_menu_url.py` covering the live mechanical discovery edge cases (same-host redirects, common-path probes, platform host recognition). Pure-function coverage; no network, no Anthropic.
15. **Single-host fetch politeness** — 24 workers fetching from different hosts is fine, but during the bulk rebuild some PT leads share hosts (chain restaurants, aggregator portals). `run_preflight` should rate-limit per-host to ≤4 concurrent fetches to avoid tripping per-site bot detection that wouldn't fire in steady-state. Minor; only matters if fetch failures cluster by host.

16. **Post-flight cost variance check in `print_report` (hole #8).** `project_cost` projects pre-submit; `print_report` must close the loop by pulling actuals. After `run_stage_group` finishes each group, record `rebuild_run_id` timestamps. At end:
    ```python
    actual = anthropic.messages.batches.list(after=run_start, limit=100)
    actual_usd = sum(batch.cost for batch in actual
                     if batch.metadata.get("rebuild_run_id") == current_run_id)
    print(f"PROJECTED P95: ${projected_p95:.2f}  ACTUAL: ${actual_usd:.2f}  "
          f"DELTA: {100*(actual_usd/projected_p95 - 1):+.1f}%")
    if abs(actual_usd / projected_p95 - 1) > 0.10:
        print("WARNING: cost model drift >10% — regenerate COST_PER_REQ_USD "
              "from this run before next rebuild.")
    ```
    Requires `submit_batch` to tag every Anthropic batch with
    `metadata={"rebuild_run_id": run_id}`. See
    `memory/feedback_batch_cost_estimate_10x_miss.md` — this is the feedback
    loop we didn't have on 2026-04-15.

    **Per-stage cache stats table (paired with §2.8 cache-mode decision).**
    `print_report` must additionally surface, per stage:
    ```
    stage      cache_mode  N_reqs  cache_create_tok  cache_read_tok  ratio  verdict
    discover   5min          187          512_300       1_872_400     3.66  ✓ amortized
    extract    off           412                0               0      —    n/a
    modifier   5min            8           48_200          12_400     0.26  ✗ caching LOST money — disable
    ```
    `verdict` is computed as `cache_read / cache_create`:
    - `≥3.0` → ✓ amortized as expected
    - `1.0–3.0` → ⚠ marginal (cached but barely worth it)
    - `<1.0` → ✗ caching LOST money — `select_cache_mode` returned a bad
      decision; flag for investigation. The runtime override in §2.8
      already disabled it for subsequent stages, but the report makes
      the loss visible so the threshold can be re-tuned.
    Stats sourced from `result.message.usage.cache_creation_input_tokens` +
    `cache_read_input_tokens` summed across all drained requests in the stage.

17. **`run_assemble` POST concurrency against Vercel (hole #6).** Vercel Pro has ~100 concurrent function invocations cap; 800+ parallel POSTs to `/api/batch/ingest` will 429. Ship PR3 with `ASSEMBLE_WORKERS=4` (override via env) and `requests.Session` + retry-with-jitter on 429. Do not rely on §7.10's reactive "drop to 4 if 429s appear" — 429s under bulk assemble are not noise, they're the expected state at higher parallelism.

18. **Image-menu reroute at stage dispatch (hole #7).** Preflight `url_class` is pre-fetch; when an `extract` batch result comes back with sparse content AND `_detect_menu_images` (§7.13 limited Playwright scope) finds image menus, today's wave pipeline auto-reroutes at `deploy_agent.py:1146` from extract → image_menu. PR3 must inherit this behavior inside `_transition_between_stages`:
    ```python
    # After drain of an extract batch result:
    if result.menu_items_count < 3 and row.preflight.image_menu_urls:
        # Reroute to image_menu stage — don't mark failed
        supabase.update({"status": "pool_image_menu",
                         "active_batch_run_id": None})
    ```
    Because this is a reroute (not a resubmit of the same stage), it does
    not violate "no automatic resubmission" — the row is entering a
    different stage for the first time. Rows where both extract AND
    image_menu produce <3 items → `needs_review`,
    `review_reason='deadletter_post_drain'`.

---

## 8. Effort Estimate

| PR | Work | Days |
|---|---|---|
| 1 | Schema + preflight skeleton + dry-run + unit tests | 1.0 ✅ SHIPPED |
| 2 | Extract shared module + wire live discover + update 3 callers + prompt assertions | 0.6 |
| 3 | AI batch submission + reset/cleanup + ingest-dedup + advisory lock + P95 budget gate + event log (§2.9) | 1.1 |
| 4 | Delete legacy | 0.3 |
| 5 | Re-enable deploy daemon | 0.2 |
| 6 | Observability + `analyze_failures.py --by-row/--history/--stuck-in-review` | 0.7 |
| **Total** | | **~3.5-4 days** |

---

## 9. Revision log

| Date | Change |
|---|---|
| 2026-04-16 AM | Initial plan covering PR1–6 |
| 2026-04-16 PM | PR3 review — 10 holes patched: migration 011 (`active_batch_run_id`, `review_reason`), §2.0b own-run exclusion, §2.4 mid-deploy 409 guard, §2.5 resume authority, §2.6 `max_tokens` detection, §2.7 `restaurant_type` coercion, §7.6 drain-only resume + predicate matrix, §7.12 pgbouncer port 5432 requirement, §7.16 post-flight variance + cache stats, §7.17 `ASSEMBLE_WORKERS=4`, §7.18 image-menu reroute |
| 2026-04-16 PM | §2.8 cache-mode selector + `--cache-mode` CLI + runtime empirical override + per-row drift guard unit test |
| 2026-04-16 PM | §2.9 + migration 012 (`batch_queue_events`) — per-row append-only history for operator "what happened to this pt_record_id" analysis; event writes in PR3, analysis CLI deferred to PR6 |
