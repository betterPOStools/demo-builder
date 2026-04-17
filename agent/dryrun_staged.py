#!/usr/bin/env python3
"""Dry run the staged batch pipeline.
Runs run_staged_pipeline() on a loop with small WAVE_MIN_SIZE until
all queued/pool/in-flight rows resolve or a hard timeout elapses."""
import os, sys, time
os.environ.setdefault("WAVE_MIN_SIZE", "2")
os.environ.setdefault("BATCH_POLL_INTERVAL_SEC", "30")
os.environ.setdefault("FORCE_WAVE_AFTER_SECONDS", "60")
sys.path.insert(0, os.path.dirname(__file__))

# Shared symbols from pipeline_shared; BATCH symbols now come from batch_pipeline.
import pipeline_shared as ps
import batch_pipeline as bp

TRACKED_IDS = [
    "67497d18-7788-4a60-b286-7bbe225ad99a",  # Baskin-Robbins
    "ab9451d1-eabb-48ea-9114-907f96d7c31c",  # Charleys Cheesesteaks
    "10100eed-68f0-40b6-914b-3b4d95f2dfb9",  # Acai Express
    "550dae94-3832-4269-81c0-41db1b2aa293",  # Yummy Cuisine
    "34578171-d57e-4678-bcfd-57078bb142d0",  # Tropical Smoothie Cafe
]

PIPELINE_STATUSES = {
    "queued", "discovering", "ready_for_extract", "extracting",
    "ready_for_modifier", "modifier_deciding",
    "ready_for_branding", "branding_deciding", "ready_to_assemble",
    "assembling",
    "pool_discover", "pool_extract", "pool_modifier", "pool_branding",
    "batch_discover_submitted", "batch_extract_submitted",
    "batch_modifier_submitted", "batch_branding_submitted",
}


def snapshot():
    id_list = ",".join(f'"{x}"' for x in TRACKED_IDS)
    rows = ps.supabase_get(
        "batch_queue",
        params={
            "id": f"in.({id_list})",
            "select": "id,name,status,error,menu_url,discover_batch_id,extract_batch_id,modifier_batch_id,branding_batch_id",
        },
    )
    return rows or []


def print_status():
    rows = snapshot()
    print(f"\n── status @ {time.strftime('%H:%M:%S')} ──")
    for r in rows:
        badge = ""
        for k in ("discover_batch_id", "extract_batch_id", "modifier_batch_id", "branding_batch_id"):
            if r.get(k):
                badge += f" [{k.split('_')[0]}:{r[k][-6:]}]"
        err = f"  ERR:{r['error'][:60]}" if r.get("error") else ""
        print(f"  {r['name'][:30]:<30} {r['status']:<28}{badge}{err}")
    return rows


def all_terminal(rows):
    for r in rows:
        if r["status"] in PIPELINE_STATUSES:
            return False
    return True


def main():
    print(f"Dry run: WAVE_MIN_SIZE={bp.WAVE_MIN_SIZE} FORCE_WAVE_AFTER_SECONDS={bp.FORCE_WAVE_AFTER_SECONDS}")
    start = time.time()
    MAX_MINUTES = 45
    tick = 0
    while True:
        tick += 1
        print(f"\n━━━━━━━━━━ tick {tick} ━━━━━━━━━━")
        try:
            bp.run_staged_pipeline()
        except ps._ApiLimitHit as e:
            print(f"[LIMIT] {e}")
        except Exception as e:
            print(f"[ERR] run_staged_pipeline: {e}")
            import traceback; traceback.print_exc()
        rows = print_status()
        if all_terminal(rows):
            print("\n✓ all 5 rows reached terminal status")
            break
        if (time.time() - start) / 60 > MAX_MINUTES:
            print(f"\n✗ timeout after {MAX_MINUTES} min")
            break
        time.sleep(15)


if __name__ == "__main__":
    main()
