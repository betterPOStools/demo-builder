# Rollback: cost-optimization changes 2026-04-15

If the cost-optimization batch changes misbehave, revert to the state captured
here. Last known-good git commit:

```
9b44020 fix(batch/load): dual-resolve pt_record_id with/without db_ prefix
```

Everything after that commit is uncommitted cost-optimization work.

## What was changed (in order, all in `agent/deploy_agent.py`)

### 1. WAVE_MAX_SIZE bumped 40 → 200
**Line ~87:** raises batch size so each Anthropic batch amortizes more system-prompt cache creation across rows.

```python
# Rollback:
WAVE_MAX_SIZE = int(os.environ.get("WAVE_MAX_SIZE", "40"))
```

**Env override:** can also revert live via `export WAVE_MAX_SIZE=40` and restart the agent.

### 2. Prompt cache TTL: 5min → 1 hour
**5 occurrences** of `"cache_control": {"type": "ephemeral"}` now include `"ttl": "1h"`.

```python
# Rollback (apply to all 5 occurrences):
"cache_control": {"type": "ephemeral"},
```

### 3. Extract raw_text trimmed 30K → 20K
**In `_build_extract_msg`** (~line 1841):

```python
# Rollback:
return f"Restaurant: {row.get('name')}\n\nMenu page text:\n{raw[:30_000]}"
```

### 4. Content-quality gate before pool_extract
**New function `_classify_extract_skip` added** (~line 427) and **called in `advance_stage_extract`** (~line 1095).

```python
# Rollback: remove the new function AND delete this block from advance_stage_extract:
quality_fail = _classify_extract_skip(raw)
if quality_fail:
    supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
        "status": "failed",
        "error": quality_fail,
        "raw_text": raw.replace("\x00", "")[:40_000],
        "updated_at": _now_iso(),
    })
    print(f"  [S2] quality gate → failed ({quality_fail})")
    continue
```

Rows skipped by the gate get an error prefixed `skipped: ` — safe to identify
for retry if the gate turns out to be too aggressive.

## Full git-diff rollback (fastest)

From `db-suite/demo-builder/`:

```bash
git stash push agent/deploy_agent.py -m "cost-opt-rollback-point"
# Test that the previous behavior works
# If you want to restore the changes: git stash pop
```

Or more surgical — if only one change is bad:

```bash
# View all changes:
git diff agent/deploy_agent.py | less
# Revert just the file:
git checkout agent/deploy_agent.py
```

Then re-apply the changes you want to keep by hand.

## How to tell if the changes broke something

Watch `~/Library/Logs/demo-builder-agent.log` after restart:

| Symptom | Likely cause | Action |
|---|---|---|
| `[S2] quality gate → failed` for 80%+ of rows | Gate too aggressive | Tune thresholds in `_classify_extract_skip` or rollback item 4 |
| `[BATCH] submitted` with 200+ rows but `[POLL]` errors | Batch too big for provider | Lower `WAVE_MAX_SIZE` to 100 then 50 |
| `ephemeral_ttl` not recognized error from Anthropic | 1h TTL not available on your plan | Rollback item 2 (remove `"ttl": "1h"`) |
| Fewer items extracted per row (vs prior runs) | 20K truncation lost menu data | Rollback item 3 to 30K |

## Expected impact if all 4 work

On a 743-row rerun (`rebuild_all.py --done-only --yes`):
- Before: projected $13-16
- After: projected $6-8 (about half)

If actual run lands in the $6-10 range, optimizations are working as intended.
