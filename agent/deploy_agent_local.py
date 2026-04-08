#!/usr/bin/env python3
"""
Demo Builder Deploy Agent — Local Mode
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Runs directly on the POS/demo tablet. No SSH, no SCP.
- Writes images straight to the local POS images directory
- Restarts POS via local taskkill + PsExec (still needed to target session 1)
- Connects to localhost MariaDB

Usage:
    python deploy_agent_local.py

Environment variables (in .env next to this file):
    SUPABASE_URL        — Supabase project URL
    SUPABASE_KEY        — Supabase service role key (or anon key)
    DB_HOST             — MariaDB host (default: localhost)
    DB_PORT             — MariaDB port (default: 3306)
    DB_USER             — MariaDB user (default: root)
    DB_PASSWORD         — MariaDB password (default: 123456)
    DB_NAME             — MariaDB database name (default: pecandemodb)
    POS_IMAGES_DIR      — POS images directory
    POS_EXE             — POS executable path
    PSEXEC_PATH         — Path to PsExec64.exe
    POLL_INTERVAL       — Seconds between polls (default: 5)
"""

import base64
import json
import logging
import os
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

import mysql.connector
import requests

# ---------------------------------------------------------------------------
# Logging — always write to agent.log next to this script, regardless of how
# the process was launched (WMI, PsExec, schtasks — stdout redirect unreliable)
# ---------------------------------------------------------------------------
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.info
log_err = logging.error

# Monkey-patch print so existing print() calls also go to the log
import builtins as _builtins
_orig_print = _builtins.print
def _log_print(*args, **kwargs):
    kwargs.pop("file", None)
    _orig_print(*args, **kwargs)
    logging.info(" ".join(str(a) for a in args))
_builtins.print = _log_print

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
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

load_env()

SUPABASE_URL  = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY  = os.environ.get("SUPABASE_KEY", "")
DB_HOST       = os.environ.get("DB_HOST", "localhost")
DB_PORT       = int(os.environ.get("DB_PORT", "3306"))
DB_USER       = os.environ.get("DB_USER", "root")
DB_PASSWORD   = os.environ.get("DB_PASSWORD", "123456")
DB_NAME       = os.environ.get("DB_NAME", "pecandemodb")
POS_IMAGES_DIR = os.environ.get("POS_IMAGES_DIR", r"C:\Program Files\Pecan Solutions\Pecan POS\images")
POS_DIR       = os.environ.get("POS_DIR", r"C:\Program Files\Pecan Solutions\Pecan POS")
POS_EXE       = os.environ.get("POS_EXE", r"C:\Program Files\Pecan Solutions\Pecan POS\Pecan POS.exe")
PSEXEC_PATH   = os.environ.get("PSEXEC_PATH", r"C:\tools\PsExec64.exe")
RESTART_VBS   = os.environ.get("RESTART_VBS", r"C:\restart_pos.vbs")
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
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"},
                     params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def supabase_patch(table, match, data, retries=5, backoff=4):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    for attempt in range(retries):
        try:
            r = requests.patch(url, headers=HEADERS, params=match, json=data, timeout=15)
            r.raise_for_status()
            return
        except Exception as e:
            if attempt < retries - 1:
                wait = backoff * (attempt + 1)
                print(f"  [WARN] Supabase patch failed (attempt {attempt+1}/{retries}), retrying in {wait}s: {e}")
                time.sleep(wait)
            else:
                raise

# ---------------------------------------------------------------------------
# SQL Execution
# ---------------------------------------------------------------------------

def execute_sql(sql, deploy_target=None):
    host     = deploy_target.get("host", DB_HOST)     if deploy_target else DB_HOST
    port     = deploy_target.get("port", DB_PORT)     if deploy_target else DB_PORT
    user     = deploy_target.get("user", DB_USER)     if deploy_target else DB_USER
    password = deploy_target.get("password", DB_PASSWORD) if deploy_target else DB_PASSWORD
    database = deploy_target.get("database", DB_NAME) if deploy_target else DB_NAME

    conn = mysql.connector.connect(
        host=host, port=port, user=user, password=password,
        database=database, autocommit=False,
    )
    cursor = conn.cursor()
    total_rows = 0
    try:
        cursor.execute("SET FOREIGN_KEY_CHECKS=0")
        for stmt in sql.split(";"):
            lines = stmt.strip().splitlines()
            stmt = "\n".join(l for l in lines if not l.strip().startswith("--")).strip()
            if not stmt:
                continue
            try:
                cursor.execute(stmt)
                total_rows += cursor.rowcount if cursor.rowcount > 0 else 0
            except mysql.connector.Error as e:
                print(f"  [WARN] Statement failed: {e.msg[:100]}")
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
# Image Push — direct local filesystem write
# ---------------------------------------------------------------------------

def push_images_local(pending_images):
    pushed = 0
    failed = 0
    for img in pending_images:
        try:
            image_url = img.get("image_url") or img.get("imageUrl")
            dest_path = img.get("dest_path") or img.get("destPath")
            if not image_url or not dest_path:
                continue

            # Decode or download image bytes
            if image_url.startswith("data:"):
                _, b64_data = image_url.split(",", 1)
                raw_bytes = base64.b64decode(b64_data)
            else:
                r = requests.get(image_url, timeout=30)
                r.raise_for_status()
                raw_bytes = r.content

            # Build local path
            local_path = os.path.join(POS_IMAGES_DIR, dest_path.replace("/", "\\"))
            os.makedirs(os.path.dirname(local_path), exist_ok=True)

            with open(local_path, "wb") as f:
                f.write(raw_bytes)

            pushed += 1
            print(f"  [IMG] Written: {local_path}")

        except Exception as e:
            failed += 1
            print(f"  [IMG] Failed {img.get('name', '?')}: {e}")

    return pushed, failed

# ---------------------------------------------------------------------------
# POS Restart — local, no SSH
# ---------------------------------------------------------------------------

def ensure_restart_vbs():
    """Write the VBS launcher to disk if it doesn't exist."""
    if os.path.exists(RESTART_VBS):
        return
    vbs = (
        'Set WshShell = CreateObject("WScript.Shell")\n'
        f'WshShell.Run "cmd /c cd /d ""{POS_DIR}"" && ""Pecan POS.exe"" --no-sandbox", 0, False\n'
    )
    try:
        with open(RESTART_VBS, "w") as f:
            f.write(vbs)
        print(f"  [POS] Created {RESTART_VBS}")
    except Exception as e:
        print(f"  [POS] Could not create restart VBS: {e}")


def update_appsettings(db_name):
    """Switch the database in appsettings.json using PowerShell."""
    appsettings = os.path.join(POS_DIR, r"resources\api\appsettings.json")
    if not os.path.exists(appsettings):
        print(f"  [POS] appsettings.json not found at {appsettings}")
        return
    ps = (
        f"(Get-Content '{appsettings}') "
        f"-replace 'Database=[^;]+?(?=[;\\\"])', 'Database={db_name}' "
        f"| Set-Content '{appsettings}'"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            print(f"  [POS] appsettings.json → Database={db_name}")
        else:
            print(f"  [POS] appsettings update warning: {result.stderr.strip()[:80]}")
    except Exception as e:
        print(f"  [POS] appsettings update failed: {e}")


def pos_is_running():
    try:
        result = subprocess.run(
            ["tasklist", "/fi", "imagename eq Pecan POS.exe", "/fo", "csv", "/nh"],
            capture_output=True, text=True, timeout=5,
        )
        return "Pecan POS.exe" in result.stdout
    except Exception:
        return False


def restart_pos_local(db_name=None):
    result = {"method": "local", "pos_restarted": False, "pos_running": False}

    if db_name:
        update_appsettings(db_name)

    # Kill POS
    try:
        subprocess.run(
            ["taskkill", "/f", "/im", "Pecan POS.exe"],
            capture_output=True, text=True, timeout=10,
        )
        print("  [POS] Killed POS process")
    except Exception as e:
        print(f"  [POS] taskkill: {e}")

    time.sleep(2)

    # Ensure VBS launcher
    ensure_restart_vbs()

    # Launch via PsExec into interactive session 1, elevated
    # Even running locally, we need -i 1 so the Electron app gets the display
    try:
        r = subprocess.run(
            [PSEXEC_PATH, "-accepteula", "-i", "1", "-h", "-d",
             "wscript.exe", RESTART_VBS],
            capture_output=True, text=True, timeout=15,
        )
        combined = (r.stdout + " " + r.stderr).lower()
        if "started on" in combined or r.returncode == 0:
            print("  [POS] Launched via PsExec (session 1, elevated, --no-sandbox)")
            result["pos_restarted"] = True
        else:
            result["error"] = f"PsExec: {r.stderr[:200]}"
            print(f"  [POS] PsExec failed: {r.stderr[:200]}")
            return result
    except Exception as e:
        result["error"] = str(e)
        print(f"  [POS] Launch failed: {e}")
        return result

    time.sleep(8)
    result["pos_running"] = pos_is_running()
    if result["pos_running"]:
        print("  [POS] Verified running in console session")
    else:
        print("  [POS] Warning: process not detected after restart")

    return result

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def heartbeat():
    """Update agent_last_seen on the active connection row so the UI can detect us."""
    try:
        rows = supabase_get("connections", {"select": "id", "limit": "1"})
        if rows:
            conn_id = rows[0]["id"]
            supabase_patch(
                "connections",
                {"id": f"eq.{conn_id}"},
                {"agent_last_seen": datetime.now(timezone.utc).isoformat()},
                retries=1,
                backoff=2,
            )
    except Exception:
        pass  # heartbeat failure is non-fatal


def process_queued():
    heartbeat()
    try:
        rows = supabase_get("sessions", {
            "deploy_status": "eq.queued",
            "select": "id,generated_sql,pending_images,deploy_target",
        })
    except Exception as e:
        print(f"[POLL] Error checking queue: {e}")
        return

    for session in rows:
        sid            = session["id"]
        sql            = session.get("generated_sql", "")
        pending_images = session.get("pending_images") or []
        deploy_target  = session.get("deploy_target")

        print(f"\n[DEPLOY] Processing session {sid[:8]}...")

        try:
            supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                "deploy_status": "executing",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as e:
            print(f"  [ERROR] Could not update status: {e}")
            continue

        target_db = (deploy_target or {}).get("database", DB_NAME)

        try:
            rows_affected = execute_sql(sql, deploy_target)
            print(f"  [SQL] {rows_affected} rows affected")

            images_pushed, images_failed = 0, 0
            if pending_images:
                images_pushed, images_failed = push_images_local(pending_images)

            pos_result = restart_pos_local(db_name=target_db)

            result = {
                "ok": True,
                "rows_affected": rows_affected,
                "error": None,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "images_pushed": images_pushed,
                "images_failed": images_failed,
                "pos_restarted": pos_result.get("pos_restarted", False),
                "pos_running": pos_result.get("pos_running", False),
                "mode": "local",
            }
            supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                "deploy_status": "done",
                "deploy_result": json.dumps(result),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            print("  [DONE] Success!")

        except Exception as e:
            print(f"  [FAIL] {e}")
            traceback.print_exc()
            try:
                supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                    "deploy_status": "failed",
                    "deploy_result": json.dumps({
                        "ok": False, "error": str(e)[:500],
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "mode": "local",
                    }),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: Set SUPABASE_URL and SUPABASE_KEY in .env")
        sys.exit(1)

    print("Demo Builder Deploy Agent — LOCAL MODE")
    print(f"  Supabase: {SUPABASE_URL}")
    print(f"  DB:       {DB_HOST}:{DB_PORT}/{DB_NAME}")
    print(f"  Images:   {POS_IMAGES_DIR}")
    print(f"  PsExec:   {PSEXEC_PATH}")
    print(f"  Polling every {POLL_INTERVAL}s\n")

    if not os.path.exists(PSEXEC_PATH):
        print(f"WARNING: PsExec not found at {PSEXEC_PATH} — POS restart will fail")
    if not os.path.exists(POS_IMAGES_DIR):
        print(f"WARNING: POS images dir not found: {POS_IMAGES_DIR}")

    while True:
        process_queued()
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
