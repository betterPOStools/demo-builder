#!/usr/bin/env python3
"""
Demo Builder — Modifier Linkage E2E Tests
==========================================
Pulls the last N completed deploy sessions from Supabase, deploys each to a
throwaway `e2e_test` database on the demo tablet, and verifies modifier
linkage after every deploy.

Usage:
    python3 agent/test_e2e.py [--count 3] [--db-host 100.112.68.19]

Environment:
    SUPABASE_URL / SUPABASE_KEY  — in agent/.env
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime

import mysql.connector
import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

SUPABASE_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept": "application/json",
    "Accept-Profile": "demo_builder",
}

TEST_DB = "e2e_test"
SCHEMA_SOURCE_DB = "sudsnsubs"   # copy table structure from here

PASS = "✓ PASS"
FAIL = "✗ FAIL"
WARN = "⚠ WARN"

# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def fetch_sessions(count: int) -> list:
    url = (
        f"{SUPABASE_URL}/rest/v1/sessions"
        f"?deploy_status=eq.done&order=updated_at.desc&limit={count}"
        f"&select=id,updated_at,deploy_result,generated_sql"
    )
    r = requests.get(url, headers=SUPABASE_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def db_connect(host, port, user, password, database=None):
    kwargs = dict(host=host, port=port, user=user, password=password, autocommit=True)
    if database:
        kwargs["database"] = database
    return mysql.connector.connect(**kwargs)

def setup_test_db(host, port, user, password):
    """Drop and recreate e2e_test by copying schema from SCHEMA_SOURCE_DB."""
    conn = db_connect(host, port, user, password)
    cur = conn.cursor()
    cur.execute(f"DROP DATABASE IF EXISTS `{TEST_DB}`")
    cur.execute(f"CREATE DATABASE `{TEST_DB}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
    cur.execute(f"USE `{SCHEMA_SOURCE_DB}`")
    cur.execute("SHOW FULL TABLES WHERE Table_type='BASE TABLE'")
    tables = [row[0] for row in cur.fetchall()]
    for table in tables:
        cur.execute(f"CREATE TABLE `{TEST_DB}`.`{table}` LIKE `{SCHEMA_SOURCE_DB}`.`{table}`")
    cur.close()
    conn.close()
    print(f"  [DB] Created {TEST_DB} with {len(tables)} tables from {SCHEMA_SOURCE_DB}")

def run_sql(host, port, user, password, sql: str) -> tuple[int, list[str]]:
    """Execute the full deploy SQL against e2e_test. Returns (rows_affected, warnings)."""
    conn = db_connect(host, port, user, password, database=TEST_DB)
    conn.autocommit = False
    cur = conn.cursor()
    total_rows = 0
    warnings = []
    try:
        cur.execute("SET FOREIGN_KEY_CHECKS=0")
        for stmt in sql.split(";"):
            lines = stmt.strip().splitlines()
            stmt = "\n".join(l for l in lines if not l.strip().startswith("--")).strip()
            if not stmt:
                continue
            try:
                cur.execute(stmt)
                total_rows += cur.rowcount if cur.rowcount > 0 else 0
            except mysql.connector.Error as e:
                warnings.append(e.msg[:120])
        cur.execute("SET FOREIGN_KEY_CHECKS=1")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()
    return total_rows, warnings

def verify(host, port, user, password) -> dict:
    """Run all modifier-linkage verification queries against e2e_test."""
    conn = db_connect(host, port, user, password, database=TEST_DB)
    cur = conn.cursor(dictionary=True)
    r = {}

    def q(sql):
        cur.execute(sql)
        return cur.fetchone()

    def qall(sql):
        cur.execute(sql)
        return cur.fetchall()

    r["total_items"] = q(
        "SELECT COUNT(*) n FROM menuitems WHERE IsDeleted=0"
    )["n"]

    r["total_templates"] = q(
        "SELECT COUNT(*) n FROM menumodifiertemplates WHERE IsDeleted=0"
    )["n"]

    r["items_with_template"] = q(
        "SELECT COUNT(*) n FROM menuitems "
        "WHERE MenuModifierTemplateId IS NOT NULL AND IsDeleted=0"
    )["n"]

    # Templates that are actually attached to an item
    r["templates_attached"] = q("""
        SELECT COUNT(DISTINCT mmt.Id) n
        FROM menumodifiertemplates mmt
        JOIN menuitems mi ON mi.MenuModifierTemplateId = mmt.Id
        WHERE mmt.IsDeleted=0 AND mi.IsDeleted=0
    """)["n"]

    # Templates with at least one section
    r["templates_with_sections"] = q("""
        SELECT COUNT(DISTINCT mmt.Id) n
        FROM menumodifiertemplates mmt
        JOIN menumodifiertemplatesections s ON s.MenuModifierTemplateId = mmt.Id
        WHERE mmt.IsDeleted=0 AND s.IsDeleted=0
    """)["n"]

    # Templates with sections that have modifier options
    r["templates_fully_populated"] = q("""
        SELECT COUNT(DISTINCT mmt.Id) n
        FROM menumodifiertemplates mmt
        JOIN menumodifiertemplatesections s ON s.MenuModifierTemplateId = mmt.Id
        JOIN menumodifiertemplateitems ti ON ti.MenuModifierTemplateSectionId = s.Id
        WHERE mmt.IsDeleted=0 AND s.IsDeleted=0 AND ti.IsDeleted=0
    """)["n"]

    # Orphaned templates: in DB but no item points to them
    r["orphaned_templates"] = q("""
        SELECT COUNT(*) n
        FROM menumodifiertemplates mmt
        WHERE mmt.IsDeleted=0
          AND NOT EXISTS (
              SELECT 1 FROM menuitems mi
              WHERE mi.MenuModifierTemplateId = mmt.Id AND mi.IsDeleted=0
          )
    """)["n"]

    # Items that have a template ID but the template doesn't exist / is deleted
    r["broken_item_links"] = q("""
        SELECT COUNT(*) n FROM menuitems mi
        WHERE mi.MenuModifierTemplateId IS NOT NULL
          AND mi.IsDeleted=0
          AND NOT EXISTS (
              SELECT 1 FROM menumodifiertemplates mmt
              WHERE mmt.Id = mi.MenuModifierTemplateId AND mmt.IsDeleted=0
          )
    """)["n"]

    # Sections with no modifier options (empty sections)
    r["empty_sections"] = q("""
        SELECT COUNT(*) n
        FROM menumodifiertemplatesections s
        WHERE s.IsDeleted=0
          AND NOT EXISTS (
              SELECT 1 FROM menumodifiertemplateitems ti
              WHERE ti.MenuModifierTemplateSectionId = s.Id AND ti.IsDeleted=0
          )
    """)["n"]

    # Modifier items referencing missing menumodifiers
    r["broken_modifier_refs"] = q("""
        SELECT COUNT(*) n
        FROM menumodifiertemplateitems ti
        WHERE ti.IsDeleted=0
          AND ti.MenuModifierId IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM menumodifiers mm
              WHERE mm.Id = ti.MenuModifierId AND mm.IsDeleted=0
          )
    """)["n"]

    # 5 sample linked items for spot-check
    r["sample"] = qall("""
        SELECT mi.Name item,
               mmt.Name template,
               COUNT(DISTINCT s.Id) sections,
               COUNT(ti.Id) options
        FROM menuitems mi
        JOIN menumodifiertemplates mmt ON mi.MenuModifierTemplateId = mmt.Id
        JOIN menumodifiertemplatesections s ON s.MenuModifierTemplateId = mmt.Id
        LEFT JOIN menumodifiertemplateitems ti ON ti.MenuModifierTemplateSectionId = s.Id
        WHERE mi.IsDeleted=0 AND mmt.IsDeleted=0 AND s.IsDeleted=0
        GROUP BY mi.Id, mi.Name, mmt.Id, mmt.Name
        HAVING options > 0
        LIMIT 5
    """)

    # Items that have NO template at all (might be intentional)
    r["items_no_template"] = q(
        "SELECT COUNT(*) n FROM menuitems "
        "WHERE MenuModifierTemplateId IS NULL AND IsDeleted=0"
    )["n"]

    cur.close()
    conn.close()
    return r

def cleanup_test_db(host, port, user, password):
    conn = db_connect(host, port, user, password)
    conn.cursor().execute(f"DROP DATABASE IF EXISTS `{TEST_DB}`")
    conn.close()

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def report(session_id: str, updated_at: str, rows: int, warnings: list,
           v: dict, idx: int, total: int):
    print()
    print("=" * 60)
    print(f"  TEST {idx}/{total}  |  Session {session_id[:8]}")
    print(f"  Deployed: {updated_at[:16]}  |  Rows affected: {rows}")
    print("=" * 60)

    checks = [
        ("Items created",           v["total_items"],             lambda x: x > 0),
        ("Templates created",       v["total_templates"],         lambda x: x > 0),
        ("Items → template linked", v["items_with_template"],     lambda x: x == v["total_templates"]),
        ("Templates → item linked", v["templates_attached"],      lambda x: x == v["total_templates"]),
        ("Templates have sections", v["templates_with_sections"], lambda x: x == v["total_templates"]),
        ("Templates fully populated", v["templates_fully_populated"], lambda x: x == v["total_templates"]),
        ("Orphaned templates",      v["orphaned_templates"],      lambda x: x == 0),
        ("Broken item→template",    v["broken_item_links"],       lambda x: x == 0),
        ("Empty sections",          v["empty_sections"],          lambda x: x == 0),
        ("Broken modifier refs",    v["broken_modifier_refs"],    lambda x: x == 0),
    ]

    all_pass = True
    for label, value, predicate in checks:
        status = PASS if predicate(value) else FAIL
        if status == FAIL:
            all_pass = False
        print(f"  {status}  {label}: {value}")

    # Info-only
    print(f"  {'ℹ':2}  Items without template (ok if intentional): {v['items_no_template']}")

    if v["sample"]:
        print()
        print("  Sample linked items:")
        for row in v["sample"]:
            print(f"    {row['item'][:30]:30s} → {row['template'][:30]:30s} | {row['sections']} sections, {row['options']} options")

    if warnings:
        print()
        print(f"  {WARN}  SQL warnings ({len(warnings)}):")
        for w in warnings[:5]:
            print(f"    {w}")
        if len(warnings) > 5:
            print(f"    ... and {len(warnings) - 5} more")

    print()
    print(f"  RESULT: {'ALL CHECKS PASSED' if all_pass else 'FAILURES DETECTED'}")
    return all_pass

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=3, help="Number of sessions to test")
    parser.add_argument("--db-host", default="100.112.68.19")
    parser.add_argument("--db-port", type=int, default=3306)
    parser.add_argument("--db-user", default="root")
    parser.add_argument("--db-password", default="123456")
    parser.add_argument("--keep-db", action="store_true", help="Don't drop e2e_test when done")
    args = parser.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL / SUPABASE_KEY not set in agent/.env")
        sys.exit(1)

    print(f"\nDemo Builder E2E Modifier Tests")
    print(f"Target: {args.db_host}:{args.db_port}  |  Sessions: {args.count}")
    print(f"Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    print("[1] Fetching sessions from Supabase...")
    sessions = fetch_sessions(args.count)
    if not sessions:
        print("No completed sessions found.")
        sys.exit(1)
    print(f"    Got {len(sessions)} session(s)")

    overall_pass = True

    for idx, session in enumerate(sessions, 1):
        sid = session["id"]
        updated_at = session.get("updated_at", "?")
        sql = session.get("generated_sql", "")
        deploy_result = json.loads(session.get("deploy_result") or "{}")

        if not sql:
            print(f"\n[{idx}] Session {sid[:8]}: no generated_sql, skipping")
            continue

        print(f"\n[{idx}] Session {sid[:8]}  ({len(sql):,} chars of SQL)")

        # Create fresh test DB
        print(f"  Setting up {TEST_DB}...")
        setup_test_db(args.db_host, args.db_port, args.db_user, args.db_password)

        # Deploy
        print(f"  Deploying SQL...")
        t0 = time.time()
        rows, warnings = run_sql(args.db_host, args.db_port, args.db_user, args.db_password, sql)
        elapsed = time.time() - t0
        print(f"  Done in {elapsed:.1f}s  ({rows} rows affected, {len(warnings)} warnings)")

        # Verify
        print(f"  Verifying modifier linkage...")
        v = verify(args.db_host, args.db_port, args.db_user, args.db_password)

        passed = report(sid, updated_at, rows, warnings, v, idx, len(sessions))
        if not passed:
            overall_pass = False

    if not args.keep_db:
        print(f"\n[cleanup] Dropping {TEST_DB}...")
        cleanup_test_db(args.db_host, args.db_port, args.db_user, args.db_password)

    print()
    print("=" * 60)
    print(f"OVERALL: {'ALL TESTS PASSED' if overall_pass else 'SOME TESTS FAILED'}")
    print("=" * 60)
    sys.exit(0 if overall_pass else 1)

if __name__ == "__main__":
    main()
