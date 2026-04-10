#!/usr/bin/env python3
"""
Demo Builder Deploy Agent
~~~~~~~~~~~~~~~~~~~~~~~~~
Lightweight agent that runs on your laptop. Polls Supabase for queued deployments,
executes SQL against MariaDB, pushes images via SCP, and restarts the POS via SSH.

Usage:
    python deploy_agent.py

Environment variables (in .env):
    SUPABASE_URL        — Supabase project URL
    SUPABASE_KEY        — Supabase service role key (or anon key)
    DB_HOST             — MariaDB host (default: 100.112.68.19)
    DB_PORT             — MariaDB port (default: 3306)
    DB_USER             — MariaDB user (default: root)
    DB_PASSWORD         — MariaDB password (default: 123456)
    DB_NAME             — MariaDB database name (default: pecandemodb)
    SSH_HOST            — SSH host for image push + POS restart (default: DB_HOST)
    SSH_USER            — SSH user (default: admin)
    POS_IMAGES_DIR      — POS images directory (default: C:\\Program Files\\Pecan Solutions\\Pecan POS\\images)
    POS_EXE             — POS executable path (default: C:\\Program Files\\Pecan Solutions\\Pecan POS\\Pecan POS.exe)
    POLL_INTERVAL       — Seconds between polls (default: 5)
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
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

TURSO_DATABASE_URL = os.environ.get("TURSO_DATABASE_URL", "").replace("libsql://", "https://")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")
DB_HOST = os.environ.get("DB_HOST", "100.112.68.19")
DB_PORT = int(os.environ.get("DB_PORT", "3306"))
DB_USER = os.environ.get("DB_USER", "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "123456")
DB_NAME = os.environ.get("DB_NAME", "pecandemodb")
SSH_HOST = os.environ.get("SSH_HOST", "")  # defaults to DB_HOST
SSH_USER = os.environ.get("SSH_USER", "admin")
POS_IMAGES_DIR = os.environ.get("POS_IMAGES_DIR", r"C:\Program Files\Pecan Solutions\Pecan POS\images")
POS_EXE = os.environ.get("POS_EXE", r"C:\Program Files\Pecan Solutions\Pecan POS\Pecan POS.exe")
POS_DIR = os.environ.get("POS_DIR", r"C:\Program Files\Pecan Solutions\Pecan POS")
PSEXEC_PATH = os.environ.get("PSEXEC_PATH", r"C:\tools\PsExec64.exe")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))

# ---------------------------------------------------------------------------
# SSH helpers
# ---------------------------------------------------------------------------

def ssh_cmd(host, cmd, user=None, timeout=10):
    """Run a command on a remote machine via SSH. Returns (ok, stdout, stderr)."""
    user = user or SSH_USER
    try:
        result = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
             f"{user}@{host}", cmd],
            capture_output=True, text=True, timeout=timeout,
        )
        return result.returncode == 0, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "", "SSH command timed out"
    except Exception as e:
        return False, "", str(e)


def ssh_available(host, user=None):
    """Check if SSH is reachable."""
    ok, out, _ = ssh_cmd(host, "echo ok", user=user, timeout=6)
    return ok and "ok" in out

# ---------------------------------------------------------------------------
# Turso helpers
# ---------------------------------------------------------------------------

def _turso_arg(v):
    """Convert a Python value to a Turso typed argument."""
    if v is None:
        return {"type": "null"}
    if isinstance(v, bool):
        return {"type": "integer", "value": str(int(v))}
    if isinstance(v, int):
        return {"type": "integer", "value": str(v)}
    if isinstance(v, float):
        return {"type": "float", "value": str(v)}
    return {"type": "text", "value": str(v)}

def turso_execute(sql, args=None):
    """Execute a single SQL statement against Turso. Returns affected_rows_count."""
    stmt = {"sql": sql}
    if args:
        stmt["args"] = [_turso_arg(a) for a in args]
    payload = {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
    r = requests.post(
        f"{TURSO_DATABASE_URL}/v2/pipeline",
        headers={"Authorization": f"Bearer {TURSO_AUTH_TOKEN}", "Content-Type": "application/json"},
        json=payload, timeout=10,
    )
    r.raise_for_status()
    result = r.json()
    res = result["results"][0]
    if res.get("type") == "error":
        raise RuntimeError(res.get("error", {}).get("message", "Turso error"))
    return res.get("response", {}).get("result", {}).get("affected_rows_count", 0)

def turso_query(sql, args=None):
    """Query Turso and return list of dicts."""
    stmt = {"sql": sql}
    if args:
        stmt["args"] = [_turso_arg(a) for a in args]
    payload = {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
    r = requests.post(
        f"{TURSO_DATABASE_URL}/v2/pipeline",
        headers={"Authorization": f"Bearer {TURSO_AUTH_TOKEN}", "Content-Type": "application/json"},
        json=payload, timeout=10,
    )
    r.raise_for_status()
    result = r.json()
    res = result["results"][0]
    if res.get("type") == "error":
        raise RuntimeError(res.get("error", {}).get("message", "Turso error"))
    data = res.get("response", {}).get("result", {})
    cols = [c["name"] for c in data.get("cols", [])]
    rows = []
    for row in data.get("rows", []):
        rows.append({cols[i]: (cell.get("value") if cell.get("type") != "null" else None)
                     for i, cell in enumerate(row)})
    return rows

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
        connection_timeout=10,
    )
    cursor = conn.cursor()
    total_rows = 0

    try:
        cursor.execute("SET FOREIGN_KEY_CHECKS=0")

        for stmt in sql.split(";"):
            # Strip leading comment lines (-- ...) to get to the actual SQL
            lines = stmt.strip().splitlines()
            sql_lines = [l for l in lines if not l.strip().startswith("--")]
            stmt = "\n".join(sql_lines).strip()
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
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        try:
            cursor.close()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass

    return total_rows

# ---------------------------------------------------------------------------
# Image Push (SSH/SCP)
# ---------------------------------------------------------------------------

def push_images_scp(pending_images, host, user=None):
    """Download images from URLs and push to POS via SCP."""
    user = user or SSH_USER
    pushed = 0
    failed = 0

    for img in pending_images:
        try:
            image_url = img.get("image_url") or img.get("imageUrl")
            dest_path = img.get("dest_path") or img.get("destPath")
            if not image_url or not dest_path:
                continue

            # Get image bytes — either decode data URI or download from URL
            if image_url.startswith("data:"):
                # data:image/png;base64,iVBOR...
                _, b64_data = image_url.split(",", 1)
                raw_bytes = base64.b64decode(b64_data)
            else:
                r = requests.get(image_url, timeout=30)
                r.raise_for_status()
                raw_bytes = r.content

            with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(dest_path)[1]) as tmp:
                tmp.write(raw_bytes)
                tmp_path = tmp.name

            # Determine remote path — put in images root or a subfolder
            remote_path = f"{POS_IMAGES_DIR}\\{dest_path}"

            # Ensure subdirectory exists on POS (e.g., Background\, Sidebar\)
            if "\\" in dest_path or "/" in dest_path:
                subdir = os.path.dirname(dest_path).replace("/", "\\")
                remote_dir = f"{POS_IMAGES_DIR}\\{subdir}"
                ssh_cmd(host, f'if not exist "{remote_dir}" mkdir "{remote_dir}"', user=user, timeout=5)

            scp_dest = f"{user}@{host}:\"{remote_path}\""

            result = subprocess.run(
                ["scp", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
                 tmp_path, scp_dest],
                capture_output=True, text=True, timeout=30,
            )

            os.unlink(tmp_path)

            if result.returncode == 0:
                pushed += 1
                print(f"  [IMG] SCP pushed: {dest_path}")
            else:
                failed += 1
                print(f"  [IMG] SCP failed {dest_path}: {result.stderr.strip()}")

        except Exception as e:
            failed += 1
            print(f"  [IMG] Failed {img.get('name', '?')}: {e}")

    return pushed, failed

# ---------------------------------------------------------------------------
# POS Restart (SSH)
# ---------------------------------------------------------------------------

def pos_is_running(host, user=None):
    """Check if POS process is running via SSH."""
    ok, out, _ = ssh_cmd(host, 'tasklist /fi "imagename eq Pecan POS.exe" /fo csv /nh', user=user)
    return ok and "Pecan POS.exe" in out


def ensure_restart_script(host, user=None):
    """Ensure the POS restart VBS script exists on the remote host.

    Uses a VBS wrapper to launch POS via cmd with window style 0 (hidden),
    so no black cmd.exe window appears on screen.
    """
    check = 'if exist C:\\restart_pos.vbs echo EXISTS'
    ok, out, _ = ssh_cmd(host, check, user=user, timeout=5)
    if ok and "EXISTS" in out:
        return True
    # Create via SCP from a temp file
    import tempfile as _tf
    vbs = (
        'Set WshShell = CreateObject("WScript.Shell")\n'
        'WshShell.Run "cmd /c cd /d ""C:\\Program Files\\Pecan Solutions\\Pecan POS"""'
        ' && ""Pecan POS.exe"" --no-sandbox", 0, False\n'
    )
    with _tf.NamedTemporaryFile(mode="w", suffix=".vbs", delete=False) as f:
        f.write(vbs)
        tmp = f.name
    try:
        result = subprocess.run(
            ["scp", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
             tmp, f"{user}@{host}:C:/restart_pos.vbs"],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0
    except Exception as e:
        print(f"  [POS] Failed to create restart script: {e}")
        return False
    finally:
        os.unlink(tmp)


def restart_pos(host, user=None, db_name=None):
    """Restart the POS via SSH: taskkill → PsExec relaunch. Returns result dict.

    Uses PsExec64.exe -i 1 -h to launch the Electron app in the interactive
    desktop session with elevation. The --no-sandbox flag allows the GPU
    process to access the display adapter when launched remotely.
    A VBS wrapper hides the cmd.exe window so only the POS GUI shows.
    """
    user = user or SSH_USER
    result = {"method": "psexec", "pos_restarted": False, "pos_running": False}

    if not ssh_available(host, user):
        result["error"] = "SSH not available"
        print(f"  [POS] SSH not available at {user}@{host}")
        return result

    # Optionally switch database in appsettings.json.
    # Use -EncodedCommand (UTF-16LE base64) to bypass cmd.exe quoting/pipe issues
    # entirely — cmd.exe just sees a single base64 token, no special chars.
    if db_name:
        appsettings = r"C:\Program Files\Pecan Solutions\Pecan POS\resources\api\appsettings.json"
        ps_script = (
            f"$p='{appsettings}'; "
            f"(Get-Content -Raw $p) "
            f"-replace 'Database=[^;\"]+', 'Database={db_name}' "
            f"| Set-Content -NoNewline $p"
        )
        encoded = base64.b64encode(ps_script.encode("utf-16-le")).decode("ascii")
        ps_cmd = f"powershell.exe -NoProfile -EncodedCommand {encoded}"
        ok, _, err = ssh_cmd(host, ps_cmd, user=user, timeout=15)
        if ok:
            print(f"  [POS] Updated appsettings.json → Database={db_name}")
            result["db_switched"] = db_name
        else:
            print(f"  [POS] appsettings update FAILED: {err[:160]}")
            result["error"] = f"appsettings update failed: {err[:160]}"
            return result

    # Kill POS (ignore "not found" — it may not be running)
    ok, out, err = ssh_cmd(host, 'taskkill /f /im "Pecan POS.exe"', user=user)
    if ok:
        print(f"  [POS] Killed POS process")
    elif "not found" in (err + out).lower():
        print(f"  [POS] POS was not running")
    else:
        print(f"  [POS] taskkill: {err or out}")

    time.sleep(2)

    # Ensure VBS launcher exists (hidden cmd window)
    ensure_restart_script(host, user)

    # Detect the active console session ID dynamically (may be 1, 2, etc.).
    # NOTE: `query session` can exit non-zero on success on some Windows builds, and
    # may also write to stderr instead of stdout. So we parse whatever we can capture
    # regardless of the return code.
    session_id = 1
    _, qout, qerr = ssh_cmd(host, "query session", user=user, timeout=10)
    combined = (qout + "\n" + qerr)
    for line in combined.splitlines():
        low = line.lower()
        if "active" in low and "console" in low:
            parts = line.split()
            for part in parts:
                if part.isdigit():
                    session_id = int(part)
                    break
            break
    print(f"  [POS] Using interactive session {session_id}")

    # Launch via PsExec into the active interactive session, elevated.
    # VBS wrapper hides the cmd window; --no-sandbox allows GPU from remote session.
    # NOTE: with -d, PsExec exits with the launched PID as exit code (non-zero),
    # AND PsExec writes status to the console (CONOUT$) which subprocess can't always
    # capture. So we don't trust ssh return codes or stdout/stderr parsing — instead
    # we wait and verify via tasklist that the POS process is actually running.
    launch_cmd = f'{PSEXEC_PATH} -accepteula -i {session_id} -h -d C:\\Windows\\System32\\wscript.exe C:\\restart_pos.vbs'
    ssh_cmd(host, launch_cmd, user=user, timeout=30)
    print(f"  [POS] PsExec invoked (session {session_id})")

    # Wait for Electron + .NET API to spin up, then verify via tasklist.
    # Pecan POS is heavy: Electron main + renderer + GPU + utility + crashpad
    # plus a bundled .NET API. On the demo tablet cold start can take 25-40s.
    # Poll every 5s for up to 60s before giving up.
    deadline = time.time() + 60
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        time.sleep(5)
        if pos_is_running(host, user):
            result["pos_running"] = True
            result["pos_restarted"] = True
            print(f"  [POS] Verified POS running in session {session_id} (attempt {attempt})")
            break
    else:
        result["pos_running"] = False
        result["error"] = "POS process not detected after PsExec launch (60s timeout)"
        print(f"  [POS] POS not running after 60s — check tablet display")

    return result

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def process_queued():
    """Check for and process queued deployments."""
    try:
        rows = turso_query(
            "SELECT id, generated_sql, pending_images, deploy_target FROM sessions WHERE deploy_status = 'queued'",
        )
    except Exception as e:
        print(f"[POLL] Error checking queue: {e}")
        return

    for session in rows:
        sid = session["id"]
        sql = session.get("generated_sql", "")
        pending_images_raw = session.get("pending_images") or "[]"
        pending_images = json.loads(pending_images_raw) if isinstance(pending_images_raw, str) else pending_images_raw
        deploy_target_raw = session.get("deploy_target")
        deploy_target = json.loads(deploy_target_raw) if isinstance(deploy_target_raw, str) and deploy_target_raw else deploy_target_raw

        print(f"\n[DEPLOY] Processing session {sid[:8]}...")

        # Mark as executing
        try:
            turso_execute(
                "UPDATE sessions SET deploy_status = 'executing', updated_at = ? WHERE id = ?",
                [datetime.now(timezone.utc).isoformat(), sid],
            )
        except Exception as e:
            print(f"  [ERROR] Could not update status: {e}")
            continue

        # Resolve SSH host from deploy target
        target_host = (deploy_target or {}).get("host", DB_HOST)
        ssh_host = (deploy_target or {}).get("ssh_host", SSH_HOST or target_host)
        ssh_user = (deploy_target or {}).get("ssh_user", SSH_USER)
        target_db = (deploy_target or {}).get("database", DB_NAME)

        try:
            # Execute SQL
            rows_affected = execute_sql(sql, deploy_target)
            print(f"  [SQL] {rows_affected} rows affected")

            # Push images via SCP
            images_pushed, images_failed = 0, 0
            if pending_images:
                if ssh_available(ssh_host, ssh_user):
                    images_pushed, images_failed = push_images_scp(
                        pending_images, ssh_host, ssh_user,
                    )
                else:
                    print(f"  [IMG] SSH not available — skipping image push")

            # Restart POS
            pos_result = {}
            if ssh_available(ssh_host, ssh_user):
                pos_result = restart_pos(ssh_host, ssh_user, db_name=target_db)
            else:
                print(f"  [POS] SSH not available — skipping POS restart")

            # Mark done
            result = {
                "ok": True,
                "rows_affected": rows_affected,
                "error": None,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "images_pushed": images_pushed,
                "images_failed": images_failed,
                "pos_restarted": pos_result.get("pos_restarted", False),
                "pos_running": pos_result.get("pos_running", False),
            }
            turso_execute(
                "UPDATE sessions SET deploy_status = 'done', deploy_result = ?, updated_at = ? WHERE id = ?",
                [json.dumps(result), datetime.now(timezone.utc).isoformat(), sid],
            )
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
                "pos_restarted": False,
                "pos_running": False,
            }
            try:
                turso_execute(
                    "UPDATE sessions SET deploy_status = 'failed', deploy_result = ?, updated_at = ? WHERE id = ?",
                    [json.dumps(result), datetime.now(timezone.utc).isoformat(), sid],
                )
            except Exception:
                print("  [ERROR] Could not update failure status")


def main():
    if not TURSO_DATABASE_URL or not TURSO_AUTH_TOKEN:
        print("ERROR: Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env")
        sys.exit(1)

    ssh_host = SSH_HOST or DB_HOST
    print(f"Demo Builder Deploy Agent")
    print(f"  Turso:    {TURSO_DATABASE_URL}")
    print(f"  DB:       {DB_HOST}:{DB_PORT}/{DB_NAME}")
    print(f"  SSH:      {SSH_USER}@{ssh_host}")
    print(f"  Polling every {POLL_INTERVAL}s\n")

    # Check SSH on startup
    if ssh_available(ssh_host):
        print(f"  SSH: connected to {ssh_host}")
    else:
        print(f"  SSH: NOT available at {ssh_host} — image push and POS restart disabled")
    print()

    while True:
        process_queued()
        # Update heartbeat on the matching connection record
        try:
            turso_execute(
                "UPDATE connections SET agent_last_seen = ? WHERE host = ?",
                [datetime.now(timezone.utc).isoformat(), DB_HOST],
            )
        except Exception:
            pass
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
