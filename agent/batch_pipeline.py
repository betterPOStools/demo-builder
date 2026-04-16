#!/usr/bin/env python3
"""
batch_pipeline — CLI-only staged batch pipeline
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Invoked manually by the operator:

    python3 agent/batch_pipeline.py run-staged
    python3 agent/batch_pipeline.py dry-run
    python3 agent/batch_pipeline.py retry-failed   # stub — not yet implemented

This module is NEVER a daemon. It must ONLY do work when invoked as
__main__. The launchd plist for the always-on deploy daemon
(com.valuesystems.demo-builder-agent) runs deploy_agent.py exclusively.

See agent/SEPARATION_PLAN.md (Phase 3) for the full separation rationale.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests

try:
    import anthropic
except ImportError:
    anthropic = None

# ---------------------------------------------------------------------------
# Shared symbols — mechanical helpers used by both pipeline sides.
# See agent/SEPARATION_AUDIT.md for classification.
# ---------------------------------------------------------------------------

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pipeline_shared import (  # noqa: E402
    SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY, HEADERS,
    supabase_get, supabase_patch,
    _ApiLimitHit, _API_LIMIT_PHRASE, _now_iso,
    _extract_ldjson_menu_text, _extract_menu_index_links, _detect_menu_images,
    extract_ldjson_full_menu, _ldjson_items_to_rows,
    fetch_page_text_curl_cffi, fetch_page_text_playwright, _fetch_homepage_html,
    discover_menu_url, discover_menu_url_ai,
    _CF_PHRASES, _MENU_HREF_KW, _MENU_TEXT_KW, _PLATFORM_HOSTS,
    _PDF_RE, _COMMON_MENU_PATHS,
)

# ---------------------------------------------------------------------------
# Batch-pipeline config
# ---------------------------------------------------------------------------

# SNAPSHOT_DIR — used by snapshot helpers (batch assemble + legacy generate-queue).
# Defined here (batch side) per audit §1 decision.
SNAPSHOT_DIR         = os.path.expanduser(os.environ.get("SNAPSHOT_DIR", "~/Projects/demo-DBs"))

# ── Staged batch pipeline (4 stages + assemble) ─────────────────────────────
# Each stage's AI batch is a POOL of rows that fell through the mechanical path.
# Waves submit when >= WAVE_MIN_SIZE rows are queued or the oldest row has been
# waiting > FORCE_WAVE_AFTER_SECONDS. Batch discount is 50%, prompt-caching
# makes per-wave system-prompt reuse essentially free after the first request.
WAVE_MIN_SIZE            = int(os.environ.get("WAVE_MIN_SIZE", "20"))
# 200 lets a single batch amortize system-prompt cache creation across more rows
# (Anthropic batch API supports up to 10,000 requests/batch). Raised from 40.
WAVE_MAX_SIZE            = int(os.environ.get("WAVE_MAX_SIZE", "200"))
BATCH_BUDGET_USD         = float(os.environ.get("BATCH_BUDGET_USD", "5.0"))
FORCE_WAVE_AFTER_SECONDS = int(os.environ.get("FORCE_WAVE_AFTER_SECONDS", "1800"))
BATCH_POLL_INTERVAL_SEC  = int(os.environ.get("BATCH_POLL_INTERVAL_SEC", "60"))
BATCH_MODEL              = os.environ.get("BATCH_MODEL", "claude-haiku-4-5-20251001")

# Also needed by assemble — references Next.js app
DEMO_BUILDER_API_URL = os.environ.get("DEMO_BUILDER_API_URL", "http://localhost:3002")

# Module-scope Anthropic client — created once, reused across all stage batches.
_anthropic = (
    anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    if anthropic and ANTHROPIC_API_KEY else None
)

# Load stage system prompts from lib/extraction/prompts.ts at startup.
# Single source of truth; the TS side is authoritative.
_PROMPTS_TS_PATH = os.path.join(
    os.path.dirname(__file__), "..", "lib", "extraction", "prompts.ts",
)

def _load_stage_prompts():
    try:
        with open(_PROMPTS_TS_PATH, "r", encoding="utf-8") as f:
            src = f.read()
    except Exception as e:
        print(f"[PROMPTS] Could not load prompts.ts: {e}")
        return {}
    names = (
        "DISCOVERY_SYSTEM_PROMPT",
        "MENU_EXTRACTION_SYSTEM_PROMPT",
        "MODIFIER_INFERENCE_SYSTEM_PROMPT",
        "BRANDING_TOKENS_SYSTEM_PROMPT",
    )
    out = {}
    for name in names:
        m = re.search(
            rf"export const {name} = `(.*?)`;",
            src, re.DOTALL,
        )
        if m:
            out[name] = m.group(1)
    return out

_STAGE_PROMPTS = _load_stage_prompts()

# Fail loudly on startup if any expected stage prompt is missing — batches
# would otherwise submit with an empty system prompt and burn tokens for nothing.
# batch_pipeline is always CLI-invoked (never DEPLOY_ONLY), so always assert.
_expected = (
    "DISCOVERY_SYSTEM_PROMPT",
    "MENU_EXTRACTION_SYSTEM_PROMPT",
    "MODIFIER_INFERENCE_SYSTEM_PROMPT",
    "BRANDING_TOKENS_SYSTEM_PROMPT",
)
_missing = [n for n in _expected if n not in _STAGE_PROMPTS or not _STAGE_PROMPTS.get(n)]
if _missing:
    raise RuntimeError(
        f"[PROMPTS] Missing stage prompt(s) {_missing} in {_PROMPTS_TS_PATH}. "
        f"Refusing to start the batch pipeline — prompts.ts is authoritative."
    )

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

# Error phrases from extract-url that indicate a retryable failure (not a hard stop)
_JS_CONTENT_ERRORS = (
    "too little content",
    "no menu items",              # legacy wording — keep for old rows being retried
    "inaccessible or empty",
    "no content fetched",         # new wording: agent passed 0 raw_text + fetch returned 0 items
    "ai extracted 0 items",       # new wording: AI ran on raw_text and returned empty items
    "blocking automated requests",
    "invalid json",               # AI got CF challenge page / garbled HTML, couldn't parse
    "extraction failed",          # catch-all for HTTP 500 from extract-url
    "truncated",                  # max_tokens hit on large menu — PW renders less text
)

_NAV_WORD_RE = re.compile(
    r"\b(?:home|menu|contact|about|order|location|hours|gallery|events|catering|"
    r"delivery|reservations?|gift|careers|blog|login|signup|subscribe|cart)\b",
    re.IGNORECASE,
)
_PRICE_RE = re.compile(r"\$\d+(?:\.\d{1,2})?")


def _classify_extract_skip(raw):
    """Decide whether raw text is worth sending to Haiku for menu extraction.

    Returns a failure-reason string if the text should be skipped, or None if
    it's worth the AI call. Patterns learned from the 2026-04-15 rebuild where
    337 rows returned "no items" — costs ~$0.025/row input-only on 20K tokens.
    """
    text = (raw or "").strip()
    n = len(text)
    if n < 500:
        return "skipped: too_sparse (<500 chars — nav chrome only)"
    # Word tokens (rough, split on whitespace)
    tokens = text.split()
    if len(tokens) < 80:
        return "skipped: too_few_tokens"
    # Nav-word density — pages dominated by nav links have no menu items to extract
    nav_hits = len(_NAV_WORD_RE.findall(text))
    nav_ratio = nav_hits / len(tokens)
    if nav_ratio > 0.35 and n < 3_000:
        return f"skipped: nav_chrome_heavy (nav_ratio={nav_ratio:.2f})"
    # No price signals at all on a long page — probably a blog/listicle/about page
    has_prices = bool(_PRICE_RE.search(text))
    if not has_prices and n > 3_000:
        return "skipped: no_price_signals_on_long_page"
    return None


# ---------------------------------------------------------------------------
# Staged batch pipeline (4-stage AI + assemble)
# ---------------------------------------------------------------------------

def _parse_ai_json(text):
    """Parse a JSON object out of a model response, tolerating ```json fences."""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", t)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
        return None


def _wave_is_ready(rows):
    """Decide whether a stage wave has enough rows to submit, or whether the
    oldest queued row has been waiting long enough to force a submit below size.
    rows: list of pool rows (must contain at least 'updated_at')."""
    if not rows:
        return False
    if len(rows) >= WAVE_MIN_SIZE:
        return True
    oldest = min(
        (r.get("updated_at") or _now_iso()) for r in rows
    )
    try:
        oldest_dt = datetime.fromisoformat(oldest.replace("Z", "+00:00"))
        if oldest_dt.tzinfo is None:
            oldest_dt = oldest_dt.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - oldest_dt).total_seconds()
        return age >= FORCE_WAVE_AFTER_SECONDS
    except Exception:
        return False


_DEAD_URL_HOSTS = {
    "facebook.com", "m.facebook.com", "www.facebook.com",
    "instagram.com", "www.instagram.com",
    "twitter.com", "x.com",
    "tiktok.com", "www.tiktok.com",
    "youtube.com", "www.youtube.com",
}


def _classify_dead_url(url):
    """Return a failure reason if the URL is a social-media-only prospect that
    should never enter the pipeline. Returns None for custom domains."""
    if not url:
        return None
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return None
    if host in _DEAD_URL_HOSTS:
        return f"dead_url: {host} — social media only, not scrapable"
    return None


# ── Stage 1: URL discovery ──────────────────────────────────────────────────

def advance_stage_discover():
    """Per-job mechanical URL discovery. Jobs where mechanical discovery fails
    go into pool_discover for the AI discovery batch."""
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.queued",
            "select": "id,pt_record_id,name,menu_url",
            "limit": "5",
        })
    except Exception as e:
        print(f"[S1] Supabase error: {e}")
        return

    for job in rows:
        jid = job["id"]
        name = job["name"]
        homepage_url = job["menu_url"]
        print(f"\n[S1] {jid[:8]}  {name}")

        # Dead-URL gate: Facebook and social-media-only prospects are never
        # scrapable. Skip immediately without wasting a fetch or AI call.
        dead = _classify_dead_url(homepage_url)
        if dead:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": dead,
                "updated_at": _now_iso(),
            })
            print(f"  [S1] {dead}")
            continue

        try:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "discovering",
                "updated_at": _now_iso(),
            })
        except Exception as e:
            print(f"  [S1] claim failed: {e}")
            continue

        # Fetch homepage once — used for both discovery + stage-4 branding stash
        homepage_html = _fetch_homepage_html(homepage_url, max_chars=60_000)
        homepage_trimmed = (homepage_html or "")[:20_000]  # stash for stage 4

        discovery = discover_menu_url(homepage_url)

        if discovery["type"] == "pdf":
            pdf_url = discovery.get("url") or ""
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "needs_pdf",
                "menu_url": pdf_url or "",   # store actual PDF URL for Sonnet vision
                "homepage_html": homepage_trimmed or None,
                "updated_at": _now_iso(),
            })
            print(f"  [S1] PDF → needs_pdf  {pdf_url[:80]}")
            continue

        if discovery["type"] in ("ldjson", "html", "platform"):
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "ready_for_extract",
                "menu_url": discovery["url"],
                "homepage_html": homepage_trimmed or None,
                "updated_at": _now_iso(),
            })
            print(f"  [S1] → ready_for_extract  {discovery['url']}")
            continue

        # Mechanical failed on a custom domain → flag for human review instead
        # of burning an AI discovery call. If a real website doesn't have a
        # discoverable /menu nav link or common path, the menu likely isn't
        # online in a scrapable form.
        if not homepage_html:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": "Homepage unreachable (CF or network)",
                "updated_at": _now_iso(),
            })
            print(f"  [S1] homepage unreachable → failed")
            continue

        supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
            "status": "failed",
            "error": f"review: mechanical discovery found no menu on custom domain — flagged for human review",
            "homepage_html": homepage_trimmed,
            "updated_at": _now_iso(),
        })
        print(f"  [S1] no menu found → flagged for review")


# ── Stage 2: menu extraction ────────────────────────────────────────────────

def advance_stage_extract():
    """Per-job mechanical menu extraction via ld+json. Jobs without usable
    ld+json fall through to raw-text stash + pool_extract."""
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.ready_for_extract",
            "select": "id,name,menu_url",
            "limit": "5",
        })
    except Exception as e:
        print(f"[S2] Supabase error: {e}")
        return

    for job in rows:
        jid = job["id"]
        name = job["name"]
        menu_url = job["menu_url"]
        print(f"\n[S2] {jid[:8]}  {name}")

        try:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "extracting",
                "updated_at": _now_iso(),
            })
        except Exception as e:
            print(f"  [S2] claim failed: {e}")
            continue

        ldjson_text = extract_ldjson_full_menu(menu_url)
        if ldjson_text:
            items = _ldjson_items_to_rows(ldjson_text)
            if items and len(items) >= 5:
                supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                    "status": "ready_for_modifier",
                    "extraction_result": {
                        "restaurantType": None,
                        "items": items,
                    },
                    "updated_at": _now_iso(),
                })
                print(f"  [S2] ld+json → ready_for_modifier ({len(items)} items)")
                continue

        # Mechanical miss — grab raw text and pool for AI batch.
        raw = fetch_page_text_curl_cffi(menu_url) or fetch_page_text_playwright(menu_url)

        # Menu-index detection: if the fetched page has multiple "View Menu" /
        # "See Our Menu" links pointing to same-domain sub-URLs, it's a menu
        # INDEX page (e.g. Que Bueno locations, Rotelli Lunch/Dinner split).
        # Follow up to 3 sub-links and concat their text.
        if raw:
            sub_urls = _extract_menu_index_links(menu_url, raw)
            if sub_urls:
                print(f"  [S2] menu-index detected: following {len(sub_urls)} sub-link(s)")
                pieces = [raw]
                for sub in sub_urls[:3]:
                    sub_text = fetch_page_text_curl_cffi(sub) or fetch_page_text_playwright(sub)
                    if sub_text and len(sub_text) > 200:
                        pieces.append(f"\n\n=== SUB-MENU: {sub} ===\n{sub_text}")
                        print(f"  [S2]   + {len(sub_text)} chars from {sub}")
                raw = "\n".join(pieces)

        # Image-menu detection: if raw_text is sparse (< 1500 chars), probe the
        # DOM for large images with menu-ish filenames. If found, route to
        # needs_image_menu so the PDF/Sonnet-vision pipeline can handle them.
        if raw and len(raw) < 1500:
            image_urls = _detect_menu_images(menu_url)
            if image_urls:
                supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                    "status": "needs_image_menu",
                    "raw_text": raw.replace("\x00", "")[:40_000],
                    "extraction_result": {"image_menu_urls": image_urls[:8]},
                    "updated_at": _now_iso(),
                })
                print(f"  [S2] image-menu ({len(image_urls)} imgs) → needs_image_menu")
                continue

        if not raw or len(raw) < 200:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": "Could not fetch menu page text",
                "updated_at": _now_iso(),
            })
            print(f"  [S2] no text → failed")
            continue

        # Content-quality gate: before paying AI extract cost, check if the text
        # actually looks like it could contain a menu. Skipping obvious
        # nav-chrome-only pages saved ~$5 on the 2026-04-15 rebuild.
        quality_fail = _classify_extract_skip(raw)
        if quality_fail:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": quality_fail,
                "raw_text": raw.replace("\x00", "")[:40_000],  # stash for analysis
                "updated_at": _now_iso(),
            })
            print(f"  [S2] quality gate → failed ({quality_fail})")
            continue

        supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
            "status": "pool_extract",
            "raw_text": raw.replace("\x00", "")[:40_000],
            "updated_at": _now_iso(),
        })
        print(f"  [S2] no ld+json → pool_extract ({len(raw)} chars stashed)")


# ── Stage 3: modifier inference ─────────────────────────────────────────────

def advance_stage_modifier():
    """If extraction_result already has modifierTemplates, short-circuit to
    ready_for_branding. Otherwise pool for AI inference."""
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.ready_for_modifier",
            "select": "id,name,extraction_result",
            "limit": "10",
        })
    except Exception as e:
        print(f"[S3] Supabase error: {e}")
        return

    for job in rows:
        jid = job["id"]
        extraction = job.get("extraction_result") or {}
        existing_templates = extraction.get("modifierTemplates")
        item_map = extraction.get("itemTemplateMap")

        if existing_templates:
            modifier_result = {
                "modifierTemplates": existing_templates,
                "itemTemplateMap": item_map or {},
            }
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "ready_for_branding",
                "modifier_result": modifier_result,
                "updated_at": _now_iso(),
            })
            print(f"[S3] {jid[:8]} inherited modifiers → ready_for_branding")
            continue

        supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
            "status": "pool_modifier",
            "updated_at": _now_iso(),
        })
        print(f"[S3] {jid[:8]} no modifiers → pool_modifier")


# ── Stage 4: branding tokens (mechanical-first) ─────────────────────────────

_HEX_RE = re.compile(r"#[0-9A-Fa-f]{6}\b")
_WP_DEFAULT_PALETTE = {
    "#cf2e2e", "#ff6900", "#fcb900", "#7bdcb5", "#00d084",
    "#8ed1fc", "#0693e3", "#abb8c3", "#9b51e0",
}


def _extract_branding_mechanical(html):
    """Try to find an intentional brand color in the homepage HTML.
    Returns dict or None."""
    if not html:
        return None
    # 1. <meta name="theme-color" content="#...">
    m = re.search(
        r'<meta\s+name=["\']theme-color["\']\s+content=["\'](#[0-9A-Fa-f]{6})["\']',
        html, re.IGNORECASE,
    )
    if m:
        return {"buttons_background_color": m.group(1).upper()}
    # 2. CSS custom properties — look for --primary / --brand / --accent
    m = re.search(
        r"--(?:primary|brand|brand-primary|accent|accent-color|color-primary"
        r"|wp--preset--color--primary|wp--preset--color--accent)\s*:\s*(#[0-9A-Fa-f]{6})",
        html, re.IGNORECASE,
    )
    if m:
        hex_val = m.group(1).lower()
        if hex_val not in _WP_DEFAULT_PALETTE:
            return {"buttons_background_color": hex_val.upper()}
    return None


def advance_stage_branding():
    """Try mechanical token extraction from homepage_html. Misses → pool."""
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.ready_for_branding",
            "select": "id,name,homepage_html,menu_url,restaurant_type",
            "limit": "10",
        })
    except Exception as e:
        print(f"[S4] Supabase error: {e}")
        return

    for job in rows:
        jid = job["id"]
        tokens = _extract_branding_mechanical(job.get("homepage_html") or "")
        if tokens:
            tokens["buttons_font_color"] = "#FFFFFF"
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "ready_to_assemble",
                "branding_result": tokens,
                "updated_at": _now_iso(),
            })
            print(f"[S4] {jid[:8]} mechanical hit → ready_to_assemble  {tokens}")
            continue

        supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
            "status": "pool_branding",
            "updated_at": _now_iso(),
        })
        print(f"[S4] {jid[:8]} mechanical miss → pool_branding")


# ── Stage 5: assemble (POST to /api/batch/ingest) ───────────────────────────

def advance_stage_assemble():
    """For each ready_to_assemble row, POST to /api/batch/ingest.
    The ingest route owns session insert + batch_queue → done."""
    if not DEMO_BUILDER_API_URL:
        return
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.ready_to_assemble",
            "select": "id,name,pt_record_id",
            "limit": "5",
        })
    except Exception as e:
        print(f"[S5] Supabase error: {e}")
        return

    for job in rows:
        jid = job["id"]
        name = job["name"]
        print(f"\n[S5] {jid[:8]}  {name}")
        try:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "assembling",
                "updated_at": _now_iso(),
            })
            resp = requests.post(
                f"{DEMO_BUILDER_API_URL}/api/batch/ingest",
                json={"queue_id": jid},
                timeout=310,
            )
            result = resp.json()
            if result.get("ok"):
                session_id = result["session_id"]
                try:
                    sessions = supabase_get("sessions", {
                        "id": f"eq.{session_id}",
                        "select": "generated_sql",
                    })
                    if sessions and sessions[0].get("generated_sql"):
                        save_snapshot(
                            job.get("pt_record_id"), name, session_id,
                            sessions[0]["generated_sql"],
                            allow_versioning=False,
                        )
                except Exception as e:
                    print(f"  [SNAP] {e}")
                print(f"  [S5] ✓ session {session_id[:8]}  {result.get('stats')}")
            else:
                err = (result.get("error") or "assembly failed")[:500]
                supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                    "status": "failed",
                    "error": err,
                    "updated_at": _now_iso(),
                })
                print(f"  [S5] ✗ {err}")
        except Exception as e:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": str(e)[:500],
                "updated_at": _now_iso(),
            })
            print(f"  [S5] error: {e}")


# ── Stage PDF: batch PDF extraction via Sonnet vision ───────────────────────

PDF_BATCH_MODEL = "claude-sonnet-4-6"

def advance_stage_pdf():
    """Move needs_pdf rows into pool_pdf so the batch submitter can pick them up.
    There is no mechanical path for PDFs — every row goes straight to the pool."""
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.needs_pdf",
            "select": "id,name,menu_url",
            "limit": "50",
        })
    except Exception as e:
        print(f"[SPDF] Supabase error: {e}")
        return

    for job in rows:
        jid = job["id"]
        url = job.get("menu_url") or ""
        if not url or ".pdf" not in url.lower():
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": f"menu_url is not a PDF URL: {url[:120]}",
                "updated_at": _now_iso(),
            })
            print(f"[SPDF] {jid[:8]} → failed (not a PDF URL: {url[:60]})")
            continue
        supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
            "status": "pool_pdf",
            "updated_at": _now_iso(),
        })
        print(f"[SPDF] {jid[:8]} → pool_pdf  {url[:80]}")


def _submit_pdf_wave():
    """Submit a batch of PDF extraction requests using claude-sonnet-4-6 vision.
    Each request sends the PDF as a document block so Sonnet can read it visually.
    Results are stored in extraction_result and advance to ready_for_modifier."""
    if not _anthropic:
        return
    system_prompt = _STAGE_PROMPTS.get("MENU_EXTRACTION_SYSTEM_PROMPT")
    if not system_prompt:
        print("  [BATCH-PDF] missing MENU_EXTRACTION_SYSTEM_PROMPT — skipping")
        return
    try:
        pool = supabase_get("batch_queue", {
            "status": "eq.pool_pdf",
            "select": "id,name,menu_url,restaurant_type,updated_at",
            "order": "updated_at.asc",
            "limit": str(WAVE_MAX_SIZE),
        })
    except Exception as e:
        print(f"  [BATCH-PDF] fetch pool_pdf: {e}")
        return

    if not _wave_is_ready(pool):
        return

    pool = pool[:WAVE_MAX_SIZE]
    requests_list = []
    for row in pool:
        url = row.get("menu_url") or ""
        if not url:
            continue
        name = row.get("name") or "restaurant"
        rtype = row.get("restaurant_type") or "other"
        requests_list.append({
            "custom_id": row["id"],
            "params": {
                "model": PDF_BATCH_MODEL,
                "max_tokens": 32000,
                "system": [{
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                }],
                "messages": [{"role": "user", "content": [
                    {
                        "type": "document",
                        "source": {"type": "url", "url": url},
                        "cache_control": {"type": "ephemeral", "ttl": "1h"},
                    },
                    {
                        "type": "text",
                        "text": (
                            f"Restaurant: {name}\nType: {rtype}\n\n"
                            "Extract all menu items from this PDF menu. "
                            "Follow the output schema exactly."
                        ),
                    },
                ]}],
            },
        })

    if not requests_list:
        return

    try:
        batch = _anthropic.messages.batches.create(requests=requests_list)
    except Exception as e:
        msg = str(e)
        if _API_LIMIT_PHRASE in msg.lower():
            print(f"  [BATCH-PDF] API limit hit — rows stay in pool_pdf")
            return
        print(f"  [BATCH-PDF] create failed: {e}")
        return

    now = _now_iso()
    for row in pool[:len(requests_list)]:
        supabase_patch("batch_queue", {"id": f"eq.{row['id']}"}, {
            "status": "batch_pdf_submitted",
            "pdf_batch_id": batch.id,
            "batch_submitted_at": now,
            "updated_at": now,
        })
    print(f"  [BATCH-PDF] submitted {len(requests_list)} PDF requests  {batch.id}")


def _poll_pdf_waves():
    """Poll batch_pdf_submitted rows. On success, store extraction_result and
    advance to ready_for_modifier (same downstream as text extraction)."""
    if not _anthropic:
        return
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.batch_pdf_submitted",
            "select": "id,pdf_batch_id,last_polled_at",
            "limit": "500",
        })
    except Exception as e:
        print(f"  [POLL-PDF] fetch: {e}")
        return
    if not rows:
        return

    batch_ids = {r.get("pdf_batch_id") for r in rows if r.get("pdf_batch_id")}
    for bid in batch_ids:
        try:
            status = _anthropic.messages.batches.retrieve(bid)
        except Exception as e:
            print(f"  [POLL-PDF] retrieve {bid}: {e}")
            continue
        if status.processing_status != "ended":
            continue
        try:
            results_iter = _anthropic.messages.batches.results(bid)
        except Exception as e:
            print(f"  [POLL-PDF] results {bid}: {e}")
            continue

        for entry in results_iter:
            cid = entry.custom_id
            result = entry.result
            if result.type == "succeeded":
                try:
                    text = result.message.content[0].text
                except Exception:
                    text = ""
                ok, parsed = _parse_extract(text)
                if ok:
                    supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                        "status": "ready_for_modifier",
                        "extraction_result": parsed,
                        "last_polled_at": _now_iso(),
                        "updated_at": _now_iso(),
                    })
                else:
                    supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                        "status": "failed",
                        "error": (parsed or "PDF extraction: unparseable response")[:500],
                        "last_polled_at": _now_iso(),
                        "updated_at": _now_iso(),
                    })
            else:
                err_type = getattr(result, "type", "errored")
                supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                    "status": "failed",
                    "error": f"PDF batch {err_type}",
                    "last_polled_at": _now_iso(),
                    "updated_at": _now_iso(),
                })
        print(f"  [POLL-PDF] drained batch {bid}")


# ── Image-menu pipeline (Wix-style photo-gallery menus) ─────────────────────
# Mirrors the PDF pipeline, but sends multiple image blocks per request instead
# of a single document block. Triggered by stage 2 detecting ≥1 large menu image
# on a page with sparse text, which sets status=needs_image_menu and stashes
# the image URLs in extraction_result.image_menu_urls.

IMAGE_MENU_BATCH_MODEL = "claude-sonnet-4-6"
IMAGE_MENU_MAX_IMAGES = 6  # Cap per-request images to keep batch cost bounded


def advance_stage_image_menu():
    """Move needs_image_menu rows into pool_image_menu."""
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.needs_image_menu",
            "select": "id,name,menu_url,extraction_result",
            "limit": "50",
        })
    except Exception as e:
        print(f"[SIMG] Supabase error: {e}")
        return

    for job in rows:
        jid = job["id"]
        er = job.get("extraction_result") or {}
        urls = er.get("image_menu_urls") if isinstance(er, dict) else None
        if not urls:
            supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                "status": "failed",
                "error": "needs_image_menu but no image_menu_urls in extraction_result",
                "updated_at": _now_iso(),
            })
            print(f"[SIMG] {jid[:8]} → failed (no urls)")
            continue
        supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
            "status": "pool_image_menu",
            "updated_at": _now_iso(),
        })
        print(f"[SIMG] {jid[:8]} → pool_image_menu ({len(urls)} imgs)")


def _submit_image_menu_wave():
    """Submit a batch of image-menu extraction requests using Sonnet vision.
    Each request sends up to IMAGE_MENU_MAX_IMAGES image blocks plus the user
    prompt. On success results flow into extraction_result and advance to
    ready_for_modifier."""
    if not _anthropic:
        return
    system_prompt = _STAGE_PROMPTS.get("MENU_EXTRACTION_SYSTEM_PROMPT")
    if not system_prompt:
        print("  [BATCH-IMG] missing MENU_EXTRACTION_SYSTEM_PROMPT — skipping")
        return
    try:
        pool = supabase_get("batch_queue", {
            "status": "eq.pool_image_menu",
            "select": "id,name,menu_url,restaurant_type,extraction_result,updated_at",
            "order": "updated_at.asc",
            "limit": str(WAVE_MAX_SIZE),
        })
    except Exception as e:
        print(f"  [BATCH-IMG] fetch pool_image_menu: {e}")
        return

    if not _wave_is_ready(pool):
        return

    pool = pool[:WAVE_MAX_SIZE]
    requests_list = []
    for row in pool:
        er = row.get("extraction_result") or {}
        urls = er.get("image_menu_urls") if isinstance(er, dict) else None
        if not urls:
            continue
        name = row.get("name") or "restaurant"
        rtype = row.get("restaurant_type") or "other"
        image_blocks = []
        for i, u in enumerate(urls[:IMAGE_MENU_MAX_IMAGES]):
            block = {
                "type": "image",
                "source": {"type": "url", "url": u},
            }
            # Cache only the first image — lets subsequent requests in the
            # batch benefit from prompt caching on the system prompt.
            if i == 0:
                block["cache_control"] = {"type": "ephemeral"}
            image_blocks.append(block)

        requests_list.append({
            "custom_id": row["id"],
            "params": {
                "model": IMAGE_MENU_BATCH_MODEL,
                "max_tokens": 32000,
                "system": [{
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                }],
                "messages": [{"role": "user", "content": [
                    *image_blocks,
                    {
                        "type": "text",
                        "text": (
                            f"Restaurant: {name}\nType: {rtype}\n\n"
                            f"Extract all menu items from these {len(image_blocks)} "
                            "menu image(s). Each image is a photograph of a physical "
                            "menu. Read item names, prices, and categories directly "
                            "from the images. Follow the output schema exactly."
                        ),
                    },
                ]}],
            },
        })

    if not requests_list:
        return

    try:
        batch = _anthropic.messages.batches.create(requests=requests_list)
    except Exception as e:
        msg = str(e)
        if _API_LIMIT_PHRASE in msg.lower():
            print(f"  [BATCH-IMG] API limit hit — rows stay in pool_image_menu")
            return
        print(f"  [BATCH-IMG] create failed: {e}")
        return

    now = _now_iso()
    for row in pool[:len(requests_list)]:
        supabase_patch("batch_queue", {"id": f"eq.{row['id']}"}, {
            "status": "batch_image_menu_submitted",
            "image_menu_batch_id": batch.id,
            "batch_submitted_at": now,
            "updated_at": now,
        })
    print(f"  [BATCH-IMG] submitted {len(requests_list)} image-menu requests  {batch.id}")


def _poll_image_menu_waves():
    """Poll batch_image_menu_submitted rows. On success store extraction_result
    and advance to ready_for_modifier."""
    if not _anthropic:
        return
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.batch_image_menu_submitted",
            "select": "id,image_menu_batch_id,last_polled_at",
            "limit": "500",
        })
    except Exception as e:
        print(f"  [POLL-IMG] fetch: {e}")
        return
    if not rows:
        return

    batch_ids = {r.get("image_menu_batch_id") for r in rows if r.get("image_menu_batch_id")}
    for bid in batch_ids:
        try:
            status = _anthropic.messages.batches.retrieve(bid)
        except Exception as e:
            print(f"  [POLL-IMG] retrieve {bid}: {e}")
            continue
        if status.processing_status != "ended":
            continue
        try:
            results_iter = _anthropic.messages.batches.results(bid)
        except Exception as e:
            print(f"  [POLL-IMG] results {bid}: {e}")
            continue

        for entry in results_iter:
            cid = entry.custom_id
            result = entry.result
            if result.type == "succeeded":
                try:
                    text = result.message.content[0].text
                except Exception:
                    text = ""
                ok, parsed = _parse_extract(text)
                if ok:
                    supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                        "status": "ready_for_modifier",
                        "extraction_result": parsed,
                        "last_polled_at": _now_iso(),
                        "updated_at": _now_iso(),
                    })
                else:
                    supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                        "status": "failed",
                        "error": (parsed or "image-menu extraction: unparseable response")[:500],
                        "last_polled_at": _now_iso(),
                        "updated_at": _now_iso(),
                    })
            else:
                err_type = getattr(result, "type", "errored")
                supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                    "status": "failed",
                    "error": f"image-menu batch {err_type}",
                    "last_polled_at": _now_iso(),
                    "updated_at": _now_iso(),
                })
        print(f"  [POLL-IMG] drained batch {bid}")


# ── Batch wave submit / poll helpers ────────────────────────────────────────

def _submit_wave(pool_status, submitted_status, batch_id_col,
                 prompt_name, build_user_message, select_cols):
    """Generic stage-wave submitter.
      pool_status:      e.g. 'pool_discover'
      submitted_status: e.g. 'batch_discover_submitted'
      batch_id_col:     column to write the batch id into
      prompt_name:      key in _STAGE_PROMPTS
      build_user_message(row) -> user-message string
      select_cols:      Supabase select list (comma-separated)
    """
    if not _anthropic:
        return
    system_prompt = _STAGE_PROMPTS.get(prompt_name)
    if not system_prompt:
        print(f"  [BATCH] missing prompt {prompt_name} — skipping")
        return
    try:
        pool = supabase_get("batch_queue", {
            "status": f"eq.{pool_status}",
            "select": select_cols,
            "order": "updated_at.asc",
            "limit": str(WAVE_MAX_SIZE),
        })
    except Exception as e:
        print(f"  [BATCH] fetch pool {pool_status}: {e}")
        return

    if not _wave_is_ready(pool):
        return

    pool = pool[:WAVE_MAX_SIZE]
    requests_list = []
    for row in pool:
        try:
            user_msg = build_user_message(row)
        except Exception as e:
            print(f"  [BATCH] build user msg for {row['id'][:8]}: {e}")
            continue
        if not user_msg:
            continue
        requests_list.append({
            "custom_id": row["id"],
            "params": {
                "model": BATCH_MODEL,
                "max_tokens": 32000,
                "system": [{
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                }],
                "messages": [{"role": "user", "content": user_msg}],
            },
        })

    if not requests_list:
        return

    try:
        batch = _anthropic.messages.batches.create(requests=requests_list)
    except Exception as e:
        msg = str(e)
        if _API_LIMIT_PHRASE in msg.lower():
            print(f"  [BATCH] API limit hit on create — rows stay in pool")
            return
        print(f"  [BATCH] create failed: {e}")
        return

    now = _now_iso()
    for row in pool[:len(requests_list)]:
        supabase_patch("batch_queue", {"id": f"eq.{row['id']}"}, {
            "status": submitted_status,
            batch_id_col: batch.id,
            "stage_custom_id": row["id"],
            "batch_submitted_at": now,
            "updated_at": now,
        })
    print(f"  [BATCH] submitted {len(requests_list)} requests  {batch.id} ({pool_status})")


def _poll_waves(submitted_status, batch_id_col, result_col, next_status,
                parse_result, retain_on_failed=None):
    """Generic stage-wave poller. For each distinct in-flight batch_id, retrieve
    status; when ended, stream results and update rows.
      parse_result(message_text) -> (ok, parsed_json_or_error_string)
      retain_on_failed: optional status to set on rows whose request errored
                       (default: 'failed')
    """
    if not _anthropic:
        return
    try:
        rows = supabase_get("batch_queue", {
            "status": f"eq.{submitted_status}",
            "select": f"id,{batch_id_col},last_polled_at",
            "limit": "500",
        })
    except Exception as e:
        print(f"  [POLL] fetch {submitted_status}: {e}")
        return
    if not rows:
        return

    batch_ids = {r.get(batch_id_col) for r in rows if r.get(batch_id_col)}
    for bid in batch_ids:
        try:
            status = _anthropic.messages.batches.retrieve(bid)
        except Exception as e:
            print(f"  [POLL] retrieve {bid}: {e}")
            continue
        if status.processing_status != "ended":
            continue

        try:
            results_iter = _anthropic.messages.batches.results(bid)
        except Exception as e:
            print(f"  [POLL] results {bid}: {e}")
            continue

        for entry in results_iter:
            cid = entry.custom_id
            result = entry.result
            if result.type == "succeeded":
                try:
                    text = result.message.content[0].text
                except Exception:
                    text = ""
                ok, parsed = parse_result(text)
                if ok:
                    supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                        "status": next_status,
                        result_col: parsed,
                        "last_polled_at": _now_iso(),
                        "updated_at": _now_iso(),
                    })
                else:
                    supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                        "status": retain_on_failed or "failed",
                        "error": (parsed or "unparseable AI response")[:500],
                        "last_polled_at": _now_iso(),
                        "updated_at": _now_iso(),
                    })
            else:
                err_type = getattr(result, "type", "errored")
                err_msg = f"batch {err_type}"
                supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                    "status": retain_on_failed or "failed",
                    "error": err_msg[:500],
                    "last_polled_at": _now_iso(),
                    "updated_at": _now_iso(),
                })
        print(f"  [POLL] drained batch {bid}")


# ── Stage-specific wave builders + parsers ──────────────────────────────────

def _build_discover_msg(row):
    html = row.get("homepage_html") or ""
    if not html:
        return None
    return (
        f"Base URL: {row.get('menu_url')}\n\n"
        f"Homepage HTML (trimmed):\n{html[:18_000]}"
    )


def _parse_discover(text):
    obj = _parse_ai_json(text)
    if not isinstance(obj, dict):
        return False, "not JSON"
    url = obj.get("url")
    if not url:
        return False, "no url returned"
    return True, {"discover_url": url, "confidence": obj.get("confidence")}


def _build_extract_msg(row):
    raw = row.get("raw_text") or ""
    if not raw:
        return None
    # 20K cap: menu content is almost always in the first 15-20K tokens. Halves
    # input cost vs the prior 30K (Haiku input at $0.50/Mtok batch rate).
    return f"Restaurant: {row.get('name')}\n\nMenu page text:\n{raw[:20_000]}"


def _parse_extract(text):
    obj = _parse_ai_json(text)
    if not isinstance(obj, dict):
        return False, "not JSON"
    if not obj.get("items"):
        return False, "no items"
    return True, obj


def _build_modifier_msg(row):
    extraction = row.get("extraction_result") or {}
    items = extraction.get("items") or []
    if not items:
        return None
    slim = [{
        "Menu Item Full Name": i.get("Menu Item Full Name"),
        "Menu Item Group": i.get("Menu Item Group"),
        "Menu Item Category": i.get("Menu Item Category"),
    } for i in items[:200]]
    payload = {
        "restaurantType": extraction.get("restaurantType") or row.get("restaurant_type") or "other",
        "items": slim,
    }
    return json.dumps(payload)


def _parse_modifier(text):
    obj = _parse_ai_json(text)
    if not isinstance(obj, dict):
        return False, "not JSON"
    if "modifierTemplates" not in obj:
        return False, "no modifierTemplates"
    return True, obj


def _build_branding_msg(row):
    html = (row.get("homepage_html") or "")[:18_000]
    return json.dumps({
        "url": row.get("menu_url"),
        "name": row.get("name"),
        "restaurantType": row.get("restaurant_type") or "other",
        "html_snippet": html,
    })


def _parse_branding(text):
    obj = _parse_ai_json(text)
    if not isinstance(obj, dict):
        return False, "not JSON"
    if not obj.get("buttons_background_color"):
        return False, "no buttons_background_color"
    return True, obj


# ── Discover poller specialization: writes menu_url + transitions state ────

def _poll_discover_waves():
    """Poll discover batches — results need to flip to ready_for_extract and
    set menu_url from the AI result, not into a result_col."""
    if not _anthropic:
        return
    try:
        rows = supabase_get("batch_queue", {
            "status": "eq.batch_discover_submitted",
            "select": "id,discover_batch_id",
            "limit": "500",
        })
    except Exception as e:
        print(f"  [POLL-S1] fetch: {e}")
        return
    if not rows:
        return
    batch_ids = {r.get("discover_batch_id") for r in rows if r.get("discover_batch_id")}
    for bid in batch_ids:
        try:
            status = _anthropic.messages.batches.retrieve(bid)
        except Exception as e:
            print(f"  [POLL-S1] retrieve {bid}: {e}")
            continue
        if status.processing_status != "ended":
            continue
        try:
            results_iter = _anthropic.messages.batches.results(bid)
        except Exception as e:
            print(f"  [POLL-S1] results {bid}: {e}")
            continue

        for entry in results_iter:
            cid = entry.custom_id
            result = entry.result
            if result.type == "succeeded":
                try:
                    text = result.message.content[0].text
                except Exception:
                    text = ""
                ok, parsed = _parse_discover(text)
                if ok:
                    supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                        "status": "ready_for_extract",
                        "menu_url": parsed["discover_url"],
                        "last_polled_at": _now_iso(),
                        "updated_at": _now_iso(),
                    })
                else:
                    supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                        "status": "failed",
                        "error": (parsed or "no menu url")[:500],
                        "last_polled_at": _now_iso(),
                        "updated_at": _now_iso(),
                    })
            else:
                err_type = getattr(result, "type", "errored")
                supabase_patch("batch_queue", {"id": f"eq.{cid}"}, {
                    "status": "failed",
                    "error": f"batch {err_type}",
                    "last_polled_at": _now_iso(),
                    "updated_at": _now_iso(),
                })
        print(f"  [POLL-S1] drained {bid}")


# ── Top-level driver ────────────────────────────────────────────────────────

def run_staged_pipeline():
    """Run one tick of the 4-stage batch pipeline: per-job advance, then
    wave submissions, then wave polling. Safe to call each main-loop cycle."""
    advance_stage_discover()
    advance_stage_extract()
    advance_stage_modifier()
    advance_stage_branding()
    advance_stage_assemble()
    advance_stage_pdf()
    advance_stage_image_menu()

    try:
        _submit_wave(
            pool_status="pool_discover",
            submitted_status="batch_discover_submitted",
            batch_id_col="discover_batch_id",
            prompt_name="DISCOVERY_SYSTEM_PROMPT",
            build_user_message=_build_discover_msg,
            select_cols="id,menu_url,homepage_html,updated_at",
        )
        _submit_wave(
            pool_status="pool_extract",
            submitted_status="batch_extract_submitted",
            batch_id_col="extract_batch_id",
            prompt_name="MENU_EXTRACTION_SYSTEM_PROMPT",
            build_user_message=_build_extract_msg,
            select_cols="id,name,raw_text,updated_at",
        )
        _submit_wave(
            pool_status="pool_modifier",
            submitted_status="batch_modifier_submitted",
            batch_id_col="modifier_batch_id",
            prompt_name="MODIFIER_INFERENCE_SYSTEM_PROMPT",
            build_user_message=_build_modifier_msg,
            select_cols="id,restaurant_type,extraction_result,updated_at",
        )
        _submit_wave(
            pool_status="pool_branding",
            submitted_status="batch_branding_submitted",
            batch_id_col="branding_batch_id",
            prompt_name="BRANDING_TOKENS_SYSTEM_PROMPT",
            build_user_message=_build_branding_msg,
            select_cols="id,name,menu_url,restaurant_type,homepage_html,updated_at",
        )
        _submit_pdf_wave()
        _submit_image_menu_wave()
    except Exception as e:
        print(f"[WAVE] submit error: {e}")

    try:
        _poll_discover_waves()
        _poll_waves(
            submitted_status="batch_extract_submitted",
            batch_id_col="extract_batch_id",
            result_col="extraction_result",
            next_status="ready_for_modifier",
            parse_result=_parse_extract,
        )
        _poll_waves(
            submitted_status="batch_modifier_submitted",
            batch_id_col="modifier_batch_id",
            result_col="modifier_result",
            next_status="ready_for_branding",
            parse_result=_parse_modifier,
        )
        _poll_waves(
            submitted_status="batch_branding_submitted",
            batch_id_col="branding_batch_id",
            result_col="branding_result",
            next_status="ready_to_assemble",
            parse_result=_parse_branding,
        )
        _poll_pdf_waves()
        _poll_image_menu_waves()
    except Exception as e:
        print(f"[POLL] error: {e}")


def _handle_process_result(job: dict, jid: str, result: dict, label: str) -> bool:
    """Handle a /api/batch/process response: save snapshot on success, log either way.

    Returns True on success (caller should `continue` to next job),
    False on failure (caller handles marking the job failed).
    Raises _ApiLimitHit when the Anthropic API rate limit is hit — the caller
    must requeue the job and stop processing further jobs this cycle.
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

    if _API_LIMIT_PHRASE in error_msg.lower():
        raise _ApiLimitHit(error_msg)

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

        except _ApiLimitHit as e:
            # Anthropic API usage cap hit — requeue this job so it retries
            # automatically when the limit resets, then stop processing.
            print(f"  [LIMIT] Anthropic API limit hit — requeueing {jid[:8]} and pausing batch")
            try:
                supabase_patch("batch_queue", {"id": f"eq.{jid}"}, {
                    "status": "queued",
                    "error": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass
            return  # stop processing further jobs this cycle

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
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Batch pipeline CLI — operator-invoked only, never a daemon.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Subcommands:
  run-staged    Run one tick of the staged pipeline (discover → extract → modifier
                → branding → assemble). Does NOT loop — wrap in a shell loop if
                repeated ticks are needed.
  retry-failed  Not yet implemented. Use rebuild_batch.py for retries.
  dry-run       Import and invoke dryrun_staged.main() for a watched dry run
                of the staged pipeline against TRACKED_IDS.
""",
    )
    ap.add_argument("subcommand", choices=["run-staged", "retry-failed", "dry-run"])
    args = ap.parse_args()

    if args.subcommand == "run-staged":
        if not SUPABASE_URL or not SUPABASE_KEY:
            print("ERROR: SUPABASE_URL and SUPABASE_KEY must be set in agent/.env")
            sys.exit(1)
        print("batch_pipeline: run-staged (single tick)")
        run_staged_pipeline()

    elif args.subcommand == "retry-failed":
        print("retry-failed: not implemented yet — use rebuild_batch.py for retries")
        sys.exit(1)

    elif args.subcommand == "dry-run":
        import dryrun_staged
        dryrun_staged.main()


if __name__ == "__main__":
    main()
