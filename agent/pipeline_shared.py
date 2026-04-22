#!/usr/bin/env python3
"""
pipeline_shared
~~~~~~~~~~~~~~~
Mechanical helpers used by BOTH the always-on deploy daemon
(`deploy_agent.py`) and the manually-invoked batch pipeline (`rebuild_batch.py`
and, future, `batch_pipeline.py`).

Contents are purely stateless: Supabase REST, HTTP/page fetchers, ld+json
parsers, menu-URL discovery (mechanical-first with AI fallback). No wave
logic, no stage orchestration, no POS/SSH/MariaDB — those stay in the
respective daemons/CLIs.

Extraction source: `deploy_agent.py` as of 2026-04-16 (lift-and-shift,
no behavior change). See `agent/SEPARATION_AUDIT.md`.
"""
from __future__ import annotations  # PEP 563: runs on /usr/bin/python3 (3.9)

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests

# ---------------------------------------------------------------------------
# Config + env loading
# ---------------------------------------------------------------------------

_EXPECTED_SUPABASE_REF = "mqifktmmyiqzrolrvsmy"


def load_env():
    """Load .env file if present. File values overwrite env to prevent launchd contamination."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    # INTENTIONAL: direct assignment (not setdefault) so the .env file
                    # always wins over launchd global env vars (launchctl setenv pollution).
                    os.environ[key.strip()] = val.strip().strip('"').strip("'")

load_env()

SUPABASE_URL      = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY      = os.environ.get("SUPABASE_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# Fail fast if the URL points to the wrong project — catches launchd contamination
# before any writes happen.
if SUPABASE_URL and _EXPECTED_SUPABASE_REF not in SUPABASE_URL:
    raise RuntimeError(
        f"pipeline_shared: SUPABASE_URL points to wrong project.\n"
        f"  Expected ref: {_EXPECTED_SUPABASE_REF}\n"
        f"  Got:          {SUPABASE_URL}\n"
        "Check launchd env: launchctl getenv SUPABASE_URL"
    )

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
    "Accept-Profile": "demo_builder",
    "Content-Profile": "demo_builder",
}

# ---------------------------------------------------------------------------
# Supabase REST helpers
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
# Stage → column map (canonical; see REFACTOR_PLAN.md §2.5b)
# ---------------------------------------------------------------------------
#
# `batch_id_col` is written by submit_batch and read by wait_and_drain; the
# names come from migrations 004 (discover/extract/modifier/branding), 008
# (pdf), 009 (image_menu).
#
# `result_col` is NON-UNIFORM on purpose: extract, pdf, and image_menu all
# share `extraction_result` (pdf and image_menu are re-routes of extract),
# while modifier and branding have their own columns. discover has no
# per-row result (its output is new rows, not a column).
#
# Blind f"{stage}_result" would silently misname columns — always indirect
# through STAGES[stage]["result_col"].

StageName = str  # "discover" | "extract" | "modifier" | "branding" | "pdf" | "image_menu"

STAGES: dict = {
    "discover":   {"batch_id_col": "discover_batch_id",   "result_col": None},
    "extract":    {"batch_id_col": "extract_batch_id",    "result_col": "extraction_result"},
    "modifier":   {"batch_id_col": "modifier_batch_id",   "result_col": "modifier_result"},
    "branding":   {"batch_id_col": "branding_batch_id",   "result_col": "branding_result"},
    "pdf":        {"batch_id_col": "pdf_batch_id",        "result_col": "extraction_result"},
    "image_menu": {"batch_id_col": "image_menu_batch_id", "result_col": "extraction_result"},
}


def _introspect_batch_queue_columns() -> set[str]:
    """List column names on demo_builder.batch_queue via PostgREST OPTIONS.

    PostgREST doesn't expose information_schema directly, but an empty GET
    with `select=*&limit=0` returns the full column set in the response's
    `Content-Range` header + first-row shape. We query with limit=1 and
    read the keys off the row (or empty list) — if the table is empty we
    fall back to a `select=*` with `Prefer: count=exact` and parse the
    response headers. Keep it simple: use a tiny SQL RPC instead.
    """
    # Simplest reliable path: POST to /rest/v1/rpc/<fn> with a tiny SQL fn,
    # but adding an RPC per introspection is overkill. Just GET one row.
    url = f"{SUPABASE_URL}/rest/v1/batch_queue?limit=1&select=*"
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"}, timeout=10)
    r.raise_for_status()
    rows = r.json()
    if rows:
        return set(rows[0].keys())
    # Empty table: introspect via OpenAPI spec endpoint
    spec_url = f"{SUPABASE_URL}/rest/v1/"
    r2 = requests.get(spec_url, headers={**HEADERS, "Accept": "application/openapi+json"}, timeout=10)
    r2.raise_for_status()
    spec = r2.json()
    props = (
        spec.get("definitions", {})
        .get("batch_queue", {})
        .get("properties", {})
    )
    return set(props.keys())


def log_event(
    *,
    batch_queue_id: str,
    rebuild_run_id: str,
    stage: str,
    event_type: str,
    batch_id: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cache_creation_tokens: int | None = None,
    cache_read_tokens: int | None = None,
    cost_usd=None,  # numeric; supabase REST serializes str/float/Decimal
    error_text: str | None = None,
    review_reason: str | None = None,
    http_status: int | None = None,
) -> None:
    """Single-row INSERT into demo_builder.batch_queue_events.

    Never raises. Event-write failure must not mask the underlying
    operation — the caller has already done the work. On any exception,
    print a warning and swallow: status column remains the fallback.

    See REFACTOR_PLAN.md §2.9 for event vocabulary.
    """
    payload = {
        "batch_queue_id": batch_queue_id,
        "rebuild_run_id": rebuild_run_id,
        "stage": stage,
        "event_type": event_type,
    }
    if batch_id is not None:
        payload["batch_id"] = batch_id
    if input_tokens is not None:
        payload["input_tokens"] = int(input_tokens)
    if output_tokens is not None:
        payload["output_tokens"] = int(output_tokens)
    if cache_creation_tokens is not None:
        payload["cache_creation_tokens"] = int(cache_creation_tokens)
    if cache_read_tokens is not None:
        payload["cache_read_tokens"] = int(cache_read_tokens)
    if cost_usd is not None:
        payload["cost_usd"] = str(cost_usd)
    if error_text is not None:
        payload["error_text"] = error_text[:8000]  # guard against huge blobs
    if review_reason is not None:
        payload["review_reason"] = review_reason
    if http_status is not None:
        payload["http_status"] = int(http_status)

    try:
        url = f"{SUPABASE_URL}/rest/v1/batch_queue_events"
        requests.post(url, headers=HEADERS, json=payload, timeout=10).raise_for_status()
    except Exception as e:
        print(f"[log_event] WARN: event write failed ({event_type}/{stage} "
              f"for row {batch_queue_id}): {e}", flush=True)


def assert_schema() -> None:
    """Fail-fast check that every column STAGES + PR3 requires exists on
    `demo_builder.batch_queue`. Call this once at rebuild_batch.py startup.

    Raises RuntimeError with a precise list of missing columns so migrations
    can be identified by name.
    """
    required = {meta["batch_id_col"] for meta in STAGES.values()}
    required |= {c for c in (m["result_col"] for m in STAGES.values()) if c}
    required |= {
        "active_batch_run_id",
        "review_reason",
        "rebuild_run_id",
        "preflight",
        "batch_submitted_at",
        "last_polled_at",
        "status",
        "pt_record_id",
    }
    existing = _introspect_batch_queue_columns()
    missing = sorted(required - existing)
    if missing:
        raise RuntimeError(
            f"demo_builder.batch_queue is missing required columns: {missing}. "
            "Apply migrations 004/008/009/010/012 via supabase/migrations/."
        )

# ---------------------------------------------------------------------------
# Shared exception + timestamp util
# ---------------------------------------------------------------------------

class _ApiLimitHit(Exception):
    """Raised when Anthropic returns the usage-limit phrase; callers can requeue."""
    pass


_API_LIMIT_PHRASE = "you have reached your specified api usage limits"


def _now_iso():
    return datetime.now(timezone.utc).isoformat()

# ---------------------------------------------------------------------------
# Page-fetch constants (Cloudflare detection, menu-URL heuristics)
# ---------------------------------------------------------------------------

_CF_PHRASES = ("security verification", "security service to protect")

_MENU_HREF_KW   = ("/menu", "/menus", "/food", "/our-menu", "/food-menu", "/dining")
_MENU_TEXT_KW   = ("menu", "food", "eat", "dine", "dining", "order online")
_PLATFORM_HOSTS = (
    "toasttab.com", "order.squareup.com", "popmenu.com",
    "bentobox.com", "olo.com", "chownow.com", "menudrive.com",
    "tabit.us",
    "orders.co",
    "bopple.me",
    "owner.com",
    "spoton.com",
    "trycake.app",
    "restaurantji.com",
)
_PDF_RE = re.compile(r'\.pdf(\?|$)', re.IGNORECASE)
_COMMON_MENU_PATHS = ("/food-menu", "/menus", "/menu", "/our-menu", "/dining-menu")

_MENU_INDEX_LINK_RE = re.compile(
    r"(?i)(?:view|see|browse|explore|check\s+out)\s+(?:our\s+|the\s+|full\s+|complete\s+)?"
    r"(?:[a-z]+\s+)?menu"
)

_MENU_IMG_TOKENS = re.compile(
    r"(?i)menu|carte|food|entree|specials?|drinks?|wings?|breakfast|lunch|dinner|"
    r"dessert|appetizer|salad|pizza|burger|sushi|tacos?|pasta|cocktail"
)

_PW_MENU_SELECTORS = [
    ".menu-item", ".menu-items", ".menu-section", ".menu-category",
    ".MenuItem", ".MenuSection", ".MenuCategory",
    ".food-item", ".dish", ".dish-name", ".item-card",
    "[class*='menu-item']", "[class*='MenuItem']", "[class*='MenuSection']",
    "[class*='food-item']", "[class*='dish-card']",
    "[data-testid*='menu']", "[data-testid*='MenuItem']",
    "[itemtype*='MenuItem']",
]

# ---------------------------------------------------------------------------
# ld+json + HTML parsers
# ---------------------------------------------------------------------------

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
        for section in data.get("hasMenuSection", [data]):
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

        if any(p in html.lower() for p in _CF_PHRASES):
            print(f"  [CF] Cloudflare challenge still active — curl_cffi couldn't bypass")
            return None

        ldjson_text = _extract_ldjson_menu_text(html)
        if ldjson_text and len(ldjson_text) > 100:
            print(f"  [CF] Got {len(ldjson_text)} chars from ld+json structured data")
            return ldjson_text[:40_000]

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


def _fetch_homepage_html(url, max_chars=40_000):
    """Fetch the homepage HTML via curl_cffi (Chrome TLS fingerprint).
    Returns raw HTML trimmed to max_chars, or None if unreachable/blocked."""
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        return None
    try:
        r = cffi_requests.get(url, impersonate="chrome", timeout=20)
        html = r.text or ""
        if any(p in html.lower() for p in _CF_PHRASES):
            return None
        html = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", html)
        return html[:max_chars]
    except Exception:
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
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

            found_menu_sel = False
            for sel in _PW_MENU_SELECTORS:
                try:
                    page.wait_for_selector(sel, timeout=3_000)
                    found_menu_sel = True
                    break
                except Exception:
                    pass

            if not found_menu_sel:
                page.wait_for_timeout(4_000)

            text_before = page.inner_text("body")

            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(2_000)
            text_after = page.inner_text("body")

            text = text_after if len(text_after) > len(text_before) else text_before

            browser.close()
            trimmed = text.strip()[:40_000]
            if "security verification" in trimmed.lower() or "security service to protect" in trimmed.lower():
                print(f"  [PW] Cloudflare bot protection detected — cannot scrape")
                return None
            print(f"  [PW] Got {len(trimmed)} chars from {url} (menu_sel={'yes' if found_menu_sel else 'no'})")
            return trimmed or None
    except Exception as e:
        print(f"  [PW] Playwright fetch failed: {e}")
        return None


def _extract_menu_index_links(base_url: str, raw_text: str) -> list[str]:
    """Detect when a /menu page is actually a menu-index (lists sub-menus or
    per-location menus) and extract the sub-URLs. Returns [] if not an index."""
    anchor_hits = _MENU_INDEX_LINK_RE.findall(raw_text)
    if len(anchor_hits) < 2:
        return []
    try:
        from curl_cffi import requests as cffi_requests
        resp = cffi_requests.get(base_url, impersonate="chrome", timeout=20)
        html = resp.text
    except Exception:
        return []

    from html.parser import HTMLParser

    class _Anchors(HTMLParser):
        def __init__(self):
            super().__init__()
            self.pairs = []
            self._href = None
            self._buf = []
        def handle_starttag(self, tag, attrs):
            if tag == "a":
                self._href = dict(attrs).get("href", "")
                self._buf = []
        def handle_endtag(self, tag):
            if tag == "a" and self._href:
                self.pairs.append((self._href, " ".join(self._buf).strip()))
                self._href = None
        def handle_data(self, data):
            if self._href is not None:
                self._buf.append(data.strip())

    p = _Anchors()
    p.feed(html)

    import html as html_mod
    blocked_hosts = ("facebook.com", "instagram.com", "twitter.com", "x.com",
                     "youtube.com", "tiktok.com", "google.com", "maps.google",
                     "yelp.com", "tripadvisor.com")
    seen = set()
    subs = []
    for href, text in p.pairs:
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        text_decoded = html_mod.unescape(text)
        if not _MENU_INDEX_LINK_RE.search(text_decoded):
            continue
        abs_url = urljoin(base_url, href)
        if abs_url == base_url or abs_url in seen:
            continue
        host = urlparse(abs_url).netloc.lower()
        if any(b in host for b in blocked_hosts):
            continue
        seen.add(abs_url)
        subs.append(abs_url)
    return subs


def _detect_menu_images(url: str, max_imgs: int = 8) -> list[str]:
    """Probe the page via Playwright for large images whose filename/alt
    contains menu-ish tokens. Returns list of image URLs (possibly empty)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            page = b.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=25_000)
            page.wait_for_timeout(2_000)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1_500)
            imgs = page.evaluate("""() => {
                const out = [];
                for (const img of document.querySelectorAll('img')) {
                    const src = img.src || img.dataset.src || '';
                    const alt = img.alt || '';
                    const w = img.naturalWidth || img.width || 0;
                    const h = img.naturalHeight || img.height || 0;
                    if (src && w > 300 && h > 300) out.push({src, alt});
                }
                return out;
            }""")
            b.close()
    except Exception as e:
        print(f"  [IMG] probe failed: {e}")
        return []

    results = []
    seen = set()
    for i in imgs:
        src = i.get("src", "")
        alt = i.get("alt", "")
        haystack = f"{src} {alt}"
        if not _MENU_IMG_TOKENS.search(haystack):
            continue
        if src in seen:
            continue
        seen.add(src)
        results.append(src)
        if len(results) >= max_imgs:
            break
    return results


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
        item_count = merged.count(" — $")
        print(f"  [LD] {len([t for t in section_texts if t])} sections, "
              f"~{item_count} items, {len(merged)} chars")

        return merged[:40_000] if len(merged) > 100 else None

    except Exception as e:
        print(f"  [LD] Full menu extraction failed: {e}")
        return None


def _ldjson_items_to_rows(merged_text):
    """Convert merged ld+json menu text to the 9-column extraction-result items.
    Returns a list of item dicts. Same shape that MENU_EXTRACTION_SYSTEM_PROMPT
    emits so downstream code is uniform.
    Lines look like '## Group — Section' and 'Name — $price' or 'Name — desc'.
    """
    items = []
    current_group = "Menu"
    for raw in merged_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("##"):
            header = line.lstrip("# ").strip()
            current_group = header.split(" — ")[-1] or header
            continue
        m = re.match(r"^(.+?)\s+—\s+\$?([\d.]+)(?:\s|$)", line)
        if m:
            name = m.group(1).strip()
            price = float(m.group(2))
            items.append({
                "Menu Item Full Name": name,
                "Menu Item Group": current_group,
                "Menu Item Category": "Food",
                "Default Price": price,
            })
        else:
            m2 = re.match(r"^([A-Z][^—]{1,80})$", line)
            if m2:
                items.append({
                    "Menu Item Full Name": m2.group(1).strip(),
                    "Menu Item Group": current_group,
                    "Menu Item Category": "Food",
                    "Default Price": 0,
                })
    return items

# ---------------------------------------------------------------------------
# Menu URL discovery (mechanical-first, Haiku fallback)
# ---------------------------------------------------------------------------

def discover_menu_url_ai(page_text: str, base_url: str):
    """Use Haiku to identify the menu page URL from stripped homepage content.

    Called only when mechanical discovery (nav scoring + common-path probe) fails.
    Sends up to 6,000 chars of stripped homepage text to Haiku and asks it to
    identify the menu URL. Returns an absolute URL string, or None if not found.

    Cost: ~$0.001 per call (tiny input, 1-token URL output).
    """
    if not ANTHROPIC_API_KEY:
        return None
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        snippet = page_text[:6_000]
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=100,
            messages=[{
                "role": "user",
                "content": (
                    f"This is text from a restaurant website ({base_url}).\n\n"
                    f"{snippet}\n\n"
                    "What URL contains this restaurant's food menu? "
                    "Reply with ONLY the URL (absolute or relative), or reply 'none' if there is no menu link."
                ),
            }],
        )
        answer = msg.content[0].text.strip().strip('"').strip("'")
        if not answer or answer.lower() == "none" or answer.lower().startswith("i "):
            return None
        if answer.startswith("/"):
            parsed = urlparse(base_url)
            answer = f"{parsed.scheme}://{parsed.netloc}{answer}"
        if not answer.startswith("http"):
            return None
        print(f"  [AI] Discovered menu URL: {answer}")
        return answer
    except Exception as e:
        print(f"  [AI] Discovery failed: {e}")
        return None


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

        if len(_extract_ldjson_menu_text(html)) > 100:
            print(f"  [DISC] ld+json Menu found on homepage")
            return {"type": "ldjson", "url": homepage_url}

        from html.parser import HTMLParser

        class _LinkParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.links = []
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
            base_host = urlparse(homepage_url).netloc.lower()
            base = f"{urlparse(homepage_url).scheme}://{base_host}"
            for path in _COMMON_MENU_PATHS:
                probe_url = base + path
                try:
                    r2 = cffi_requests.get(probe_url, impersonate="chrome",
                                            timeout=10, allow_redirects=False)
                    if r2.status_code != 200:
                        continue
                    final_host = urlparse(str(r2.url)).netloc.lower() if hasattr(r2, "url") else base_host
                    if final_host and final_host != base_host:
                        print(f"  [DISC] probe {path} redirected off-domain ({final_host}) — skipping")
                        continue
                    if len(r2.text) > 500:
                        ldjson_text = _extract_ldjson_menu_text(r2.text)
                        if len(ldjson_text) > 100:
                            print(f"  [DISC] Common-path probe hit (ld+json): {probe_url}")
                            return {"type": "ldjson", "url": probe_url}
                        print(f"  [DISC] Common-path probe hit (html): {probe_url}")
                        return {"type": "html", "url": probe_url}
                except Exception:
                    pass
            page_text = fetch_page_text_curl_cffi(homepage_url) or ""
            ai_url = discover_menu_url_ai(page_text, homepage_url) if page_text else None
            if ai_url:
                parsed_ai = urlparse(ai_url)
                if _PDF_RE.search(ai_url):
                    return {"type": "pdf", "url": ai_url}
                if any(h in parsed_ai.netloc for h in _PLATFORM_HOSTS):
                    return {"type": "platform", "url": ai_url}
                return {"type": "html", "url": ai_url}
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


__all__ = [
    # config
    "SUPABASE_URL", "SUPABASE_KEY", "ANTHROPIC_API_KEY", "HEADERS", "load_env",
    # supabase
    "supabase_get", "supabase_patch",
    # exceptions + utils
    "_ApiLimitHit", "_API_LIMIT_PHRASE", "_now_iso",
    # parsers
    "_extract_ldjson_menu_text", "_extract_menu_index_links", "_detect_menu_images",
    "extract_ldjson_full_menu", "_ldjson_items_to_rows",
    # page fetch
    "fetch_page_text_curl_cffi", "fetch_page_text_playwright", "_fetch_homepage_html",
    # discovery
    "discover_menu_url", "discover_menu_url_ai",
    # constants that callers sometimes reference directly
    "_CF_PHRASES", "_MENU_HREF_KW", "_MENU_TEXT_KW", "_PLATFORM_HOSTS",
    "_PDF_RE", "_COMMON_MENU_PATHS",
]
