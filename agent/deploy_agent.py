#!/usr/bin/env python3
"""
Demo Builder Deploy Agent
~~~~~~~~~~~~~~~~~~~~~~~~~
Runs on the Mac. Polls Supabase for queued deployments, executes the
generated SQL against MariaDB on the demo tablet, pushes branding/item
images via SCP, then restarts the POS via SSH + PsExec.

Usage:
    python deploy_agent.py

Environment variables (in .env):
    SUPABASE_URL        — Supabase project URL
    SUPABASE_KEY        — Supabase service role key
    DB_HOST             — MariaDB host (default: 100.112.68.19)
    DB_PORT             — MariaDB port (default: 3306)
    DB_USER             — MariaDB user (default: root)
    DB_PASSWORD         — MariaDB password (default: 123456)
    DB_NAME             — MariaDB database name (default: pecandemodb)
    SSH_HOST            — SSH host for image push + POS restart (default: DB_HOST)
    SSH_USER            — SSH user (default: admin)
    POS_IMAGES_DIR      — POS images directory
    PSEXEC_PATH         — Path to PsExec64.exe on the POS machine
    POLL_INTERVAL       — Seconds between polls (default: 5)
"""

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

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

SUPABASE_URL  = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY  = os.environ.get("SUPABASE_KEY", "")
DB_HOST       = os.environ.get("DB_HOST", "100.112.68.19")
DB_PORT       = int(os.environ.get("DB_PORT", "3306"))
DB_USER       = os.environ.get("DB_USER", "root")
DB_PASSWORD   = os.environ.get("DB_PASSWORD", "123456")
DB_NAME       = os.environ.get("DB_NAME", "pecandemodb")
SSH_HOST      = os.environ.get("SSH_HOST", "")   # defaults to DB_HOST if empty
SSH_USER      = os.environ.get("SSH_USER", "admin")
POS_IMAGES_DIR = os.environ.get("POS_IMAGES_DIR", r"C:\Program Files\Pecan Solutions\Pecan POS\images")
PSEXEC_PATH   = os.environ.get("PSEXEC_PATH", r"C:\tools\PsExec64.exe")
POLL_INTERVAL        = int(os.environ.get("POLL_INTERVAL", "5"))
DEMO_BUILDER_API_URL = os.environ.get("DEMO_BUILDER_API_URL", "http://localhost:3002")
SNAPSHOT_DIR         = os.path.expanduser(os.environ.get("SNAPSHOT_DIR", "~/Projects/demo-DBs"))

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
    "Accept-Profile": "demo_builder",
    "Content-Profile": "demo_builder",
}

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
    """Check if SSH is reachable. Returns bool."""
    ok, out, _ = ssh_cmd(host, "echo ok", user=user, timeout=6)
    return ok and "ok" in out

# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def supabase_get(table, params=None):
    """GET rows from Supabase REST API. Raises on HTTP error."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"},
                     params=params, timeout=10)
    r.raise_for_status()
    return r.json()


def supabase_patch(table, match, data):
    """PATCH a row in Supabase. Raises on HTTP error."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.patch(url, headers=HEADERS, params=match, json=data, timeout=10)
    r.raise_for_status()

# ---------------------------------------------------------------------------
# Snapshot helpers (batch generation)
# ---------------------------------------------------------------------------

def get_snapshot_path(name, pt_record_id, allow_versioning=False):
    """Return the local .sql path for a snapshot.

    allow_versioning=False (batch): always return base path; caller must not
    overwrite — the batch queue route already skips existing done sessions.
    allow_versioning=True (manual re-gen): increment _vN suffix so old files
    are preserved.
    """
    import re as _re
    slug = _re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:40]
    short_id = pt_record_id.replace("-", "")[:8]
    base = f"{slug}_{short_id}"
    base_path = os.path.join(SNAPSHOT_DIR, f"{base}.sql")

    if not allow_versioning or not os.path.exists(base_path):
        return base_path

    v = 2
    while os.path.exists(os.path.join(SNAPSHOT_DIR, f"{base}_v{v}.sql")):
        v += 1
    return os.path.join(SNAPSHOT_DIR, f"{base}_v{v}.sql")


def save_snapshot(pt_record_id, name, session_id, sql, allow_versioning=False):
    """Write a generated SQL file to SNAPSHOT_DIR and update snapshot_index.json."""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    path = get_snapshot_path(name, pt_record_id, allow_versioning)

    with open(path, "w", encoding="utf-8") as f:
        f.write(sql)
    print(f"  [SNAP] Saved: {path}")

    index_path = os.path.join(SNAPSHOT_DIR, "snapshot_index.json")
    try:
        if os.path.exists(index_path):
            with open(index_path) as f:
                index = json.load(f)
        else:
            index = {"version": "1", "snapshots": []}

        index["snapshots"].append({
            "prospect_id": pt_record_id,
            "name": name,
            "file": path,
            "session_id": session_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "ready",
        })

        with open(index_path, "w") as f:
            json.dump(index, f, indent=2)
    except Exception as e:
        print(f"  [SNAP] Could not update index: {e}")

    return path

# ---------------------------------------------------------------------------
# JS-page / Cloudflare fallback helpers
# ---------------------------------------------------------------------------

# Error phrases from extract-url that indicate a JS-rendered page (not a hard failure)
_JS_CONTENT_ERRORS = (
    "too little content",
    "no menu items",
    "inaccessible or empty",
    "blocking automated requests",
    "invalid json",          # AI got CF challenge page / garbled HTML, couldn't parse
    "extraction failed",     # catch-all for HTTP 500 from extract-url
)

_CF_PHRASES = ("security verification", "security service to protect")

# Menu URL discovery constants
_MENU_HREF_KW   = ("/menu", "/menus", "/food", "/our-menu", "/food-menu", "/dining")
_MENU_TEXT_KW   = ("menu", "food", "eat", "dine", "dining", "order online")
_PLATFORM_HOSTS = (
    "toasttab.com", "order.squareup.com", "popmenu.com",
    "bentobox.com", "olo.com", "chownow.com", "menudrive.com",
)
_PDF_RE = re.compile(r'\.pdf(\?|$)', re.IGNORECASE)
# Common menu page paths probed when nav-link discovery finds nothing.
# Ordered by specificity — most sites use /menu or /food-menu.
_COMMON_MENU_PATHS = ("/food-menu", "/menus", "/menu", "/our-menu", "/dining-menu")


def _extract_ldjson_menu_text(html: str) -> str:
    """Pull schema.org Menu ld+json from HTML and return a readable menu text block.

    Many restaurant platforms (Popmenu, BentoBox, etc.) embed structured menu data
    for SEO. This is cleaner than parsing arbitrary HTML and works even when the page
    is a React SPA (items are server-rendered into ld+json for crawlers).
    """
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL)
    lines = []
    for block in blocks:
        try:
            data = json.loads(block)
        except Exception:
            continue
        if data.get("@type") not in ("Menu", "MenuSection"):
            continue
        menu_name = data.get("name", "Menu")
        for section in data.get("hasMenuSection", [data]):  # data itself if it's a MenuSection
            section_name = section.get("name", "")
            header = f"{menu_name} — {section_name}" if section_name != menu_name else menu_name
            lines.append(f"\n## {header}")
            for item in section.get("hasMenuItem", []):
                name = item.get("name", "")
                price = item.get("offers", {}).get("price", "")
                desc = item.get("description", "")
                line = f"{name}"
                if price:
                    line += f" — ${price}"
                if desc:
                    line += f"\n  {desc}"
                lines.append(line)
    return "\n".join(lines).strip()


def fetch_page_text_curl_cffi(url: str):
    """Fetch page HTML using a real Chrome TLS fingerprint, bypassing Cloudflare's
    TLS-based bot detection. Extracts schema.org ld+json menu data if present,
    otherwise falls back to stripped visible text.

    Returns None if curl_cffi is not installed or the page is still bot-blocked.
    """
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        print("  [CF] curl_cffi not installed — skipping TLS-bypass fallback")
        print("       To enable: pip3 install curl_cffi")
        return None
    try:
        resp = cffi_requests.get(url, impersonate="chrome", timeout=30)
        html = resp.text

        # Detect CF challenge page (some CF configs survive TLS spoofing)
        if any(p in html.lower() for p in _CF_PHRASES):
            print(f"  [CF] Cloudflare challenge still active — curl_cffi couldn't bypass")
            return None

        # Try structured ld+json first — cleanest possible input for menu extraction
        ldjson_text = _extract_ldjson_menu_text(html)
        if ldjson_text and len(ldjson_text) > 100:
            print(f"  [CF] Got {len(ldjson_text)} chars from ld+json structured data")
            return ldjson_text[:40_000]

        # Fall back to stripped visible text
        from html.parser import HTMLParser
        class _Stripper(HTMLParser):
            def __init__(self):
                super().__init__()
                self.parts = []
                self._skip = False
            def handle_starttag(self, tag, attrs):
                if tag in ("script", "style", "noscript"):
                    self._skip = True
            def handle_endtag(self, tag):
                if tag in ("script", "style", "noscript"):
                    self._skip = False
            def handle_data(self, data):
                if not self._skip and data.strip():
                    self.parts.append(data.strip())
        s = _Stripper()
        s.feed(html)
        text = "\n".join(s.parts).strip()[:40_000]
        if text and len(text) > 100:
            print(f"  [CF] Got {len(text)} chars of stripped HTML text")
            return text
        return None
    except Exception as e:
        print(f"  [CF] curl_cffi failed: {e}")
        return None

def fetch_page_text_playwright(url: str, timeout_ms: int = 30_000):
    """Open url in headless Chromium, wait for JS to render, return body text.

    Returns None if playwright is not installed or the fetch fails — callers
    should treat None as 'fallback unavailable' and leave the job failed.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("  [PW] playwright not installed — skipping JS fallback")
        print("       To enable: pip3 install playwright && python3 -m playwright install chromium")
        return None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            # Use domcontentloaded (not networkidle) — many restaurant sites have
            # persistent analytics/ads that never reach networkidle
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            # Give JS 5 seconds to render dynamic menu content after DOM load
            page.wait_for_timeout(5_000)
            text = page.inner_text("body")
            browser.close()
            trimmed = text.strip()[:40_000]
            # Detect Cloudflare bot challenge — bail early rather than sending
            # 278 chars of "Performing security verification" to the AI
            if "security verification" in trimmed.lower() or "security service to protect" in trimmed.lower():
                print(f"  [PW] Cloudflare bot protection detected — cannot scrape")
                return None
            print(f"  [PW] Got {len(trimmed)} chars from {url}")
            return trimmed or None
    except Exception as e:
        print(f"  [PW] Playwright fetch failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Menu URL discovery
# ---------------------------------------------------------------------------

def discover_menu_url(homepage_url: str) -> dict:
    """Resolve a restaurant URL to its actual menu page before extraction.

    Many PT records store a homepage URL. This function fetches that page,
    checks for ld+json Menu data, and if absent scans nav links to find the
    menu page. Returns a dict {"type": str, "url": str} where type is:
      "ldjson"    — homepage already has ld+json Menu items (use url as-is)
      "html"      — nav link found pointing to an HTML menu page
      "platform"  — nav link points to a known ordering platform (Toast, etc.)
      "pdf"       — nav link points to a PDF
      "not_found" — no menu link identified; caller should try homepage url
    Never raises — any exception returns {"type": "not_found", "url": homepage_url}.
    """
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        return {"type": "not_found", "url": homepage_url}

    try:
        resp = cffi_requests.get(homepage_url, impersonate="chrome", timeout=30)
        html = resp.text

        if any(p in html.lower() for p in _CF_PHRASES):
            print(f"  [DISC] Cloudflare on homepage — skipping discovery")
            return {"type": "not_found", "url": homepage_url}

        # If the homepage itself has ld+json menu items, use it directly
        if len(_extract_ldjson_menu_text(html)) > 100:
            print(f"  [DISC] ld+json Menu found on homepage")
            return {"type": "ldjson", "url": homepage_url}

        # Parse all <a> tags and score candidates
        from html.parser import HTMLParser

        class _LinkParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.links = []          # [(href, anchor_text)]
                self._href = None
                self._text = []
            def handle_starttag(self, tag, attrs):
                if tag == "a":
                    self._href = dict(attrs).get("href", "")
                    self._text = []
            def handle_endtag(self, tag):
                if tag == "a" and self._href:
                    self.links.append((self._href, " ".join(self._text).strip()))
                    self._href = None
            def handle_data(self, data):
                if self._href is not None:
                    self._text.append(data.strip())

        parser = _LinkParser()
        parser.feed(html)

        best_href, best_score = None, 0
        for href, text in parser.links:
            if not href or href.startswith(("#", "mailto:", "tel:")):
                continue
            abs_href = urljoin(homepage_url, href)
            path = urlparse(abs_href).path.lower()
            text_lower = text.lower()

            score = 0
            for kw in _MENU_HREF_KW:
                if path in (kw, kw + "/"):
                    score = max(score, 10)
                elif path.startswith(kw):
                    score = max(score, 7)
            if any(kw in path for kw in _MENU_HREF_KW):
                score = max(score, 5)
            if any(kw in text_lower for kw in _MENU_TEXT_KW):
                score = max(score, 3)

            if score > best_score:
                best_score, best_href = score, abs_href

        if not best_href or best_score == 0:
            # Nav link scoring found nothing. Try probing common menu paths
            # directly — many sites (e.g. Popmenu) don't link their menu page
            # from the homepage nav with obvious keywords.
            base = f"{urlparse(homepage_url).scheme}://{urlparse(homepage_url).netloc}"
            for path in _COMMON_MENU_PATHS:
                probe_url = base + path
                try:
                    r2 = cffi_requests.get(probe_url, impersonate="chrome", timeout=10)
                    if r2.status_code == 200 and len(_extract_ldjson_menu_text(r2.text)) > 100:
                        print(f"  [DISC] Common-path probe hit: {probe_url}")
                        return {"type": "ldjson", "url": probe_url}
                except Exception:
                    pass
            print(f"  [DISC] No menu link found — will try homepage directly")
            return {"type": "not_found", "url": homepage_url}

        parsed = urlparse(best_href)
        if _PDF_RE.search(best_href):
            print(f"  [DISC] PDF menu detected: {best_href}")
            return {"type": "pdf", "url": best_href}
        if any(h in parsed.netloc for h in _PLATFORM_HOSTS):
            print(f"  [DISC] Platform URL: {best_href}")
            return {"type": "platform", "url": best_href}

        print(f"  [DISC] Menu URL: {best_href}")
        return {"type": "html", "url": best_href}

    except Exception as e:
        print(f"  [DISC] Discovery error: {e}")
        return {"type": "not_found", "url": homepage_url}


def extract_ldjson_full_menu(menu_url: str):
    """Fetch all menu sections concurrently and return merged ld+json menu text.

    Fetches the menu page, extracts ld+json from the first section, then
    discovers and concurrently fetches all linked section pages (same-domain
    /menus/* pattern — used by Popmenu and similar platforms). Returns merged
    text (up to 40,000 chars) or None if fewer than 100 chars of menu content.
    """
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        return None

    def _fetch_section(url: str) -> str:
        try:
            r = cffi_requests.get(url, impersonate="chrome", timeout=20)
            return _extract_ldjson_menu_text(r.text)
        except Exception:
            return ""

    try:
        resp = cffi_requests.get(menu_url, impersonate="chrome", timeout=30)
        html = resp.text

        if any(p in html.lower() for p in _CF_PHRASES):
            return None

        first_text = _extract_ldjson_menu_text(html)

        # Discover additional section URLs — same domain, /menus/* path pattern
        base = urlparse(menu_url)
        seen = {menu_url}
        section_urls = []
        for href in re.findall(r'href=["\']([^"\']+)["\']', html):
            abs_url = urljoin(menu_url, href)
            p = urlparse(abs_url)
            if p.netloc == base.netloc and "/menus/" in p.path and abs_url not in seen:
                section_urls.append(abs_url)
                seen.add(abs_url)

        section_texts = [first_text]
        if section_urls:
            with ThreadPoolExecutor(max_workers=8) as pool:
                section_texts.extend(pool.map(_fetch_section, section_urls))

        merged = "\n\n".join(t for t in section_texts if t).strip()
        item_count = merged.count(" — $")  # rough proxy: "Name — $price" lines
        print(f"  [LD] {len([t for t in section_texts if t])} sections, "
              f"~{item_count} items, {len(merged)} chars")

        return merged[:40_000] if len(merged) > 100 else None

    except Exception as e:
        print(f"  [LD] Full menu extraction failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Batch generation queue
# ---------------------------------------------------------------------------

def _handle_process_result(job: dict, jid: str, result: dict, label: str) -> bool:
    """Handle a /api/batch/process response: save snapshot on success, log either way.

    Returns True on success (caller should `continue` to next job),
    False on failure (caller handles marking the job failed).
    """
    if result.get("ok"):
        session_id = result["session_id"]
        try:
            sessions = supabase_get("sessions", {
                "id": f"eq.{session_id}",
                "select": "generated_sql",
            })
            if sessions and sessions[0].get("generated_sql"):
                save_snapshot(
                    job["pt_record_id"],
                    job["name"],
                    session_id,
                    sessions[0]["generated_sql"],
                    allow_versioning=False,
                )
        except Exception as e:
            print(f"  [SNAP] Could not save local snapshot: {e}")
        stats = result.get("stats", {})
        print(f"  [{label}] Done — session {session_id[:8]}, {stats}")
        return True

    error_msg = result.get("error", "Unknown error")
    print(f"  [{label}] Failed: {error_msg}")
    return False


def process_generate_queue():
    """Poll batch_queue for queued jobs and orchestrate the full extraction pipeline.

    Extraction priority per job:
      1. discover_menu_url — resolve homepage → actual menu page; detect PDFs
      2. extract_ldjson_full_menu — concurrent multi-section ld+json (free, no AI)
      3. /api/batch/process (Vercel fetch) — let Vercel try the discovered URL
      4. curl_cffi fallback — Chrome TLS fingerprint, bypasses Cloudflare
      5. Playwright fallback — headless browser for JS-rendered SPAs
    PDF menus are marked `needs_pdf` and skipped for the second vision queue.
    """
    if not DEMO_BUILDER_API_URL:
        return

    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.queued",
            "select": "id,pt_record_id,name,menu_url",
            "limit": "3",
        })
    except Exception as e:
        print(f"[GEN] Supabase error: {e}")
        return

    for job in rows:
        jid  = job["id"]
        name = job["name"]
        print(f"\n[GEN] Job {jid[:8]}  {name}")

        # ── Claim job ──────────────────────────────────────────────────────────
        try:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "processing",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as e:
            print(f"  [ERROR] Could not claim job: {e}")
            continue

        try:
            # ── Discover actual menu URL ───────────────────────────────────────
            discovery = discover_menu_url(job["menu_url"])

            if discovery["type"] == "pdf":
                # BUSINESS RULE: PDF menus are expensive (Sonnet vision). Skip in
                # the mechanical batch pass; a separate queue handles them later.
                supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                    "status": "needs_pdf",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
                print(f"  [PDF] Skipped — menu is a PDF, marked needs_pdf")
                continue

            menu_url = discovery["url"]

            # Persist discovered URL so retries don't re-discover from scratch
            if menu_url != job["menu_url"]:
                supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                    "menu_url": menu_url,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })

            error_msg = "Unknown error"

            # ── Try full ld+json extraction (free, no AI fetch) ────────────────
            raw_text = extract_ldjson_full_menu(menu_url)
            if raw_text:
                resp = requests.post(
                    f"{DEMO_BUILDER_API_URL}/api/batch/process",
                    json={"queue_id": jid, "raw_text": raw_text},
                    timeout=310,
                )
                result = resp.json()
                if _handle_process_result(job, jid, result, "LD"):
                    continue
                # ld+json was present but AI couldn't extract items — fall through
                # to Vercel fetch which may find menu data via other means
                error_msg = result.get("error", "ld+json extraction failed")

            # ── Let Vercel fetch the discovered URL ────────────────────────────
            resp = requests.post(
                f"{DEMO_BUILDER_API_URL}/api/batch/process",
                json={"queue_id": jid},
                timeout=310,
            )
            result = resp.json()
            if _handle_process_result(job, jid, result, "GEN"):
                continue

            error_msg = result.get("error", "Unknown error")

            # ── Fallback chain: curl_cffi → Playwright ─────────────────────────
            is_js_failure = any(h in error_msg.lower() for h in _JS_CONTENT_ERRORS)
            if is_js_failure:
                raw_text = None
                print(f"  [CF] Trying curl_cffi (Chrome TLS fingerprint)...")
                raw_text = fetch_page_text_curl_cffi(menu_url)

                if not raw_text:
                    print(f"  [PW] Trying Playwright (headless Chromium)...")
                    raw_text = fetch_page_text_playwright(menu_url)

                if raw_text and len(raw_text) > 100:
                    supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                        "status": "processing",
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    })
                    resp2 = requests.post(
                        f"{DEMO_BUILDER_API_URL}/api/batch/process",
                        json={"queue_id": jid, "raw_text": raw_text},
                        timeout=310,
                    )
                    result = resp2.json()
                    if _handle_process_result(job, jid, result, "RETRY"):
                        continue
                    error_msg = result.get("error", "Fallback retry failed")
                else:
                    print("  [RETRY] Both fallbacks returned no usable text")

            # ── Mark failed ────────────────────────────────────────────────────
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": error_msg[:500],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })

        except requests.Timeout:
            err = "API call timed out after 310s"
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": err,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            print(f"  [GEN] Timeout for job {jid[:8]}")

        except Exception as e:
            try:
                supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                    "status": "failed",
                    "error": str(e)[:500],
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass
            print(f"  [GEN] Error: {e}")

# ---------------------------------------------------------------------------
# SQL Execution
# ---------------------------------------------------------------------------

def execute_sql(sql, deploy_target=None):
    """Execute generated SQL against MariaDB. Returns total rows affected."""
    host     = (deploy_target or {}).get("host",     DB_HOST)
    port     = (deploy_target or {}).get("port",     DB_PORT)
    user     = (deploy_target or {}).get("user",     DB_USER)
    password = (deploy_target or {}).get("password", DB_PASSWORD)
    database = (deploy_target or {}).get("database", DB_NAME)

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
            # Strip comment-only lines before checking for emptiness
            lines = stmt.strip().splitlines()
            code_lines = [l for l in lines if not l.strip().startswith("--")]
            stmt = "\n".join(code_lines).strip()
            if not stmt:
                continue
            try:
                cursor.execute(stmt)
                if cursor.rowcount > 0:
                    total_rows += cursor.rowcount
            except mysql.connector.Error as e:
                print(f"  [WARN] Statement failed: {e.msg[:120]}")

        cursor.execute("SET FOREIGN_KEY_CHECKS=1")
        conn.commit()

    except Exception:
        try:
            cursor.execute("SET FOREIGN_KEY_CHECKS=1")  # restore before rollback
        except Exception:
            pass
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
# Image Push (SCP)
# ---------------------------------------------------------------------------

def push_images_scp(pending_images, host, user=None):
    """Download images (from URL or data URI) and push to POS via SCP."""
    user = user or SSH_USER
    pushed = 0
    failed = 0

    for img in pending_images:
        tmp_path = None
        try:
            image_url = img.get("image_url") or img.get("imageUrl")
            dest_path = img.get("dest_path") or img.get("destPath")
            if not image_url or not dest_path:
                print(f"  [IMG] Skipping entry with missing url or dest_path: {img.get('name', '?')}")
                continue

            # Fetch bytes — data URI or HTTP URL
            if image_url.startswith("data:"):
                _, b64_data = image_url.split(",", 1)
                raw_bytes = base64.b64decode(b64_data)
            else:
                r = requests.get(image_url, timeout=30)
                r.raise_for_status()
                raw_bytes = r.content

            # Write to a local temp file, then SCP it
            suffix = os.path.splitext(dest_path)[1] or ".png"
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(raw_bytes)
                tmp_path = tmp.name

            remote_path = f"{POS_IMAGES_DIR}\\{dest_path}"

            # Create subdirectory on POS if needed (one level, e.g. Background\)
            subdir = os.path.dirname(dest_path).replace("/", "\\")
            if subdir:
                remote_dir = f"{POS_IMAGES_DIR}\\{subdir}"
                ssh_cmd(host, f'if not exist "{remote_dir}" mkdir "{remote_dir}"',
                        user=user, timeout=5)

            result = subprocess.run(
                ["scp", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
                 tmp_path, f'{user}@{host}:"{remote_path}"'],
                capture_output=True, text=True, timeout=30,
            )

            if result.returncode == 0:
                pushed += 1
                print(f"  [IMG] Pushed: {dest_path}")
            else:
                failed += 1
                print(f"  [IMG] SCP failed {dest_path}: {result.stderr.strip()}")

        except Exception as e:
            failed += 1
            print(f"  [IMG] Failed {img.get('name', '?')}: {e}")

        finally:
            # Always clean up temp file, even on exception
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    return pushed, failed

# ---------------------------------------------------------------------------
# POS Restart (SSH + PsExec)
# ---------------------------------------------------------------------------

def pos_is_running(host, user=None):
    """Return True if 'Pecan POS.exe' appears in the remote tasklist."""
    ok, out, _ = ssh_cmd(host, 'tasklist /fi "imagename eq Pecan POS.exe" /fo csv /nh', user=user)
    return ok and "Pecan POS.exe" in out


def deploy_restart_script(host, user=None):
    """Always write (overwrite) the VBS launcher to the POS.

    We unconditionally overwrite rather than checking existence so a stale or
    corrupt VBS is never left in place. The VBS hides the cmd window and chains
    cd → launch so the POS finds its own resources directory.
    """
    user = user or SSH_USER
    vbs = (
        'Set WshShell = CreateObject("WScript.Shell")\r\n'
        'WshShell.Run "cmd /c cd /d ""C:\\Program Files\\Pecan Solutions\\Pecan POS"" && ""Pecan POS.exe"" --no-sandbox", 0, False\r\n'
    )
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".vbs", delete=False) as f:
            f.write(vbs)
            tmp_path = f.name

        result = subprocess.run(
            ["scp", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
             tmp_path, f"{user}@{host}:C:/restart_pos.vbs"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            print(f"  [POS] Restart script deployed")
            return True
        else:
            print(f"  [POS] Failed to deploy restart script: {result.stderr.strip()}")
            return False

    except Exception as e:
        print(f"  [POS] Failed to deploy restart script: {e}")
        return False

    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def get_active_session_id(host, user=None):
    """Return the active console session ID on the remote Windows host.

    `query session` exits non-zero on some Windows builds and may write to
    stderr instead of stdout — parse both regardless of return code.
    """
    _, qout, qerr = ssh_cmd(host, "query session", user=user, timeout=10)
    for line in (qout + "\n" + qerr).splitlines():
        low = line.lower()
        if "active" in low and "console" in low:
            for part in line.split():
                if part.isdigit():
                    return int(part)
    return 1  # safe default


def restart_pos(host, user=None, db_name=None):
    """Kill and relaunch the POS via SSH + PsExec. Returns a result dict.

    PsExec -i {session} -h -d launches wscript in the interactive desktop
    session with elevation. --no-sandbox lets Electron access the GPU adapter
    from a remote session context. The VBS wrapper hides the cmd.exe window.

    Note: PsExec -d exits with the launched PID as its exit code (non-zero),
    so we ignore the SSH return code and verify via tasklist instead.
    """
    user = user or SSH_USER
    result = {"method": "psexec", "pos_restarted": False, "pos_running": False}

    # Optionally switch the database in appsettings.json before restart.
    # Use -EncodedCommand (UTF-16LE base64) to avoid cmd.exe quoting issues.
    if db_name:
        appsettings = r"C:\Program Files\Pecan Solutions\Pecan POS\resources\api\appsettings.json"
        ps_script = (
            f"$p='{appsettings}'; "
            f"(Get-Content -Raw $p) "
            f"-replace 'Database=[^;\"]+', 'Database={db_name}' "
            f"| Set-Content -NoNewline $p"
        )
        encoded = base64.b64encode(ps_script.encode("utf-16-le")).decode("ascii")
        ok, _, err = ssh_cmd(host, f"powershell.exe -NoProfile -EncodedCommand {encoded}",
                             user=user, timeout=15)
        if ok:
            print(f"  [POS] appsettings.json → Database={db_name}")
            result["db_switched"] = db_name
        else:
            print(f"  [POS] appsettings update FAILED: {err[:160]}")
            result["error"] = f"appsettings update failed: {err[:160]}"
            return result

    # Kill — "not found" is fine, POS may already be stopped
    ok, out, err = ssh_cmd(host, 'taskkill /f /im "Pecan POS.exe"', user=user)
    if ok:
        print("  [POS] Killed existing POS process")
    elif "not found" in (out + err).lower():
        print("  [POS] POS was not running")
    else:
        print(f"  [POS] taskkill output: {(err or out)[:80]}")

    time.sleep(2)

    # Always (re)deploy the VBS — never trust a pre-existing copy
    deploy_restart_script(host, user)

    # Detect active session
    session_id = get_active_session_id(host, user)
    print(f"  [POS] Launching via PsExec (session {session_id})...")

    launch_cmd = (
        f'{PSEXEC_PATH} -accepteula -i {session_id} -h -d '
        r'C:\Windows\System32\wscript.exe C:\restart_pos.vbs'
    )
    ssh_cmd(host, launch_cmd, user=user, timeout=30)

    # Poll for up to 60s — Electron + .NET cold start takes 25-40s on the tablet
    deadline = time.time() + 60
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        time.sleep(5)
        if pos_is_running(host, user):
            result["pos_running"] = True
            result["pos_restarted"] = True
            print(f"  [POS] Running (confirmed after {attempt * 5}s)")
            break
    else:
        result["pos_running"] = False
        result["error"] = "POS not detected after 60s — check tablet display for UAC prompt"
        print(f"  [POS] Not running after 60s — may need UAC approval on tablet")

    return result

# ---------------------------------------------------------------------------
# Main deploy loop
# ---------------------------------------------------------------------------

def process_queued():
    """Poll Supabase for queued sessions and process each one."""
    try:
        rows = supabase_get("sessions", {
            "deploy_status": "eq.queued",
            "select": "id,generated_sql,pending_images,deploy_target",
        })
    except Exception as e:
        print(f"[POLL] Supabase error: {e}")
        return

    for session in rows:
        sid    = session["id"]
        sql    = session.get("generated_sql", "")
        images = session.get("pending_images") or []
        deploy_target = session.get("deploy_target")

        print(f"\n[DEPLOY] Session {sid[:8]}  ({len(images)} image(s))")

        # Claim the session immediately so parallel agents don't double-process
        try:
            supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                "deploy_status": "executing",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as e:
            print(f"  [ERROR] Could not claim session: {e}")
            continue

        target_host = (deploy_target or {}).get("host", DB_HOST)
        ssh_host    = (deploy_target or {}).get("ssh_host", SSH_HOST or target_host)
        ssh_user    = (deploy_target or {}).get("ssh_user", SSH_USER)
        target_db   = (deploy_target or {}).get("database", DB_NAME)

        try:
            # 1. Execute SQL
            rows_affected = execute_sql(sql, deploy_target)
            print(f"  [SQL] {rows_affected} rows affected")

            # 2. Push images + restart POS — single SSH availability check
            images_pushed, images_failed = 0, 0
            pos_result = {}

            if ssh_available(ssh_host, ssh_user):
                if images:
                    images_pushed, images_failed = push_images_scp(images, ssh_host, ssh_user)
                pos_result = restart_pos(ssh_host, ssh_user, db_name=target_db)
            else:
                print(f"  [SSH] Not available at {ssh_user}@{ssh_host} — skipping images + restart")

            # 3. Mark done
            deploy_result = {
                "ok": True,
                "rows_affected": rows_affected,
                "error": None,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "images_pushed": images_pushed,
                "images_failed": images_failed,
                "pos_restarted": pos_result.get("pos_restarted", False),
                "pos_running": pos_result.get("pos_running", False),
            }
            supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                "deploy_status": "done",
                "deploy_result": json.dumps(deploy_result),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            print(f"  [DONE] ✓")

        except Exception as e:
            print(f"  [FAIL] {e}")
            traceback.print_exc()
            try:
                supabase_patch("sessions", {"id": f"eq.{sid}"}, {
                    "deploy_status": "failed",
                    "deploy_result": json.dumps({
                        "ok": False,
                        "rows_affected": 0,
                        "error": str(e)[:500],
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "images_pushed": 0,
                        "images_failed": 0,
                        "pos_restarted": False,
                        "pos_running": False,
                    }),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                print("  [ERROR] Could not write failure status to Supabase")


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_KEY must be set in agent/.env")
        sys.exit(1)

    ssh_host = SSH_HOST or DB_HOST
    print("Demo Builder Deploy Agent")
    print(f"  Supabase : {SUPABASE_URL}")
    print(f"  MariaDB  : {DB_HOST}:{DB_PORT}/{DB_NAME}")
    print(f"  SSH      : {SSH_USER}@{ssh_host}")
    print(f"  Poll     : every {POLL_INTERVAL}s")
    print()

    if ssh_available(ssh_host):
        print(f"  SSH: connected to {ssh_host}")
    else:
        print(f"  SSH: NOT available — image push and POS restart will be skipped")
    print()

    consecutive_errors = 0

    while True:
        try:
            process_generate_queue()  # batch generation jobs (PT → Demo Builder)
            process_queued()           # deploy jobs (Demo Builder → tablet)
            consecutive_errors = 0

            # Heartbeat: update agent_last_seen on the connection record for this host
            try:
                supabase_patch("connections", {"host": f"eq.{DB_HOST}"}, {
                    "agent_last_seen": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass  # heartbeat failure is non-fatal

        except Exception as e:
            consecutive_errors += 1
            backoff = min(60, POLL_INTERVAL * (2 ** consecutive_errors))
            print(f"[POLL] Unhandled error (#{consecutive_errors}): {e} — backing off {backoff}s")
            time.sleep(backoff)
            continue

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
