"""
Snapshot HTTP server — exposes read-only POS MariaDB snapshots over the
tailnet so demo-builder browsers can hydrate the Design step without
starting a fresh extraction project ("Load from Tablet" flow).

Started by deploy_agent.main() on a daemon thread. Binds 0.0.0.0:5199 so
any tailnet host can reach it. Tailscale ACLs are the auth boundary.

For browsers on HTTPS origins (demo-builder on Vercel) this server should
be fronted by `tailscale serve` on the Mac to get a real Let's Encrypt
cert at https://aarons-imac-1.tail0f324a.ts.net — otherwise mixed-content
blocks the fetch. One-time setup:

    tailscale serve --bg https / http://127.0.0.1:5199

Endpoints
---------
  GET /healthz
    Returns {"ok": true}. Used by clients to detect the daemon.

  GET /snapshot?host=&port=&db=&user=&password=
    Connects to the target MariaDB directly (mysql.connector), reads the
    tables needed for the Design step, returns JSON. All params optional:
    defaults to the daemon's configured DB target. Images are NOT inlined
    — the client fetches /image separately for each path.

  GET /image?host=&path=&user=
    SSHes to `host` as `user`, reads the file under the POS images dir,
    returns the bytes with an image/* content type. `path` is the
    Windows-relative path stored in menuitems.PicturePath etc. — e.g.
    "Food\\PastramiReuben.png". The server prefixes the POS images root.

Both endpoints respond with Access-Control-Allow-Origin: * so any browser
on the tailnet can fetch directly (the tailnet is the auth layer).
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import mysql.connector

SNAPSHOT_PORT = int(os.environ.get("SNAPSHOT_PORT", "5199"))
POS_IMAGES_ROOT = "C:\\Program Files\\Pecan Solutions\\Pecan POS\\images"


_ssh_cmd_fn = None
_default_ssh_user = "admin"
_default_db = {}


def configure(ssh_cmd_fn, default_ssh_user, default_db):
    """Called once at daemon startup so handlers can reach the daemon's SSH
    helper + default connection params without circular imports."""
    global _ssh_cmd_fn, _default_ssh_user, _default_db
    _ssh_cmd_fn = ssh_cmd_fn
    _default_ssh_user = default_ssh_user
    _default_db = dict(default_db)


def _read_snapshot(host: str, port: int, db: str, user: str, password: str) -> dict:
    conn = mysql.connector.connect(
        host=host, port=port, database=db, user=user, password=password,
        charset="utf8mb4", connect_timeout=8,
    )
    try:
        cur = conn.cursor(dictionary=True)

        cur.execute("SELECT `Key`, Value FROM storesettings")
        store_settings = {r["Key"]: r["Value"] for r in cur.fetchall()}

        cur.execute(
            "SELECT Id, Name, `Index`, PicturePath, Color, GridRows, GridColumns "
            "FROM menugroups WHERE IsDeleted=0 ORDER BY `Index`"
        )
        groups = cur.fetchall()

        cur.execute(
            "SELECT Id, Name, Description, DefaultPrice, IsOpenPriceItem, "
            "MenuGroupId, MenuCategoryId, RowIndex, ColumnIndex, `Index`, "
            "PicturePath, Color, Barcode, IsBarItem, IsWeightedItem, "
            "MenuModifierTemplateId "
            "FROM menuitems WHERE IsDeleted=0 ORDER BY MenuGroupId, `Index`"
        )
        items = cur.fetchall()

        cur.execute(
            "SELECT ssv.Value AS sidebar FROM stationsettingsvalues ssv "
            "JOIN stationsettingsnames ssn ON ssv.NameId = ssn.Id "
            "WHERE ssn.`Key` = 'SidebarPicture' LIMIT 1"
        )
        sidebar_row = cur.fetchone()
        sidebar_picture = sidebar_row["sidebar"] if sidebar_row else None

        cur.close()
    finally:
        conn.close()

    restaurant_name = (
        store_settings.get("RestaurantName")
        or store_settings.get("StoreName")
        or store_settings.get("BusinessName")
        or db
    )

    def _num(v):
        if v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return v

    return {
        "restaurant_name": restaurant_name,
        "database": db,
        "groups": [
            {
                "id": g["Id"],
                "name": g["Name"],
                "index": g["Index"],
                "picture_path": g["PicturePath"],
                "color": g["Color"],
                "grid_rows": g["GridRows"],
                "grid_columns": g["GridColumns"],
            }
            for g in groups
        ],
        "items": [
            {
                "id": it["Id"],
                "name": it["Name"],
                "description": it["Description"],
                "default_price": _num(it["DefaultPrice"]),
                "is_open_price_item": bool(it["IsOpenPriceItem"]),
                "group_id": it["MenuGroupId"],
                "category_id": it["MenuCategoryId"],
                "row_index": it["RowIndex"],
                "column_index": it["ColumnIndex"],
                "index": it["Index"],
                "picture_path": it["PicturePath"],
                "color": it["Color"],
                "barcode": it["Barcode"],
                "is_bar_item": bool(it["IsBarItem"]),
                "is_weighted": bool(it["IsWeightedItem"]),
                "modifier_template_id": it["MenuModifierTemplateId"],
            }
            for it in items
        ],
        "branding": {
            "background": store_settings.get("Background"),
            "buttons_background_color": store_settings.get("ButtonsBackgroundColor"),
            "buttons_font_color": store_settings.get("ButtonsFontColor"),
            "sidebar_picture": sidebar_picture,
        },
        "store_settings": store_settings,
    }


def _fetch_image_bytes(host: str, user: str, rel_path: str) -> tuple[bytes, str]:
    """SSH + type (Windows cat equivalent) to stream a POS image. Returns
    (bytes, content_type)."""
    # Normalize: accept both forward and back slashes from the client.
    rel = rel_path.replace("/", "\\").lstrip("\\")
    full = f"{POS_IMAGES_ROOT}\\{rel}"

    # `type` copies raw bytes to stdout on Windows. We pipe via SSH and
    # capture stdout as bytes (no text mode, no decoding).
    try:
        result = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
             f"{user}@{host}", f'type "{full}"'],
            capture_output=True, timeout=20,
        )
    except subprocess.TimeoutExpired:
        raise TimeoutError("SSH image fetch timed out")

    if result.returncode != 0:
        raise FileNotFoundError(result.stderr.decode("utf-8", errors="replace"))

    ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else "png"
    content_type = {
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml",
        "bmp": "image/bmp",
    }.get(ext, "application/octet-stream")
    return result.stdout, content_type


class _Handler(BaseHTTPRequestHandler):
    # Silence the default stderr access log — we log via print() so the
    # daemon's log file captures everything.
    def log_message(self, fmt, *args):
        print(f"[snapshot] {self.address_string()} - {fmt % args}")

    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}

        try:
            if url.path == "/healthz":
                self._send_json(200, {"ok": True, "service": "snapshot_server"})
                return

            if url.path == "/snapshot":
                host = qs.get("host") or _default_db.get("host")
                port = int(qs.get("port") or _default_db.get("port") or 3306)
                db = qs.get("db") or _default_db.get("database")
                user = qs.get("user") or _default_db.get("user") or "root"
                password = qs.get("password") or _default_db.get("password") or ""

                if not host or not db:
                    self._send_json(400, {"error": "host and db are required"})
                    return

                snap = _read_snapshot(host, port, db, user, password)
                self._send_json(200, snap)
                return

            if url.path == "/image":
                ssh_host = qs.get("host") or _default_db.get("host")
                path = qs.get("path")
                ssh_user = qs.get("user") or _default_ssh_user
                if not ssh_host or not path:
                    self._send_json(400, {"error": "host and path are required"})
                    return

                try:
                    data, ctype = _fetch_image_bytes(ssh_host, ssh_user, path)
                except FileNotFoundError as e:
                    self._send_json(404, {"error": "image not found", "detail": str(e)[:200]})
                    return
                except TimeoutError:
                    self._send_json(504, {"error": "image fetch timed out"})
                    return

                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=300")
                self.end_headers()
                self.wfile.write(data)
                return

            self._send_json(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {"error": str(e)[:500]})


def start_background(default_db: dict, default_ssh_user: str = "admin") -> None:
    """Launch the snapshot server on a daemon thread. Non-blocking."""
    configure(None, default_ssh_user, default_db)

    server = ThreadingHTTPServer(("0.0.0.0", SNAPSHOT_PORT), _Handler)
    t = threading.Thread(target=server.serve_forever, name="snapshot-server", daemon=True)
    t.start()
    print(f"  Snapshot : http://0.0.0.0:{SNAPSHOT_PORT}/  (healthz, snapshot, image)")
