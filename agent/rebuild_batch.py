#!/usr/bin/env python3
"""
Demo Builder Rebuild Agent (single-shot)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Replacement for the wave-based staged pipeline in deploy_agent.py.
Single-shot CLI. Runs all mechanical work first, then (in later PRs)
submits one Anthropic batch per stage-dependency boundary.

PR1 scope: DRY-RUN ONLY. This command populates batch_queue.preflight
JSONB + tags each row with rebuild_run_id, computes bucket counts and
projected AI cost, and prints a summary. It does NOT submit any batches
and does NOT mutate status / extraction_result / session linkage.

Non-dry-run invocations hard-error. PR3 adds stage batch submission.

Usage:
    # fast classification using existing raw_text / homepage_html only
    python3 agent/rebuild_batch.py --dry-run

    # re-fetch pages that don't have cached html/text
    python3 agent/rebuild_batch.py --dry-run --fetch

    # subset by status (default: all statuses)
    python3 agent/rebuild_batch.py --dry-run \
        --status-filter done,failed,queued

Environment (inherited from deploy_agent.py .env):
    SUPABASE_URL, SUPABASE_KEY — Supabase DEV project credentials
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional
from urllib.parse import urlparse

# Mechanical helpers from pipeline_shared (PR2, 2026-04-16).
# _extract_branding_mechanical moved from deploy_agent to batch_pipeline in Phase 3.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline_shared import (  # noqa: E402
    supabase_get, HEADERS, SUPABASE_URL, SUPABASE_KEY,
    _extract_ldjson_menu_text, _fetch_homepage_html, fetch_page_text_curl_cffi,
    discover_menu_url, _detect_menu_images,
)
from batch_pipeline import _extract_branding_mechanical  # noqa: E402

import requests  # used for PATCH with rebuild_run_id  # noqa: E402


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

UrlClass = Literal[
    "html", "pdf", "social_dead", "hotel_dead",
    "direct_image", "unreachable",
]
FetchStatus = Literal[
    "ok", "cf_blocked", "timeout", "404",
    "redirect_offdomain", "error", "not_fetched",
]
ContentGate = Literal[
    "ok", "sparse", "nav_heavy", "no_price",
    "hard_fail", "not_evaluated",
]
AiStage = Literal[
    "discover", "extract", "modifier", "branding",
    "pdf", "image_menu",
]


@dataclass
class PreflightVerdict:
    row_id: str
    url_class: UrlClass
    fetch_status: FetchStatus
    menu_url_candidate: Optional[str]
    ldjson_items: int
    branding_tokens: Optional[dict]
    image_menu_urls: list[str]
    content_gate_verdict: ContentGate
    ai_needed: list[AiStage]
    error: Optional[str]
    classified_at: str


# ---------------------------------------------------------------------------
# URL classification (pure string, no network)
# ---------------------------------------------------------------------------

_SOCIAL_HOSTS = {
    "facebook.com", "m.facebook.com", "www.facebook.com",
    "instagram.com", "www.instagram.com",
    "twitter.com", "x.com", "www.x.com",
    "tiktok.com", "www.tiktok.com",
    "youtube.com", "www.youtube.com",
    "linkedin.com", "www.linkedin.com",
}

# Partial-match: host ending in any of these is a hotel aggregator landing page
# where the restaurant has no independent web presence we can scrape.
_HOTEL_HOST_SUFFIXES = (
    "hotels.com", "expedia.com", "booking.com", "hilton.com", "marriott.com",
    "hyatt.com", "ihg.com", "choicehotels.com", "wyndhamhotels.com",
    "tripadvisor.com", "kayak.com", "opentable.com",
)

_PDF_RE = re.compile(r"\.pdf(\?|$)", re.IGNORECASE)
_IMG_RE = re.compile(r"\.(jpe?g|png|gif|webp|bmp|tiff?|avif)(\?|$)", re.IGNORECASE)


def classify_url(url: str) -> UrlClass:
    """Classify a URL based on its host + extension. No network.

    Supersedes deploy_agent._classify_dead_url, which only distinguished
    social-dead from everything-else. Return values drive stage dispatch
    in Phase 3 (pdf → Sonnet PDF batch, direct_image → Sonnet image batch,
    etc.)."""
    if not url:
        return "unreachable"
    try:
        parsed = urlparse(url)
    except Exception:
        return "unreachable"
    host = (parsed.netloc or "").lower()
    if not host:
        return "unreachable"
    if host in _SOCIAL_HOSTS:
        return "social_dead"
    if any(host == s or host.endswith("." + s) for s in _HOTEL_HOST_SUFFIXES):
        return "hotel_dead"
    if _PDF_RE.search(url):
        return "pdf"
    if _IMG_RE.search(url):
        return "direct_image"
    return "html"


# ---------------------------------------------------------------------------
# Content gate (relaxed thresholds — see REFACTOR_PLAN §2)
# ---------------------------------------------------------------------------

_NAV_WORD_RE = re.compile(
    r"\b(?:home|menu|contact|about|order|location|hours|gallery|events|catering|"
    r"delivery|reservations?|gift|careers|blog|login|signup|subscribe|cart)\b",
    re.IGNORECASE,
)
_PRICE_RE = re.compile(r"\$\d+(?:\.\d{1,2})?")


def _classify_content_gate(text: str) -> ContentGate:
    """Relaxed replacement for deploy_agent._classify_extract_skip.

    Prior implementation hard-failed at <500 chars (23% false-positive rate
    on 2026-04-15 rebuild — 36 of 158 flagged rows actually succeeded when
    retried). New thresholds:
      - hard_fail: <200 chars AND <30 tokens   (no AI call)
      - sparse:    200-500 chars               (still goes to AI, tagged)
      - nav_heavy: nav_ratio>0.35 AND <3K      (still goes to AI, tagged)
      - no_price:  no prices AND >3K           (still goes to AI, tagged)
      - ok:        default
    """
    if not text:
        return "hard_fail"
    t = text.strip()
    n = len(t)
    tokens = t.split()
    if n < 200 and len(tokens) < 30:
        return "hard_fail"
    if n < 500:
        return "sparse"
    nav_hits = len(_NAV_WORD_RE.findall(t))
    nav_ratio = nav_hits / max(len(tokens), 1)
    if nav_ratio > 0.35 and n < 3_000:
        return "nav_heavy"
    if n > 3_000 and not _PRICE_RE.search(t):
        return "no_price"
    return "ok"


# ---------------------------------------------------------------------------
# Per-row preflight
# ---------------------------------------------------------------------------

# Cost per Anthropic batch request by stage (from 2026-04-16 actuals — see
# feedback_output_tokens_dominate_batch_cost.md). Output tokens dominate.
COST_PER_REQ_USD: dict[AiStage, float] = {
    "discover":   0.0020,
    "extract":    0.0031,
    "modifier":   0.0028,
    "branding":   0.0015,
    "pdf":        0.0250,
    "image_menu": 0.0220,
}


def _compute_ai_needed(
    url_class: UrlClass,
    content_gate_verdict: ContentGate,
    ldjson_items: int,
    menu_url_candidate: Optional[str],
    branding_tokens: Optional[dict],
    image_menu_urls: list[str],
    has_html: bool,
) -> list[AiStage]:
    """Decide which AI stages this row still needs.

    Rules:
      - Dead URL classes (social/hotel/unreachable) → ai_needed=[] (no AI rescue)
      - Content gate hard_fail → ai_needed=[] (not worth the AI call)
      - url_class='pdf' → pdf + modifier + maybe branding
      - url_class='direct_image' → image_menu + modifier + maybe branding
      - url_class='html':
          - ≥5 ld+json items → extract is mechanical; needs only modifier (+branding)
          - image_menu_urls non-empty on sparse page → image_menu + modifier (+branding)
          - no menu_url_candidate → discover + extract + modifier (+branding)
          - otherwise → extract + modifier (+branding)
    """
    if url_class in ("social_dead", "hotel_dead", "unreachable"):
        return []
    if content_gate_verdict == "hard_fail":
        return []

    needed: list[AiStage] = []

    if url_class == "pdf":
        needed.append("pdf")
    elif url_class == "direct_image":
        needed.append("image_menu")
    else:  # html
        if image_menu_urls and content_gate_verdict in ("sparse", "nav_heavy"):
            needed.append("image_menu")
        elif ldjson_items >= 5:
            pass  # extract is mechanical — no AI extract needed
        else:
            if not menu_url_candidate:
                needed.append("discover")
            needed.append("extract")

    # modifier always follows successful extraction (AI or mechanical)
    if needed or ldjson_items >= 5:
        needed.append("modifier")

    # branding: pay AI only if mechanical tokens missed AND we have html to work from
    if has_html and not branding_tokens:
        needed.append("branding")

    return needed


def preflight_row(row: dict, fetch: bool = False) -> PreflightVerdict:
    """Classify a single row. Pure-mechanical; no AI calls.

    fetch=False (default, fast): classify using data already in the row
    (menu_url + raw_text + homepage_html). Unclassifiable fields reported
    as 'not_fetched' / 'not_evaluated'.

    fetch=True: fetch homepage + menu_url fresh via curl_cffi if we don't
    have cached html/text."""
    row_id = row["id"]
    menu_url = row.get("menu_url") or ""
    url_class = classify_url(menu_url)

    fetch_status: FetchStatus = "not_fetched"
    raw_text = row.get("raw_text") or ""
    homepage_html = row.get("homepage_html") or ""
    error: Optional[str] = None
    menu_url_candidate: Optional[str] = None

    # Dead URL classes don't need fetch
    if url_class in ("social_dead", "hotel_dead"):
        gate = _classify_content_gate(raw_text) if raw_text else "not_evaluated"
        verdict = PreflightVerdict(
            row_id=row_id,
            url_class=url_class,
            fetch_status="not_fetched",
            menu_url_candidate=None,
            ldjson_items=0,
            branding_tokens=None,
            image_menu_urls=[],
            content_gate_verdict=gate,
            ai_needed=[],
            error=None,
            classified_at=_now_iso(),
        )
        return verdict

    # Re-fetch if requested AND we don't have html cached
    if fetch and not homepage_html and url_class == "html":
        try:
            fetched = _fetch_homepage_html(menu_url)
            if fetched:
                homepage_html = fetched
                fetch_status = "ok"
            else:
                fetch_status = "cf_blocked"
        except Exception as e:
            fetch_status = "error"
            error = f"fetch: {e}"[:200]

    if fetch and not raw_text and url_class == "html":
        try:
            fetched_text = fetch_page_text_curl_cffi(menu_url)
            if fetched_text:
                raw_text = fetched_text
                if fetch_status == "not_fetched":
                    fetch_status = "ok"
            elif fetch_status == "not_fetched":
                fetch_status = "cf_blocked"
        except Exception as e:
            if fetch_status == "not_fetched":
                fetch_status = "error"
                error = f"fetch_text: {e}"[:200]

    # If we have html, count ld+json items + try mechanical branding
    ldjson_items = 0
    branding_tokens: Optional[dict] = None
    if homepage_html:
        try:
            ld = _extract_ldjson_menu_text(homepage_html)
            # Rough proxy: each "Name — $price" line is an item
            ldjson_items = ld.count(" — $") if ld else 0
        except Exception:
            ldjson_items = 0
        try:
            branding_tokens = _extract_branding_mechanical(homepage_html)
        except Exception:
            branding_tokens = None

    # Content gate runs on whichever text source we have
    gate_input = raw_text or homepage_html
    gate = _classify_content_gate(gate_input) if gate_input else "not_evaluated"

    # Live menu-URL discovery (PR2): only in fetch=True mode, only when ld+json
    # didn't already find a usable menu on the homepage. Mechanical nav-scoring
    # + common-path probes run first; AI fallback is a last resort inside
    # discover_menu_url. Drops PR3's discover batch from ~1430 to ~200–400.
    if fetch and url_class == "html" and ldjson_items < 5 and menu_url:
        try:
            disc = discover_menu_url(menu_url)
            dtype = disc.get("type")
            durl = disc.get("url") or ""
            if dtype in ("html", "ldjson", "pdf", "platform") and durl and durl != menu_url:
                menu_url_candidate = durl
            elif dtype == "ldjson" and durl == menu_url:
                # Homepage already had ld+json — re-score item count off
                # discovery's own fetch instead of relying on pre-cached html.
                pass
        except Exception as e:
            # Discovery never raises per its own contract, but guard anyway —
            # preflight must not fail on a single row's network hiccup.
            error = (error or f"discover: {e}"[:200])

    # image_menu_urls: run the Playwright probe live in fetch mode when the
    # page is sparse/nav_heavy (Wix/Squarespace gallery pattern). Otherwise
    # fall back to any cached value from a prior wave.
    image_menu_urls: list[str] = []
    er = row.get("extraction_result")
    if isinstance(er, dict):
        urls = er.get("image_menu_urls")
        if isinstance(urls, list):
            image_menu_urls = [u for u in urls if isinstance(u, str)]
    if (
        fetch
        and not image_menu_urls
        and url_class == "html"
        and gate in ("sparse", "nav_heavy")
    ):
        probe_url = menu_url_candidate or menu_url
        if probe_url:
            try:
                image_menu_urls = _detect_menu_images(probe_url)
            except Exception:
                image_menu_urls = []

    ai_needed = _compute_ai_needed(
        url_class=url_class,
        content_gate_verdict=gate,
        ldjson_items=ldjson_items,
        menu_url_candidate=menu_url_candidate,
        branding_tokens=branding_tokens,
        image_menu_urls=image_menu_urls,
        has_html=bool(homepage_html),
    )

    return PreflightVerdict(
        row_id=row_id,
        url_class=url_class,
        fetch_status=fetch_status,
        menu_url_candidate=menu_url_candidate,
        ldjson_items=ldjson_items,
        branding_tokens=branding_tokens,
        image_menu_urls=image_menu_urls,
        content_gate_verdict=gate,
        ai_needed=ai_needed,
        error=error,
        classified_at=_now_iso(),
    )


# ---------------------------------------------------------------------------
# Supabase IO
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def supabase_patch_preflight(row_id: str, verdict: PreflightVerdict, run_id: str):
    """Persist verdict + rebuild_run_id + preflight_run_at. Separate helper so
    we can batch or retry independently of other writes."""
    url = f"{SUPABASE_URL}/rest/v1/batch_queue"
    data = {
        "preflight": asdict(verdict),
        "preflight_run_at": verdict.classified_at,
        "rebuild_run_id": run_id,
    }
    r = requests.patch(
        url,
        headers=HEADERS,
        params={"id": f"eq.{row_id}"},
        json=data,
        timeout=15,
    )
    r.raise_for_status()


def fetch_rows(status_filter: Optional[list[str]]) -> list[dict]:
    """Pull all batch_queue rows (paginated) matching status_filter.
    status_filter=None pulls every row."""
    all_rows: list[dict] = []
    offset = 0
    page_size = 1000
    select = (
        "id,pt_record_id,name,menu_url,restaurant_type,status,"
        "raw_text,homepage_html,extraction_result,branding_result"
    )
    while True:
        params = {
            "select": select,
            "limit": str(page_size),
            "offset": str(offset),
            "order": "created_at.asc",
        }
        if status_filter:
            params["status"] = f"in.({','.join(status_filter)})"
        url = f"{SUPABASE_URL}/rest/v1/batch_queue"
        r = requests.get(
            url,
            headers={**HEADERS, "Accept": "application/json",
                     "Range-Unit": "items",
                     "Range": f"{offset}-{offset + page_size - 1}"},
            params=params,
            timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        if not isinstance(batch, list):
            raise RuntimeError(f"expected list, got {type(batch).__name__}: {batch!r:.200}")
        all_rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return all_rows


# ---------------------------------------------------------------------------
# Phase 1: run preflight across all rows
# ---------------------------------------------------------------------------

def run_preflight(rows: list[dict], run_id: str, workers: int, fetch: bool) -> list[PreflightVerdict]:
    """Parallel-classify all rows and persist verdicts. Returns verdict list."""
    verdicts: list[PreflightVerdict] = []
    errors: list[tuple[str, str]] = []
    start = time.time()
    total = len(rows)
    done = 0

    def _one(row):
        v = preflight_row(row, fetch=fetch)
        supabase_patch_preflight(row["id"], v, run_id)
        return v

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_one, row): row for row in rows}
        for fut in as_completed(futures):
            row = futures[fut]
            try:
                v = fut.result()
                verdicts.append(v)
            except Exception as e:
                errors.append((row.get("id", "?"), f"{type(e).__name__}: {e}"))
            done += 1
            if done % 100 == 0 or done == total:
                elapsed = time.time() - start
                rate = done / elapsed if elapsed else 0
                print(f"  [PREFLIGHT] {done}/{total}  {rate:.1f}/s  errors={len(errors)}")

    if errors:
        print(f"\n  [PREFLIGHT] {len(errors)} errors (first 10):")
        for rid, msg in errors[:10]:
            print(f"    {rid[:8]}  {msg}")

    return verdicts


# ---------------------------------------------------------------------------
# Phase 2: cost projection
# ---------------------------------------------------------------------------

def project_cost(verdicts: list[PreflightVerdict]) -> tuple[dict[AiStage, int], float]:
    """Sum per-stage request counts from verdicts, return (counts, total_usd)."""
    counts: dict[AiStage, int] = {s: 0 for s in COST_PER_REQ_USD.keys()}
    for v in verdicts:
        for stage in v.ai_needed:
            if stage in counts:
                counts[stage] += 1
    total = sum(counts[s] * COST_PER_REQ_USD[s] for s in counts)
    return counts, total


def print_preflight_summary(verdicts: list[PreflightVerdict]):
    """Print bucket counts + cost projection. Format matches REFACTOR_PLAN §5."""
    total = len(verdicts)
    print(f"\n{'=' * 68}")
    print(f"PREFLIGHT SUMMARY — {total} rows classified")
    print("=" * 68)

    url_class_counts: dict[str, int] = {}
    for v in verdicts:
        url_class_counts[v.url_class] = url_class_counts.get(v.url_class, 0) + 1
    print("\nURL class:")
    for cls in ("html", "pdf", "direct_image", "social_dead",
                "hotel_dead", "unreachable"):
        n = url_class_counts.get(cls, 0)
        pct = 100.0 * n / total if total else 0
        print(f"  {cls:<16}  {n:>5}  ({pct:.1f}%)")

    gate_counts: dict[str, int] = {}
    for v in verdicts:
        gate_counts[v.content_gate_verdict] = gate_counts.get(v.content_gate_verdict, 0) + 1
    print("\nContent gate:")
    for g in ("ok", "sparse", "nav_heavy", "no_price",
              "hard_fail", "not_evaluated"):
        n = gate_counts.get(g, 0)
        pct = 100.0 * n / total if total else 0
        print(f"  {g:<16}  {n:>5}  ({pct:.1f}%)")

    needs_ai = sum(1 for v in verdicts if v.ai_needed)
    fully_mech = sum(1 for v in verdicts if not v.ai_needed)
    print(f"\nAI disposition:")
    print(f"  fully_mechanical  {fully_mech:>5}  ({100.0*fully_mech/total:.1f}%)")
    print(f"  ai_needed         {needs_ai:>5}  ({100.0*needs_ai/total:.1f}%)")

    counts, total_usd = project_cost(verdicts)
    print(f"\nAI request volume + projected cost (batch-API 50% discount):")
    for stage, n in counts.items():
        unit = COST_PER_REQ_USD[stage]
        print(f"  {stage:<12}  {n:>5} reqs × ${unit:.4f}  = ${n * unit:.2f}")
    print(f"  {'TOTAL':<12}  {'':>5}                  = ${total_usd:.2f}")
    print("=" * 68)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="Single-shot batch rebuild agent (PR1 = preflight + dry-run only).",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Required. PR1 supports dry-run only.",
    )
    p.add_argument(
        "--status-filter", default=None,
        help="Comma-separated list of batch_queue.status values to include. "
             "Default: all rows.",
    )
    p.add_argument(
        "--run-id", default=None,
        help="Optional rebuild_run_id to tag rows with. Auto-generated if absent.",
    )
    p.add_argument(
        "--workers", type=int, default=24,
        help="Parallel preflight workers (default 24).",
    )
    p.add_argument(
        "--fetch", action="store_true",
        help="Re-fetch homepage/menu pages if raw_text/homepage_html is empty. "
             "Default: classify from cached columns only (much faster).",
    )
    p.add_argument(
        "--limit", type=int, default=None,
        help="Optional row cap, useful for smoke-testing before a full run.",
    )
    return p.parse_args()


def main():
    args = parse_args()

    if not args.dry_run:
        sys.stderr.write(
            "ERROR: PR1 is dry-run only. Pass --dry-run.\n"
            "       Non-dry-run (actual AI batch submission) ships in PR3.\n"
        )
        sys.exit(2)

    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.stderr.write(
            "ERROR: SUPABASE_URL / SUPABASE_KEY not set. Check agent/.env.\n"
        )
        sys.exit(2)

    run_id = args.run_id or f"dry-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}"
    status_filter = None
    if args.status_filter:
        status_filter = [s.strip() for s in args.status_filter.split(",") if s.strip()]

    print(f"[PREFLIGHT] run_id={run_id}")
    print(f"[PREFLIGHT] status_filter={status_filter or 'ALL'}")
    print(f"[PREFLIGHT] workers={args.workers}  fetch={args.fetch}  limit={args.limit}")

    print(f"\n[PREFLIGHT] Fetching rows from Supabase...")
    rows = fetch_rows(status_filter)
    if args.limit:
        rows = rows[: args.limit]
    print(f"[PREFLIGHT] {len(rows)} rows to classify\n")

    if not rows:
        print("[PREFLIGHT] no rows — exiting")
        return

    verdicts = run_preflight(rows, run_id, workers=args.workers, fetch=args.fetch)
    print_preflight_summary(verdicts)
    print(f"\n[PREFLIGHT] run_id={run_id}")


if __name__ == "__main__":
    main()
