#!/usr/bin/env python3
"""Full rebuild: reset every batch_queue row to `queued` and clear all derived
fields (extraction_result, modifier_result, branding_result, raw_text,
session_id, generated_sql, error, batch IDs). The agent will then reprocess
every row through the current pipeline (menu-index follower, image-menu,
WCAG contrast, etc.).

This is destructive for the `sessions` table: rows linked via session_id will
be orphaned. Run when you want fresh cost data + fresh output quality, not
when you want to preserve existing generated SQL.

Safety: requires --yes flag. Prints a dry-run count first.

Usage:
  python3 agent/rebuild_all.py            # dry-run, shows counts only
  python3 agent/rebuild_all.py --yes      # actually reset
  python3 agent/rebuild_all.py --yes --exclude-done  # only retry failed/pool/etc (keep done)
"""
import os
import sys
import json
import argparse
import urllib.request
from pathlib import Path

env_path = Path(__file__).parent.parent / ".env.local"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


BASE = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def _headers(extra=None):
    h = {
        "apikey": KEY,
        "Authorization": f"Bearer {KEY}",
        "Content-Profile": "demo_builder",
        "Accept-Profile": "demo_builder",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def get_count(status=None):
    qs = f"{BASE}/rest/v1/batch_queue?select=id&limit=1"
    if status:
        qs += f"&status=eq.{status}"
    req = urllib.request.Request(qs, headers=_headers({"Prefer": "count=exact"}))
    with urllib.request.urlopen(req) as resp:
        cr = resp.headers.get("Content-Range", "0-0/0")
        return int(cr.split("/")[1])


def patch_all_to_queued(exclude_done: bool, done_only: bool = False):
    """Reset every row (or every row not-done) back to queued with all derived
    fields cleared. Uses Supabase PATCH with a non-matching filter that will
    match the rows we want to reset."""
    if done_only:
        filter_qs = "status=eq.done"
    elif exclude_done:
        filter_qs = "status=not.eq.done"
    else:
        filter_qs = "id=not.is.null"

    url = f"{BASE}/rest/v1/batch_queue?{filter_qs}"
    payload = {
        "status": "queued",
        "error": None,
        "raw_text": None,
        "extraction_result": None,
        "modifier_result": None,
        "branding_result": None,
        "homepage_html": None,
        "session_id": None,
        "discover_batch_id": None,
        "extract_batch_id": None,
        "modifier_batch_id": None,
        "branding_batch_id": None,
        "pdf_batch_id": None,
        "image_menu_batch_id": None,
        "stage_custom_id": None,
        "batch_submitted_at": None,
        "last_polled_at": None,
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="PATCH",
        headers=_headers({"Prefer": "return=minimal"}),
    )
    with urllib.request.urlopen(req) as resp:
        return resp.status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="Actually perform the reset")
    ap.add_argument("--exclude-done", action="store_true",
                    help="Keep already-done rows intact; only retry failed/pool/etc")
    ap.add_argument("--done-only", action="store_true",
                    help="Only reset already-done rows (useful for re-running after pipeline improvements)")
    args = ap.parse_args()
    if args.exclude_done and args.done_only:
        print("--exclude-done and --done-only are mutually exclusive")
        sys.exit(1)

    total = get_count()
    done = get_count("done")
    failed = get_count("failed")
    print(f"batch_queue total: {total}")
    print(f"  done:   {done}")
    print(f"  failed: {failed}")
    print(f"  other:  {total - done - failed}")

    if args.done_only:
        target = done
        print(f"\nWould reset ONLY the {done} already-done rows (keeping {total - done} others)")
    elif args.exclude_done:
        target = total - done
        print(f"\nWould reset {target} rows to `queued` (keeping {done} done rows)")
    else:
        target = total
        print(f"\nWould reset ALL {target} rows to `queued` (including {done} already-done)")

    if not args.yes:
        print("\nDry run — pass --yes to actually reset.")
        return

    print("\nResetting rows...")
    status = patch_all_to_queued(args.exclude_done, args.done_only)
    print(f"PATCH status: {status}")

    import time
    time.sleep(2)
    queued_after = get_count("queued")
    print(f"Queued rows after reset: {queued_after}")


if __name__ == "__main__":
    main()
