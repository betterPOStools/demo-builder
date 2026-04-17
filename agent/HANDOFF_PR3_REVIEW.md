# Handoff — PR3 Ready to Implement (2026-04-17 AM)

**Resume instruction on new terminal:** read this file, then `agent/REFACTOR_PLAN.md`. Plan is fully patched — next step is PR3 code implementation, no more planning ambiguities.

## State

- **PR1 SHIPPED** (commit `9b44020` + migration `010_preflight_column.sql` applied): `agent/rebuild_batch.py` skeleton (dry-run only), unit tests added.
- **PR2 SHIPPED** (commit `ea80040`): `pipeline_shared.py` extracted per `SEPARATION_AUDIT.md`.
- **PR3 READY** — plan is complete, all known holes patched. Ship order: migration 012 + 013 → then code.
- **Deploy daemon is `.suspended`** (plist renamed) — do not re-enable until PR5. See `ROLLBACK.md`.
- **Agent went rogue overnight 2026-04-16→17** — daemon's batch-submission side burned Anthropic budget. Root cause: `deploy_agent.py` does two jobs (deploy + batch submit) with no `DEPLOY_ONLY` gate. PR3 splits batch into `rebuild_batch.py` CLI; PR4 deletes batch code from the daemon; PR5 re-enables daemon as deploy-only.

## All 10 original PR3 review holes — PATCHED into REFACTOR_PLAN.md

From the 2026-04-16 PM review, all 10 now have plan sections:

| # | Hole | Patched in |
|---|---|---|
| 1 | `sessions.deploy_status` collision in upsert | §2.4 (409 guard) |
| 2 | `--run-id R` resume semantics undefined | §2.5 + §7.6 bucket matrix |
| 3 | Silent `max_tokens=32000` truncation | §2.6 + §2.10 recovery |
| 4 | §2.0b cleanup wipes own in-flight rows | §2.0b own-run exclusion |
| 5 | Partial-batch `.errored` disposition | §7.6 ACTIVE batch disposition table |
| 6 | `run_assemble` POST concurrency | §7.17 `ASSEMBLE_WORKERS=4` + retry-with-jitter |
| 7 | Image-menu vs extract re-routing | §7.18 `_transition_between_stages` reroute |
| 8 | Post-flight actual-vs-projection check | §7.16 `print_report` cost variance |
| 9 | Advisory lock release on hard crash | §7.12 atexit + signal handlers + port 5432 |
| 10 | `restaurant_type` validation failure | §2.7 coerce to `"other"` + one-retry |

## 4 additional resume-semantics gaps — PATCHED 2026-04-17 AM

From today's deeper dig:

| # | Gap | Patched in |
|---|---|---|
| a | Idempotent submit across crash (double-billing if `submit_batch` dies between `batches.create` and Supabase PATCH) | §2.5a — pre-submit orphan reconciliation via `batches.list` + metadata `{rebuild_run_id, stage, batch_key}` |
| b | Migration 011 schema shape (column name convention unclear; `011_image_library.sql` already shipped, collision) | §2.5b — `STAGES` constant. Migrations renumbered 011→012 and 012→013 |
| c | Assemble resume not in §7.6 matrix | §2.4a — PENDING/DONE/DEADLETTERED/UPSTREAM_NOT_DONE buckets + §2.4 idempotency contract |
| d | Truncated recovery path TBD | §2.10 — `--recover-review <reason>` flag with per-reason matrix; truncated path archives raw + max_tokens |

## PR3 scope summary

**Migrations to apply first:**
- `012_batch_resume_semantics.sql` — adds `active_batch_run_id`, `review_reason` + 2 indexes
- `013_batch_queue_events.sql` — creates append-only event log table

**Code to write in `agent/rebuild_batch.py`:**
- `STAGES` constant (§2.5b) + `_assert_schema` startup check
- `reconcile_orphan_batches` (§2.5a)
- `build_stage_batch`, `submit_batch`, `wait_and_drain`, `run_stage_group`, `_transition_between_stages` (§4 PR3)
- `run_assemble` with `ASSEMBLE_WORKERS=4` + 429 retry-with-jitter (§2.4a, §7.17)
- `--recover-review <reason>` subcommand (§2.10) + `--recover-orphans` alias
- `log_event` helper (§2.9) — never raises, non-fatal event-write failures
- `select_cache_mode` (§2.8) + `--cache-mode` CLI
- `print_report` with cost-variance + per-stage cache-stats table (§7.16)
- Advisory lock via `SUPABASE_DIRECT_URL` port 5432 (§7.12)

**Code changes in `app/api/batch/ingest/route.ts`:**
- Upsert by `pt_record_id` (Option A from §2.4)
- 409 if `deploy_status IN ('queued','executing')` (§2.4)
- Coerce off-list `restaurant_type` to `"other"` or accept 400-retry from rebuild side (§2.7)
- Fully idempotent under same-input retry (§2.4 contract for §2.4a)

**Validation (§4 PR3):**
- 30-row end-to-end
- Resume mid-run drain (don't resubmit)
- Own-run exclusion at t=31m
- Assemble idempotency under mid-POST kill
- Truncation recovery round-trip
- Cost variance ±10% vs projection
- Advisory lock honored across two parallel invocations

## Key file pointers

- `agent/REFACTOR_PLAN.md` — the plan. §1, §2.0–§2.10, §4 PR3, §7.6 matrix.
- `agent/rebuild_batch.py` — PR1 skeleton. PR3 extends.
- `agent/pipeline_shared.py` — PR2 shared module. `STAGES` constant lands here.
- `agent/deploy_agent.py:1146` — image-menu auto-reroute logic PR3 inherits (§7.18).
- `agent/deploy_agent.py:1433, 1638, 1797` — three `max_tokens=32000` sites; PR3 enforces `stop_reason` inspection.
- `app/api/batch/ingest/route.ts` — needs upsert + 409 guard + idempotency (§2.4).
- `app/api/batch/load/route.ts:73` — filters `deploy_status in ('idle','done','failed')`; leave alone.
- `agent/ROLLBACK.md` — current agent suspension state.
- `agent/SEPARATION_AUDIT.md` — PR2 boundary reference.

## Context from earlier sessions (still valid, not PR3 scope)

- Steady-state PT lead hot-path after daemon deletion — PR4/5 concern
- Dead-URL gate duplicated between `classify_url` and `_classify_dead_url` — PR2 cleanup territory
- `/api/batch/process` orphaned after `process_generate_queue` deletion — PR4
- Anthropic cache 1h TTL across stage groups — observability only
- `buildDesignConfig` is AI-free — verified, doc-only
