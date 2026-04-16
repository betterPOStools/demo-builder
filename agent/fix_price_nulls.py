#!/usr/bin/env python3
"""Fix per-mode prices in existing demo-DB snapshots + Supabase sessions.

Older generator runs emitted 0.000000... for DineInPrice, BarPrice,
PickUpPrice, TakeOutPrice, and DeliveryPrice. On the POS these overrode the
DefaultPrice with $0.00 for that mode. Current generator emits NULL for these
so the POS correctly falls back to DefaultPrice.

This script rewrites any existing menuitems REPLACE INTO statements:
for each of the 5 per-mode price columns, if the value is zero (0.000...),
replace with NULL. DefaultPrice is left untouched.

Idempotent.

Usage:
  python3 agent/fix_price_nulls.py            # dry-run
  python3 agent/fix_price_nulls.py --yes      # apply to snapshots + sessions
  python3 agent/fix_price_nulls.py --yes --snapshots-only
  python3 agent/fix_price_nulls.py --yes --sessions-only
"""
from __future__ import annotations

import os
import re
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

PER_MODE_COLS = ["DineInPrice", "BarPrice", "PickUpPrice", "TakeOutPrice", "DeliveryPrice"]

# Match the full REPLACE INTO menuitems block. The column list and VALUES
# are on the same two-ish lines each, so we capture everything up to the
# closing `);`
_MENUITEM_RE = re.compile(
    r"(REPLACE INTO `menuitems`\s*\(([^)]+)\)\s*VALUES\s*\(\s*)([^;]+?)(\s*\);)",
    re.DOTALL,
)

# Matches a zero price (0.000... with optional decimals) as a standalone value
_ZERO_PRICE = re.compile(r"^0\.0+\d*$")


def _split_values(value_str: str) -> list[str]:
    """Split a SQL VALUES list, respecting single-quoted strings."""
    parts = []
    buf = []
    in_quote = False
    i = 0
    while i < len(value_str):
        ch = value_str[i]
        if ch == "'":
            buf.append(ch)
            if in_quote and i + 1 < len(value_str) and value_str[i + 1] == "'":
                # SQL-escaped quote '' — include both
                buf.append(value_str[i + 1])
                i += 2
                continue
            in_quote = not in_quote
            i += 1
            continue
        if ch == "," and not in_quote:
            parts.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    if buf:
        parts.append("".join(buf).strip())
    return parts


def _fix_menuitems_block(cols_str: str, values_str: str) -> tuple[str, bool]:
    """Return (new_values_str, changed)."""
    cols = [c.strip().strip("`") for c in cols_str.split(",")]
    values = _split_values(values_str)
    if len(cols) != len(values):
        return values_str, False
    changed = False
    for col_name in PER_MODE_COLS:
        if col_name not in cols:
            continue
        idx = cols.index(col_name)
        v = values[idx].strip()
        if v.upper() == "NULL":
            continue
        if _ZERO_PRICE.match(v):
            values[idx] = "NULL"
            changed = True
    if not changed:
        return values_str, False
    return ", ".join(values), True


def fix_sql(sql: str) -> tuple[str, int]:
    """Return (new_sql, num_blocks_changed)."""
    changed_count = 0

    def _repl(m: re.Match) -> str:
        nonlocal changed_count
        prefix, cols_str, values_str, suffix = m.group(1), m.group(2), m.group(3), m.group(4)
        new_values, changed = _fix_menuitems_block(cols_str, values_str)
        if changed:
            changed_count += 1
        return f"{prefix}{new_values}{suffix}"

    new_sql = _MENUITEM_RE.sub(_repl, sql)
    return new_sql, changed_count


def scan_snapshots(apply: bool) -> dict:
    if not SNAPSHOT_DIR.exists():
        print(f"[snapshot] {SNAPSHOT_DIR} does not exist — skipping")
        return {"total": 0, "fixed_files": 0, "fixed_blocks": 0}
    files = sorted(SNAPSHOT_DIR.glob("*.sql"))
    stats = {"total": len(files), "fixed_files": 0, "fixed_blocks": 0}
    examples = []
    for path in files:
        try:
            sql = path.read_text()
        except Exception as e:
            print(f"  [read-err] {path.name}: {e}")
            continue
        new_sql, n = fix_sql(sql)
        if n == 0:
            continue
        stats["fixed_files"] += 1
        stats["fixed_blocks"] += n
        if len(examples) < 5:
            examples.append((path.name, n))
        if apply:
            path.write_text(new_sql)
    print(f"[snapshot] files={stats['total']}  files_fixed={stats['fixed_files']}  "
          f"menuitem_blocks_fixed={stats['fixed_blocks']}")
    for name, n in examples:
        print(f"    {name}: {n} blocks rewritten")
    return stats


def scan_sessions(apply: bool) -> dict:
    if not BASE or not KEY:
        print("[sessions] no Supabase env — skipping")
        return {"total": 0, "fixed": 0}
    headers = {
        "apikey": KEY, "Authorization": f"Bearer {KEY}",
        "Accept-Profile": "demo_builder",
    }
    total = 0
    fixed = 0
    total_blocks = 0
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
            new_sql, n = fix_sql(sql)
            if n == 0:
                continue
            fixed += 1
            total_blocks += n
            if len(examples) < 5:
                examples.append((sid, n))
            if apply:
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
    print(f"[sessions] scanned={total}  sessions_fixed={fixed}  "
          f"menuitem_blocks_fixed={total_blocks}")
    for sid, n in examples:
        print(f"    {sid[:8]}: {n} blocks rewritten")
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
