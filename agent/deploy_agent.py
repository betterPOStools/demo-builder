#!/usr/bin/env python3
"""
Demo Builder Deploy Agent
~~~~~~~~~~~~~~~~~~~~~~~~~
Lightweight agent that runs on your laptop. Polls Supabase for queued deployments,
executes SQL against MariaDB, and pushes images via the POS upload server.

Usage:
    python deploy_agent.py

Environment variables (in .env):
    SUPABASE_URL        — Supabase project URL
    SUPABASE_KEY        — Supabase service role key (or anon key)
    DB_HOST             — MariaDB host (default: 192.168.40.141)
    DB_PORT             — MariaDB port (default: 3306)
    DB_USER             — MariaDB user (default: root)
    DB_PASSWORD          — MariaDB password
    DB_NAME             — MariaDB database name (default: pecandemodb)
    UPLOAD_SERVER_URL   — POS upload server (default: http://192.168.40.141:8081)
    POLL_INTERVAL       — Seconds between polls (default: 5)
"""

import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

import mysql.connector
import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_env():
    """Load .env file if present."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
DB_HOST = os.environ.get("DB_HOST", "192.168.40.141")
DB_PORT = int(os.environ.get("DB_PORT", "3306"))
DB_USER = os.environ.get("DB_USER", "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "123456")
DB_NAME = os.environ.get("DB_NAME", "pecandemodb")
UPLOAD_SERVER_URL = os.environ.get("UPLOAD_SERVER_URL", "http://192.168.40.141:8081")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
    "Accept-Profile": "demo_builder",
    "Content-Profile": "demo_builder",
}

# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def supabase_get(table, params=None):
    """GET from Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"},
                     params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def supabase_patch(table, match, data):
    """PATCH a row in Supabase."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.patch(url, headers=HEADERS, params=match, json=data, timeout=10)
    r.raise_for_status()

# ---------------------------------------------------------------------------
# SQL Execution
# ---------------------------------------------------------------------------

def execute_sql(sql, deploy_target=None):
    """Execute SQL against MariaDB. Returns rows affected."""
    host = DB_HOST
    port = DB_PORT
    user = DB_USER
    password = DB_PASSWORD
    database = DB_NAME

    if deploy_target:
        host = deploy_target.get("host", host)
        port = deploy_target.get("port", port)
        user = deploy_target.get("user", user)
        password = deploy_target.get("password", password)
        database = deploy_target.get("database", database)

    conn = mysql.connector.connect(
        host=host, port=port, user=user, password=password,
        database=database, autocommit=False,
    )
    cursor = conn.cursor()
    total_rows = 0

    try:
        cursor.execute("SET FOREIGN_KEY_CHECKS=0")

        # Split into individual statements and execute
        for stmt in sql.split(";"):
            stmt = stmt.strip()
            if not stmt or stmt.startswith("--"):
                continue
            try:
                cursor.execute(stmt)
                total_rows += cursor.rowcount if cursor.rowcount > 0 else 0
            except mysql.connector.Error as e:
                print(f"  [WARN] Statement failed: {e.msg[:100]}")
                # Continue with remaining statements

        cursor.execute("SET FOREIGN_KEY_CHECKS=1")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

    return total_rows

# ---------------------------------------------------------------------------
# Image Push
# ---------------------------------------------------------------------------

def push_images(pending_images, upload_url=None):
    """Download images from URLs and push to POS upload server."""
    url = upload_url or UPLOAD_SERVER_URL
    pushed = 0
    failed = 0

    for img in pending_images:
        try:
            image_url = img.get("image_url") or img.get("imageUrl")
            dest_path = img.get("dest_path") or img.get("destPath")
            if not image_url or not dest_path:
                continue

            # Download image
            r = requests.get(image_url, timeout=30)
            r.raise_for_status()

            # Upload to POS
            upload_resp = requests.post(
                f"{url}/upload",
                files={"file": (dest_path, r.content)},
                data={"path": dest_path},
                timeout=30,
            )
            upload_resp.raise_for_status()
            pushed += 1
            print(f"  [IMG] Pushed: {dest_path}")
        except Exception as e:
            failed += 1
            print(f"  [IMG] Failed {img.get('name', '?')}: {e}")

    return pushed, failed

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def process_queued():
    """Check for and process queued deployments."""
    try:
        rows = supabase_get("sessions", {
            "deploy_status": "eq.queued",
            "select": "id,generated_sql,pending_images,deploy_target",
        })
    except Exception as e:
        print(f"[POLL] Error checking queue: {e}")
        return

    for session in rows:
        sid = session["id"]
        sql = session.get("generated_sql", "")
        pending_images = session.get("pending_images") or []
        deploy_target = session.get("deploy_target")

        print(f"\n[DEPLOY] Processing session {sid[:8]}...")

        # Mark as executing
        try:
            supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                "deploy_status": "executing",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as e:
            print(f"  [ERROR] Could not update status: {e}")
            continue

        try:
            # Execute SQL
            rows_affected = execute_sql(sql, deploy_target)
            print(f"  [SQL] {rows_affected} rows affected")

            # Push images
            images_pushed, images_failed = 0, 0
            if pending_images:
                upload_url = (deploy_target or {}).get("upload_server_url", UPLOAD_SERVER_URL)
                images_pushed, images_failed = push_images(pending_images, upload_url)

            # Mark done
            result = {
                "ok": True,
                "rows_affected": rows_affected,
                "error": None,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "images_pushed": images_pushed,
                "images_failed": images_failed,
            }
            supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                "deploy_status": "done",
                "deploy_result": json.dumps(result),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            print(f"  [DONE] Success!")

        except Exception as e:
            print(f"  [FAIL] {e}")
            traceback.print_exc()
            result = {
                "ok": False,
                "rows_affected": 0,
                "error": str(e)[:500],
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "images_pushed": 0,
                "images_failed": 0,
            }
            try:
                supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                    "deploy_status": "failed",
                    "deploy_result": json.dumps(result),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                print("  [ERROR] Could not update failure status")


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: Set SUPABASE_URL and SUPABASE_KEY in .env")
        sys.exit(1)

    print(f"Demo Builder Deploy Agent")
    print(f"  Supabase: {SUPABASE_URL}")
    print(f"  Target:   {DB_HOST}:{DB_PORT}/{DB_NAME}")
    print(f"  Upload:   {UPLOAD_SERVER_URL}")
    print(f"  Polling every {POLL_INTERVAL}s\n")

    while True:
        process_queued()
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
