#!/usr/bin/env python3
"""Fix WCAG contrast in existing demo-DB snapshots + Supabase sessions.

Scans every SQL file in ~/Projects/demo-DBs/ and every `sessions.generated_sql`
row in Supabase. For each, finds the `ButtonsBackgroundColor` and
`ButtonsFontColor` UPDATEs, computes contrast ratio, and rewrites the font
color to white or black if the ratio is < 4.5 (WCAG AA).

Idempotent — re-running after a fix is a no-op.

Usage:
  python3 agent/fix_contrast.py            # dry-run; report what would change
  python3 agent/fix_contrast.py --yes      # actually rewrite SQL files + DB
  python3 agent/fix_contrast.py --yes --snapshots-only
  python3 agent/fix_contrast.py --yes --sessions-only
"""
from __future__ import annotations

import os
import re
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

SNAPSHOT_DIR = Path.home() / "Projects" / "demo-DBs"
BASE = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


# WCAG relative luminance
def luminance(hex_str: str) -> float:
    h = hex_str.replace("#", "")
    if len(h) != 6:
        return 0.0
    chans = []
    for i in (0, 2, 4):
        v = int(h[i:i+2], 16) / 255.0
        chans.append(v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4)
    r, g, b = chans
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def better_font(bg: str) -> str:
    return "#FFFFFF" if contrast(bg, "#FFFFFF") >= contrast(bg, "#000000") else "#000000"


# Match the exact SQL the scaffold emits:
#   UPDATE `storesettings` SET `Value` = '#XXXXXX', ... WHERE `Key` = 'ButtonsFontColor' ...
_BG_RE = re.compile(
    r"UPDATE\s+`storesettings`\s+SET\s+`Value`\s*=\s*'(#[0-9A-Fa-f]{6})'[^;]*?"
    r"WHERE\s+`Key`\s*=\s*'ButtonsBackgroundColor'",
    re.IGNORECASE | re.DOTALL,
)
_FG_RE = re.compile(
    r"(UPDATE\s+`storesettings`\s+SET\s+`Value`\s*=\s*')(#[0-9A-Fa-f]{6})('[^;]*?"
    r"WHERE\s+`Key`\s*=\s*'ButtonsFontColor'[^;]*;)",
    re.IGNORECASE | re.DOTALL,
)


def fix_sql(sql: str) -> tuple[str, str | None, str | None, str | None, float | None]:
    """Return (new_sql, bg, old_fg, new_fg, ratio) — new_fg is None if no change needed."""
    bg_match = _BG_RE.search(sql)
    fg_match = _FG_RE.search(sql)
    if not bg_match or not fg_match:
        return sql, None, None, None, None
    bg = bg_match.group(1)
    old_fg = fg_match.group(2)
    ratio = contrast(bg, old_fg)
    if ratio >= 4.5:
        return sql, bg, old_fg, None, ratio
    new_fg = better_font(bg)
    if new_fg.upper() == old_fg.upper():
        return sql, bg, old_fg, None, ratio
    # Rewrite the font-color UPDATE
    new_sql = _FG_RE.sub(
        lambda m: f"{m.group(1)}{new_fg}{m.group(3)}",
        sql,
        count=1,
    )
    return new_sql, bg, old_fg, new_fg, ratio


def scan_snapshots(apply: bool) -> dict:
    if not SNAPSHOT_DIR.exists():
        print(f"[snapshot] {SNAPSHOT_DIR} does not exist — skipping")
        return {"total": 0, "fixed": 0, "skipped": 0, "no_colors": 0}
    files = sorted(SNAPSHOT_DIR.glob("*.sql"))
    stats = {"total": len(files), "fixed": 0, "skipped": 0, "no_colors": 0}
    examples = []
    for path in files:
        try:
            sql = path.read_text()
        except Exception as e:
            print(f"  [read-err] {path.name}: {e}")
            continue
        new_sql, bg, old_fg, new_fg, ratio = fix_sql(sql)
        if bg is None:
            stats["no_colors"] += 1
            continue
        if new_fg is None:
            stats["skipped"] += 1
            continue
        stats["fixed"] += 1
        if len(examples) < 5:
            examples.append((path.name, bg, old_fg, new_fg, ratio))
        if apply:
            path.write_text(new_sql)
    print(f"[snapshot] {stats['total']} files  fixed={stats['fixed']}  ok={stats['skipped']}  no-colors={stats['no_colors']}")
    for name, bg, old_fg, new_fg, ratio in examples:
        print(f"    {name}  bg={bg}  {old_fg}→{new_fg}  ratio={ratio:.2f}")
    return stats


def scan_sessions(apply: bool) -> dict:
    if not BASE or not KEY:
        print("[sessions] no Supabase env — skipping")
        return {"total": 0, "fixed": 0}
    # Paginate through sessions with non-null generated_sql
    headers = {
        "apikey": KEY, "Authorization": f"Bearer {KEY}",
        "Accept-Profile": "demo_builder",
    }
    total = 0
    fixed = 0
    examples = []
    offset = 0
    while True:
        url = (f"{BASE}/rest/v1/sessions?select=id,generated_sql"
               f"&generated_sql=not.is.null&limit=50&offset={offset}")
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                rows = json.load(resp)
        except Exception as e:
            print(f"[sessions] fetch error: {e}")
            break
        if not rows:
            break
        total += len(rows)
        for row in rows:
            sid = row["id"]
            sql = row.get("generated_sql") or ""
            if not sql:
                continue
            new_sql, bg, old_fg, new_fg, ratio = fix_sql(sql)
            if new_fg is None:
                continue
            fixed += 1
            if len(examples) < 5:
                examples.append((sid, bg, old_fg, new_fg, ratio))
            if apply:
                # PATCH the session with corrected SQL
                patch_url = f"{BASE}/rest/v1/sessions?id=eq.{sid}"
                patch_req = urllib.request.Request(
                    patch_url,
                    data=json.dumps({"generated_sql": new_sql}).encode(),
                    method="PATCH",
                    headers={**headers,
                             "Content-Profile": "demo_builder",
                             "Content-Type": "application/json",
                             "Prefer": "return=minimal"},
                )
                try:
                    urllib.request.urlopen(patch_req).read()
                except Exception as e:
                    print(f"  [patch-err] {sid[:8]}: {e}")
        if len(rows) < 50:
            break
        offset += 50
    print(f"[sessions] scanned={total}  fixed={fixed}")
    for sid, bg, old_fg, new_fg, ratio in examples:
        print(f"    {sid[:8]}  bg={bg}  {old_fg}→{new_fg}  ratio={ratio:.2f}")
    return {"total": total, "fixed": fixed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--snapshots-only", action="store_true")
    ap.add_argument("--sessions-only", action="store_true")
    args = ap.parse_args()
    apply = args.yes

    if not args.sessions_only:
        scan_snapshots(apply)
    if not args.snapshots_only:
        scan_sessions(apply)

    if not apply:
        print("\nDry run. Re-run with --yes to apply.")


if __name__ == "__main__":
    main()
