# Separate Deploy Daemon from Batch Pipeline

**Operator principle** (2026-04-16):
> "the batch function should never happen automatically. they need direct intervention from me to process. the tablet deployments for demos that needs to be always available and stable"

## End state

| Entity | Type | Trigger | Touches tablet? |
|---|---|---|---|
| `agent/deploy_agent.py` | launchd daemon, always-on | `sessions.deploy_status='queued'` (5s poll) | Yes — SCP + POS restart |
| `agent/batch_pipeline.py` (or fold into `rebuild_batch.py`) | CLI, runs only when invoked | Operator types the command | No |
| `agent/pipeline_shared.py` | module | imported by both | n/a |

No daemon spends Anthropic dollars. No cron, no auto-trigger, no launchd for batch.

---

## Phase 0 — Immediate safety (RIGHT NOW, ~5 min) — **Sonnet**

Goal: tablet has stable deploy service back within minutes. Code separation is later.

1. Add `DEPLOY_ONLY` env gate in `deploy_agent.py:main()` — skip `run_staged_pipeline()` / `process_generate_queue()` when set. 3 lines.
2. Edit `~/Library/LaunchAgents/com.valuesystems.demo-builder-agent.plist` — add `<key>DEPLOY_ONLY</key><string>1</string>` under `EnvironmentVariables`.
3. `launchctl unload` then `launchctl load` the plist.
4. Verify: log shows deploy-poll lines but zero `[S1]` / `[S2]` stage lines.

**Exit criteria:** queue a trivial demo from UI → it deploys within 10s → log shows only deploy activity → `launchctl list` shows agent healthy.

**Risk:** low. `DEPLOY_ONLY=1` is additive; removing it reverts behavior.

---

## Phase 1 — Audit the boundary (~30 min) — **Opus**

Goal: every function in `deploy_agent.py` (2760 lines) labeled as `DEPLOY`, `BATCH`, or `SHARED` before any code moves.

Deliverable: `agent/SEPARATION_AUDIT.md` (scratch, not committed) with three columns:

| Function / symbol | Line | Category | Imported by |
|---|---|---|---|

**Method:** grep for `^def ` and `^[A-Z_]+ *=` in `deploy_agent.py`, walk each. Known anchors:
- `process_queued` (2616) → DEPLOY
- `run_staged_pipeline` → BATCH
- `process_generate_queue` → BATCH (legacy, already marked for deletion in REFACTOR_PLAN PR4)
- `ssh_available`, `push_images_scp`, POS lifecycle → DEPLOY
- `execute_sql` → SHARED (both use it)
- `supabase_patch` / `supabase_get` → SHARED
- All stage functions (S1–S5), PDF batch, image-menu batch → BATCH

Opus's value here is catching the *non-obvious* cases: helpers that look SHARED but actually only serve one side, or constants like `BATCH_BUDGET_USD` that look BATCH but are also read by deploy reporting. Mislabeling creates circular imports in Phase 2.

**Exit criteria:** every `def` and module-level constant categorized. Any AMBIGUOUS entries surfaced for operator decision before Phase 2.

---

## Phase 2 — Extract `pipeline_shared.py` (~1 hr) — **Sonnet**

This is PR2 of the existing REFACTOR_PLAN, pulled forward. It unblocks Phase 3.

1. Create `agent/pipeline_shared.py`.
2. Move every SHARED symbol from the Phase 1 audit.
3. In `deploy_agent.py`, replace definitions with `from pipeline_shared import ...`.
4. Add prompt-load assertions on startup (per REFACTOR_PLAN §3).
5. Update the three other callers (`dryrun_staged.py`, `check_cache.py`, `test_extract.py`).
6. `python3 agent/deploy_agent.py --help` (or import-smoketest) must not error.

**Exit criteria:** both pipeline paths still work when daemon is un-gated (`DEPLOY_ONLY=0`, manual run, single poll cycle). Then re-gate and reload.

**Risk:** medium. Import surface is wide. Keep the gate on during this phase so daemon never runs batch code.

---

## Phase 3 — Create `batch_pipeline.py` (CLI) (~1.5 hr) — **Sonnet** with **Opus** for plan review

Goal: every BATCH-category function moves to a new file that is ONLY invokable from CLI.

1. Create `agent/batch_pipeline.py`:
   - Shebang + `if __name__ == "__main__": main()` only.
   - Imports from `pipeline_shared`.
   - `main()` has subcommands: `run-staged`, `retry-failed`, `dry-run`. (Eventually folds into planned `rebuild_batch.py`; for now, keep separate to avoid conflating with PR3 plan.)
2. Move all BATCH symbols from `deploy_agent.py` → `batch_pipeline.py`.
3. Delete `BATCH_*` config reads from `deploy_agent.py`.
4. Delete `USE_STAGED_PIPELINE` env var (dead once batch code is gone).
5. Delete `DEPLOY_ONLY` gate (file no longer has batch code to gate).
6. `deploy_agent.py:main()` now calls only `process_queued()` + heartbeat.

**Opus review before commit:** read the new `batch_pipeline.py` + the slimmed `deploy_agent.py` side-by-side, confirm no dead code, no orphan imports, no daemon path that reaches batch functions. Sonnet does the moves; Opus catches leaks.

**Exit criteria:**
- `grep -n "batch\|stage_" agent/deploy_agent.py` → only matches in comments or deploy-side helpers.
- `python3 agent/batch_pipeline.py --help` prints subcommands.
- Daemon reload: log shows deploy activity only; zero `[S*]` lines forever.

---

## Phase 4 — Update docs + plist (~15 min) — **Sonnet**

1. `CLAUDE.md` — rewrite the "Deploy Agent" section to list two entities clearly:
   - `deploy_agent.py` — launchd-managed, what it does, how to read its log
   - `batch_pipeline.py` — CLI-only, how to run, cost warnings, link to REFACTOR_PLAN
2. Plist docstring / `com.valuesystems.demo-builder-agent.plist` — add a `<!-- comment -->` noting this daemon does NOT run batches.
3. Delete `agent/TOOLS.md` entries for any symbols that moved; add new entry for `batch_pipeline.py` with purpose + constraints (per project TOOLS policy).

**Exit criteria:** a fresh pair of eyes reading `CLAUDE.md` + `TOOLS.md` understands the separation without reading code.

---

## Phase 5 — PR3 realignment (~15 min) — **Opus**

PR3 was designed assuming pipeline code stays in `deploy_agent.py`. With the split, PR3's call sites land in `batch_pipeline.py` instead. Opus revises `REFACTOR_PLAN.md`:
- Update §4 PR3 deliverables to name `batch_pipeline.py` / `rebuild_batch.py` (not `deploy_agent.py`) as the host for migration 011/012 writes, `log_event` helper, `active_batch_run_id` paths.
- Update §3 PR2 deliverables — `pipeline_shared.py` already landed in this separation; mark that portion of PR2 as complete.
- Revision log entry.

**Exit criteria:** REFACTOR_PLAN.md internally consistent with the two-entity model.

---

## Total scope

| Phase | Hours | Model | Dependency |
|---|---|---|---|
| 0. DEPLOY_ONLY gate | 0.1 | Sonnet | — |
| 1. Boundary audit | 0.5 | Opus | 0 |
| 2. pipeline_shared | 1.0 | Sonnet | 1 |
| 3. batch_pipeline split | 1.5 | Sonnet + Opus review | 2 |
| 4. Docs + plist | 0.25 | Sonnet | 3 |
| 5. PR3 plan realign | 0.25 | Opus | 3 |
| **Total** | **~3.5 hr** | | |

Phase 0 is the only one that must happen *now*. The rest can be a focused work block whenever you're ready. Phase 2 is lift-and-shift safe; Phases 3–5 should ship as one PR ("separate batch from deploy") so the daemon + CLI land together.

---

## Model assignment rationale

Per `feedback_model_selection.md`:
- **Sonnet:** mechanical moves, config edits, doc rewrites, import updates — spec is clear, value is speed + correctness.
- **Opus:** boundary classification (Phase 1), cross-file integrity review (Phase 3 pre-commit), plan realignment (Phase 5) — these require holding the whole system in head and catching subtle leaks.

Never run Phase 3 moves without a Phase 1 audit — that's where Opus earns its keep. Never pay Opus to rename imports — that's Sonnet work.
