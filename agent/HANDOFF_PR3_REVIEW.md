# Handoff — PR3 Review (2026-04-16)

**Resume instruction on new terminal:** read this file, then `agent/REFACTOR_PLAN.md`, then ask user whether to patch the 10 PR3 holes below into the plan.

## State

- **PR1 SHIPPED** (commit on branch `fix/batch-load-dual-resolve-pt-id`): migration `010_preflight_column.sql` applied to Supabase DEV, `agent/rebuild_batch.py` skeleton in place (dry-run only), unit tests added.
- **PR2-6 remaining.** See `agent/REFACTOR_PLAN.md` §4 for sequence.
- Deploy daemon is `.suspended` (plist renamed); see memory `feedback_batch_caching_cost_regression.md`.
- Previous turn completed: holistic pipeline review → narrowed to PR3-specific review.

## PR3 scope (from REFACTOR_PLAN.md §4)

- Add `build_stage_batch`, `submit_batch`, `wait_and_drain`, `run_stage_group`, `_transition_between_stages`, `run_assemble`, `print_report`
- Add `--force-budget`, `--skip-assemble`, `--include-done`, `--replace-session` flags
- Wire §2.0 reset + §2.0b in-flight cleanup
- Update `/api/batch/ingest` to upsert `sessions` by `pt_record_id` (§2.4 Option A)
- Advisory lock on `pg_advisory_lock(hashtext('rebuild_batch'))`

## 10 PR3 holes identified (not yet patched into plan)

### Critical — architecturally load-bearing (change state-transition matrix)

1. **`sessions.deploy_status` collision in §2.4 upsert.** Upsert by `pt_record_id` doesn't guard against overwriting a row mid-deploy. Tablet gets half-new/half-old SQL when `deploy_status IN ('queued','executing')`. Fix: ingest returns 409 if not in `('idle','done','failed')`; `run_assemble` skips+logs (not fails).

2. **`--run-id <existing>` resume semantics undefined.** §7.6 claims resume re-polls; but `build_stage_batch` doesn't specify how it distinguishes "already submitted under this run_id" (re-poll) vs "fresh" vs "submitted under abandoned run_id" (resubmit). Needs explicit status+run_id predicate matrix; otherwise resume double-submits and doubles cost.

3. **Silent truncation at `max_tokens=32000` in `wait_and_drain`.** 3 call sites (`deploy_agent.py:1433, 1638, 1797`), no `stop_reason=='max_tokens'` checks. PR3 drainer is the enforcement point — mark rows `extraction_result.truncated=true` and route to manual-review bucket.

4. **§2.0b cleanup wipes in-flight rows of the current run.** `reclaim_stuck` runs every invocation, filters by `status + updated_at < now-30m`. A resume at t=31m reclaims its OWN in-flight batch. Fix: `WHERE rebuild_run_id IS DISTINCT FROM :current_run_id`.

### Medium

5. **Partial-batch `.errored` disposition unspecified.** Anthropic typically returns 30-50 errored per 1k. Plan doesn't pick retry-once-then-dead-letter vs fail-whole-stage vs drop-and-continue.

6. **`run_assemble` POST concurrency against Vercel.** 800+ parallel POSTs to `/api/batch/ingest` against Vercel Pro ~100 concurrent function cap will throttle. Ship with `ASSEMBLE_WORKERS=4` default + 429 retry-with-jitter, not §7.10's reactive "drop to 4 if needed".

7. **Image-menu vs extract re-routing at stage dispatch.** Preflight `url_class` is pre-fetch; `_detect_menu_images` is in §7.13's limited Playwright scope. What happens when an `extract` batch result comes back sparse+images-visible — does `_transition_between_stages` re-dispatch to `pool_image_menu`, or mark failed? Today's wave pipeline auto-reroutes at `deploy_agent.py:1146`; PR3 must inherit.

8. **No post-flight actual-vs-projection check in `print_report`.** §6 enforces projected P95 pre-submit; `print_report` doesn't pull `/v1/messages/batches?after=rebuild_start` and compare. Without feedback loop, cost model stays stale — cf. `memory/feedback_batch_cost_estimate_10x_miss.md`.

9. **Advisory lock release on hard crash.** `pg_advisory_lock` releases on connection close but Supabase pooler may hold lock minutes. Use `pg_try_advisory_lock` + explicit `pg_advisory_unlock` in `atexit` + signal handlers.

10. **`restaurant_type` validation failure unrecoverable at assemble.** `ingest/route.ts` validates 11 types; extraction AI returns arbitrary strings. `run_assemble` must catch 400, coerce to `"other"`, retry once.

## Triage from last message

- Items #1, #2, #4 change state-transition matrix → patch into plan before writing PR3 code
- Items #3, #7, #8 bolt-on fixes → add to plan but don't block architecture
- Items #5, #6, #9, #10 narrow implementation details → add as §7 open questions

## Open question for user

Last message asked: "patch these into plan, or dig deeper on #2 (resume semantics) first?" — **awaiting answer.**

## Key file pointers

- `agent/REFACTOR_PLAN.md` — the plan being refined. §2.4 (dedup), §6 (budget), §7.6 (resume), §7.12 (lock), §7.13 (Playwright scope) all relevant.
- `agent/rebuild_batch.py` — PR1 skeleton; PR3 will add `submit_batch`/`wait_and_drain`/`run_assemble`.
- `agent/deploy_agent.py:1146` — image-menu auto-reroute logic PR3 must inherit.
- `agent/deploy_agent.py:1433,1638,1797` — three `max_tokens=32000` sites with no truncation check.
- `app/api/batch/ingest/route.ts` — needs upsert-by-pt_record_id + deploy_status guard (PR3 change).
- `app/api/batch/load/route.ts:73` — filters `deploy_status in ('idle','done','failed')`; relevant to hole #1.
- `agent/ROLLBACK.md` — current agent suspension state.

## Context from earlier in session (pre-PR3 focus)

Full holistic pipeline review also identified these non-PR3 holes (for reference, not PR3 scope):
- Steady-state PT lead hot-path after daemon deletion (PR4/5 concern)
- Dead-URL gate duplicated between `classify_url` and `_classify_dead_url` (PR2 concern)
- `/api/batch/process` orphaned after `process_generate_queue` deletion (PR4)
- Anthropic cache 1h TTL across stage groups (observability concern, not PR3)
- `buildDesignConfig` is AI-free — verified, document in plan (doc-only)
