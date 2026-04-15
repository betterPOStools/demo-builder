#!/usr/bin/env python3
"""
Backfill SQL snapshots missing from ~/Projects/demo-DBs/.

Sessions assembled via advance_stage_assemble() had save_snapshot(None, ...)
which crashed silently — pt_record_id was None. This script finds all sessions
with generated_sql and no corresponding snapshot file, and writes the missing ones.

Run once: python3 agent/backfill_snapshots.py
"""

import os
import re
import sys
import json
import requests
from datetime import datetime, timezone

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://mqifktmmyiqzrolrvsmy.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
SNAPSHOT_DIR = os.path.expanduser(os.environ.get("SNAPSHOT_DIR", "~/Projects/demo-DBs"))
DEMO_BUILDER_SCHEMA = "demo_builder"

if not SUPABASE_KEY:
    print("ERROR: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY env var required")
    sys.exit(1)

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept-Profile": DEMO_BUILDER_SCHEMA,
    "Content-Profile": DEMO_BUILDER_SCHEMA,
    "Content-Type": "application/json",
    "Range": "0-9999",
}


def get_snapshot_path(name, pt_record_id, allow_versioning=False):
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:40]
    if pt_record_id:
        short_id = pt_record_id.replace("-", "")[:8]
    else:
        short_id = "unknown0"
    base = f"{slug}_{short_id}"
    base_path = os.path.join(SNAPSHOT_DIR, f"{base}.sql")
    if not allow_versioning or not os.path.exists(base_path):
        return base_path
    v = 2
    while os.path.exists(os.path.join(SNAPSHOT_DIR, f"{base}_v{v}.sql")):
        v += 1
    return os.path.join(SNAPSHOT_DIR, f"{base}_v{v}.sql")


def fetch_all_sessions():
    """Fetch all sessions with generated_sql in pages."""
    all_sessions = []
    offset = 0
    page_size = 500
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/sessions",
            headers={**HEADERS, "Range": f"{offset}-{offset + page_size - 1}"},
            params={
                "select": "id,restaurant_name,pt_record_id,generated_sql",
                "generated_sql": "not.is.null",
                "generated_sql": "neq.",
            },
        )
        data = resp.json()
        if not isinstance(data, list) or len(data) == 0:
            break
        all_sessions.extend(data)
        if len(data) < page_size:
            break
        offset += page_size
    return all_sessions


def main():
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    index_path = os.path.join(SNAPSHOT_DIR, "snapshot_index.json")

    print(f"Fetching sessions from Supabase...")
    sessions = fetch_all_sessions()
    print(f"  {len(sessions)} sessions with generated_sql")

    written = 0
    skipped = 0
    errors = 0

    for s in sessions:
        name = s.get("restaurant_name") or "unknown"
        pt_id = s.get("pt_record_id")
        sql = s.get("generated_sql")
        if not sql:
            continue

        path = get_snapshot_path(name, pt_id)
        if os.path.exists(path):
            skipped += 1
            continue

        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(sql)
            written += 1
            print(f"  [WRITE] {os.path.basename(path)}")

            # Update index
            try:
                if os.path.exists(index_path):
                    with open(index_path) as f:
                        index = json.load(f)
                else:
                    index = {"version": "1", "snapshots": []}
                index["snapshots"].append({
                    "path": path,
                    "name": name,
                    "session_id": s.get("id"),
                    "saved_at": datetime.now(timezone.utc).isoformat(),
                })
                with open(index_path, "w") as f:
                    json.dump(index, f, indent=2)
            except Exception:
                pass

        except Exception as e:
            print(f"  [ERROR] {name}: {e}")
            errors += 1

    print(f"\nDone: {written} written, {skipped} skipped (already exist), {errors} errors")
    print(f"Snapshot dir now has {len(os.listdir(SNAPSHOT_DIR))} files")


if __name__ == "__main__":
    main()
