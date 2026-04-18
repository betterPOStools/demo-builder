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

import hashlib  # batch_key content hashing  # noqa: E402
import requests  # used for PATCH with rebuild_run_id  # noqa: E402

import anthropic  # noqa: E402

from pipeline_shared import (  # noqa: E402, F811
    STAGES, log_event, assert_schema, _now_iso as _ps_now_iso,
)


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
# Stage batch submission (§2.5, §2.5a)
# ---------------------------------------------------------------------------
#
# `submit_batch` is the single write-point to Anthropic's Messages Batches
# API. It is **idempotent across process crashes** via §2.5a pre-submit
# orphan reconciliation: before creating any new Anthropic batch it queries
# `batches.list` filtered to this rebuild_run_id + stage + batch_key. If a
# matching batch already exists (because a prior process died between
# `batches.create` and the Supabase PATCH), the ID is adopted instead of
# double-billing.
#
# `batch_key` is a deterministic content hash of the sorted row IDs covered
# by a batch — same input set always hashes to the same key, so an orphan
# is recognizable even if NO Supabase row ever recorded the batch_id.

_ANTHROPIC_CLIENT: Optional[anthropic.Anthropic] = None


def _get_anthropic_client() -> anthropic.Anthropic:
    global _ANTHROPIC_CLIENT
    if _ANTHROPIC_CLIENT is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set in agent/.env")
        _ANTHROPIC_CLIENT = anthropic.Anthropic(api_key=api_key)
    return _ANTHROPIC_CLIENT


def build_batch_key(row_ids: list[str]) -> str:
    """Deterministic content hash of the row set in a batch. Same input rows
    always produce the same key, so a crash-orphaned Anthropic batch can be
    adopted on resume without re-submission (§2.5a)."""
    joined = ",".join(sorted(row_ids))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def reconcile_orphan_batches(
    stage: str, run_id: str, run_start_ts: datetime,
) -> dict[str, str]:
    """Find Anthropic batches this rebuild_run_id already created for `stage`
    that may not be recorded in Supabase.

    Returns {batch_key: anthropic_batch_id}. Pages Anthropic's batches.list
    until the page's oldest batch predates run_start_ts (no older batch can
    belong to this run). Only batches in ('in_progress', 'ended') are
    adopted — 'canceled' / 'expired' stay visible for drain but aren't
    treated as in-flight for re-submission avoidance.

    Called once per `submit_batch` invocation before any `batches.create`.
    """
    client = _get_anthropic_client()
    orphans: dict[str, str] = {}
    after_id: Optional[str] = None
    while True:
        page_kwargs = {"limit": 100}
        if after_id is not None:
            page_kwargs["after_id"] = after_id
        page = client.messages.batches.list(**page_kwargs)
        page_data = list(page.data)
        if not page_data:
            break
        for batch in page_data:
            created_at = batch.created_at
            if hasattr(created_at, "timestamp"):
                created_ts = created_at
            else:
                # SDK returns tz-aware datetime; fall through
                created_ts = created_at
            if created_ts < run_start_ts:
                return orphans  # past the run window; stop paging
            meta = dict(batch.metadata or {})
            if (
                meta.get("rebuild_run_id") == run_id
                and meta.get("stage") == stage
                and batch.processing_status in ("in_progress", "ended")
            ):
                key = meta.get("batch_key")
                if key:
                    orphans[key] = batch.id
        if not getattr(page, "has_more", False):
            break
        after_id = page_data[-1].id
    return orphans


@dataclass
class SubmitResult:
    anthropic_batch_id: str
    stage: AiStage
    batch_key: str
    row_ids: list[str]
    adopted: bool  # True = orphan adopted, False = fresh Anthropic POST


def submit_batch(
    *,
    stage: AiStage,
    row_ids: list[str],
    requests_payload: list[dict],
    run_id: str,
    orphans: dict[str, str],
    model: str,
    request_params_extra: Optional[dict] = None,
) -> SubmitResult:
    """Create one Anthropic batch for `stage` covering `row_ids`, atomically
    tagging every row with the resulting batch_id + active_batch_run_id.

    Idempotency: if `orphans[batch_key]` exists, skips `batches.create` and
    adopts the existing batch_id. The DB PATCH uses `{stage}_batch_id.is.null`
    as a guard so a mid-write crash cannot produce a second call.

    `requests_payload` is a list of Anthropic `Request` dicts (one per row),
    each with `custom_id` matching a row_id. Model + caching decisions are
    baked in by the caller.

    Emits `submitted` or `adopted_orphan` events (§2.9) per row.
    """
    if stage not in STAGES:
        raise ValueError(f"unknown stage: {stage}")
    if not row_ids:
        raise ValueError("submit_batch requires at least one row_id")
    if len(requests_payload) != len(row_ids):
        raise ValueError(
            f"requests_payload ({len(requests_payload)}) must match row_ids ({len(row_ids)})"
        )
    meta_cols = STAGES[stage]
    batch_id_col = meta_cols["batch_id_col"]
    batch_key = build_batch_key(row_ids)

    if batch_key in orphans:
        anth_batch_id = orphans[batch_key]
        adopted = True
        event_type = "adopted_orphan"
    else:
        client = _get_anthropic_client()
        anth_batch = client.messages.batches.create(
            requests=requests_payload,
            metadata={
                "rebuild_run_id": run_id,
                "stage":          stage,
                "batch_key":      batch_key,
            },
        )
        anth_batch_id = anth_batch.id
        adopted = False
        event_type = "submitted"

    now_iso = _now_iso()
    patch = {
        batch_id_col:           anth_batch_id,
        "active_batch_run_id":  run_id,
        "batch_submitted_at":   now_iso,
        "status":               f"batch_{stage}_submitted",
    }
    url = f"{SUPABASE_URL}/rest/v1/batch_queue"
    # Guard: only update rows whose {stage}_batch_id is still null. A row
    # that already has a batch_id is owned by another run or a prior write.
    params = {
        "id":            f"in.({','.join(row_ids)})",
        batch_id_col:    "is.null",
    }
    r = requests.patch(url, headers=HEADERS, params=params, json=patch, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(
            f"submit_batch DB PATCH failed ({r.status_code}): {r.text[:500]}"
        )

    for row_id in row_ids:
        log_event(
            batch_queue_id=row_id,
            rebuild_run_id=run_id,
            stage=stage,
            event_type=event_type,
            batch_id=anth_batch_id,
        )

    return SubmitResult(
        anthropic_batch_id=anth_batch_id,
        stage=stage,
        batch_key=batch_key,
        row_ids=row_ids,
        adopted=adopted,
    )


# ---------------------------------------------------------------------------
# Stage batch drain (§2.5, §2.6, §7.6)
# ---------------------------------------------------------------------------
#
# `wait_and_drain` is the paired read-side of `submit_batch`. It polls the
# Anthropic batch until `processing_status='ended'`, then walks the result
# stream once, writing one of four event types per row:
#
#   - drained_success   — parsed JSON result landed in meta.result_col
#   - drained_errored   — Anthropic returned result.type='errored'
#   - drained_truncated — succeeded but stop_reason='max_tokens' (§2.6)
#   - drained_canceled  — batch ended with type in ('canceled','expired')
#
# Truncation is detected independent of batch-level status: a 'succeeded'
# request with stop_reason='max_tokens' is STILL routed to needs_review
# because the tail of the JSON is unreliable.

# Defaults align with the three call sites deploy_agent used (32000).
# wait_and_drain writes this into extraction_result at truncation time so
# §2.10's --recover-review truncated path can see what limit was in force.
DEFAULT_MAX_TOKENS: int = 32000


@dataclass
class DrainStats:
    success: int = 0
    errored: int = 0
    truncated: int = 0
    canceled: int = 0
    expired: int = 0


def _parse_anthropic_result_json(message) -> tuple[str, Optional[dict]]:
    """Extract the text from a successful Anthropic Messages response +
    best-effort JSON parse. Returns (raw_text, parsed_or_None)."""
    chunks = []
    for block in (message.content or []):
        if getattr(block, "type", None) == "text":
            chunks.append(getattr(block, "text", ""))
    raw = "".join(chunks)
    try:
        return raw, json.loads(raw)
    except Exception:
        return raw, None


def wait_and_drain(
    *,
    stage: AiStage,
    anthropic_batch_id: str,
    row_ids: list[str],
    run_id: str,
    poll_interval_s: int = 15,
    max_wait_s: int = 24 * 60 * 60,
    max_tokens_at_submit: int = DEFAULT_MAX_TOKENS,
) -> DrainStats:
    """Poll until Anthropic batch is `ended`, then drain every row result.

    See §2.5 drain-time writes + §2.6 truncation detection + §7.6 ACTIVE
    disposition table. Emits one event per row via `log_event`.
    """
    if stage not in STAGES:
        raise ValueError(f"unknown stage: {stage}")
    meta_cols = STAGES[stage]
    batch_id_col = meta_cols["batch_id_col"]
    result_col = meta_cols["result_col"]
    client = _get_anthropic_client()
    row_id_set = set(row_ids)
    stats = DrainStats()

    # --- poll until ended -------------------------------------------------
    start = time.time()
    while True:
        batch = client.messages.batches.retrieve(anthropic_batch_id)
        status = batch.processing_status
        if status == "ended":
            break
        if status == "canceling":
            time.sleep(poll_interval_s)
            continue
        if time.time() - start > max_wait_s:
            raise TimeoutError(
                f"batch {anthropic_batch_id} still {status} after {max_wait_s}s"
            )
        time.sleep(poll_interval_s)

    # --- walk results ------------------------------------------------------
    # client.messages.batches.results() returns an iterator of MessageBatchIndividualResponse
    next_stage_pool = f"pool_{stage}_done"  # caller's _transition decides actual next pool
    for item in client.messages.batches.results(anthropic_batch_id):
        custom_id = item.custom_id
        if custom_id not in row_id_set:
            # Unknown custom_id — skip, don't write to a row we don't own
            continue
        result = item.result
        rtype = getattr(result, "type", None)

        if rtype == "succeeded":
            message = getattr(result, "message", None)
            usage = getattr(message, "usage", None)
            raw_text, parsed = _parse_anthropic_result_json(message)
            stop_reason = getattr(message, "stop_reason", None)

            if stop_reason == "max_tokens":
                # Truncated: do NOT parse + persist the incomplete JSON
                stats.truncated += 1
                truncated_payload = {
                    "raw_truncated_response": raw_text,
                    "truncated_stage":        stage,
                    "truncated_max_tokens":   max_tokens_at_submit,
                }
                patch = {
                    "active_batch_run_id": None,
                    "status":              "needs_review",
                    "review_reason":       "truncated",
                }
                # Merge into existing extraction_result; avoid overwriting
                # good upstream data (e.g., discover's menu_url). Read
                # current value, merge, PATCH.
                patch[_extraction_key_for_truncation(stage)] = truncated_payload
                _patch_row(custom_id, patch, existing_key=_extraction_key_for_truncation(stage),
                           merge=True)
                log_event(
                    batch_queue_id=custom_id, rebuild_run_id=run_id,
                    stage=stage, event_type="drained_truncated",
                    batch_id=anthropic_batch_id,
                    output_tokens=getattr(usage, "output_tokens", None),
                    input_tokens=getattr(usage, "input_tokens", None),
                    cache_creation_tokens=getattr(usage, "cache_creation_input_tokens", None),
                    cache_read_tokens=getattr(usage, "cache_read_input_tokens", None),
                    review_reason="truncated",
                )
                continue

            # Success path
            stats.success += 1
            patch = {
                "active_batch_run_id": None,
                "status":              next_stage_pool,
            }
            if result_col is not None:
                patch[result_col] = parsed if parsed is not None else {"raw": raw_text}
            _patch_row(custom_id, patch)
            log_event(
                batch_queue_id=custom_id, rebuild_run_id=run_id,
                stage=stage, event_type="drained_success",
                batch_id=anthropic_batch_id,
                input_tokens=getattr(usage, "input_tokens", None),
                output_tokens=getattr(usage, "output_tokens", None),
                cache_creation_tokens=getattr(usage, "cache_creation_input_tokens", None),
                cache_read_tokens=getattr(usage, "cache_read_input_tokens", None),
            )
            continue

        if rtype == "errored":
            stats.errored += 1
            err = getattr(result, "error", None)
            err_text = json.dumps({
                "type":    getattr(err, "type", None),
                "message": getattr(err, "message", None),
            }) if err else "errored"
            patch = {
                "active_batch_run_id": None,
                "status":              "needs_review",
                "review_reason":       "errored",
            }
            _patch_row(custom_id, patch)
            log_event(
                batch_queue_id=custom_id, rebuild_run_id=run_id,
                stage=stage, event_type="drained_errored",
                batch_id=anthropic_batch_id,
                error_text=err_text, review_reason="errored",
            )
            continue

        if rtype in ("canceled", "expired"):
            if rtype == "canceled":
                stats.canceled += 1
            else:
                stats.expired += 1
            patch = {
                "active_batch_run_id": None,
                "status":              "needs_review",
                "review_reason":       rtype,
            }
            _patch_row(custom_id, patch)
            log_event(
                batch_queue_id=custom_id, rebuild_run_id=run_id,
                stage=stage, event_type="drained_canceled",
                batch_id=anthropic_batch_id,
                review_reason=rtype,
            )
            continue

        # Unknown result type — treat as errored for safety
        stats.errored += 1
        patch = {
            "active_batch_run_id": None,
            "status":              "needs_review",
            "review_reason":       "errored",
        }
        _patch_row(custom_id, patch)
        log_event(
            batch_queue_id=custom_id, rebuild_run_id=run_id,
            stage=stage, event_type="drained_errored",
            batch_id=anthropic_batch_id,
            error_text=f"unknown result.type: {rtype!r}",
            review_reason="errored",
        )

    return stats


def _extraction_key_for_truncation(stage: AiStage) -> str:
    """Which column holds the extraction_result payload this stage writes to.
    Always `extraction_result` today for non-None result_cols (branding,
    modifier, pdf, image_menu, extract). discover has no result_col so
    truncation there is effectively unreachable, but we still need a column
    to stash the raw; fall back to extraction_result.

    Kept as a helper in case a future stage diverges from extraction_result
    — changing it here is easier than grepping the truncation branch.
    """
    return STAGES[stage]["result_col"] or "extraction_result"


def _patch_row(
    row_id: str,
    patch: dict,
    *,
    existing_key: Optional[str] = None,
    merge: bool = False,
) -> None:
    """PATCH a single batch_queue row. If `merge=True` and `existing_key`
    is given, the row's current `existing_key` JSONB is read, dict-merged
    with `patch[existing_key]`, and written back. No-merge writes just
    overwrite.
    """
    url = f"{SUPABASE_URL}/rest/v1/batch_queue"
    if merge and existing_key and existing_key in patch:
        g = requests.get(
            url,
            headers={**HEADERS, "Accept": "application/json"},
            params={"id": f"eq.{row_id}", "select": existing_key},
            timeout=15,
        )
        g.raise_for_status()
        existing = (g.json() or [{}])[0].get(existing_key) or {}
        if not isinstance(existing, dict):
            existing = {}
        merged = {**existing, **patch[existing_key]}
        patch = {**patch, existing_key: merged}
    r = requests.patch(
        url, headers=HEADERS, params={"id": f"eq.{row_id}"},
        json=patch, timeout=15,
    )
    r.raise_for_status()


# ---------------------------------------------------------------------------
# Stage transitions (§7.18 image-menu reroute + drain-time routing)
# ---------------------------------------------------------------------------
#
# `wait_and_drain` parks each row at `pool_{stage}_done` after a successful
# drain. `_transition_between_stages` is the follow-up step that reads each
# of those rows, inspects the freshly written result column, and routes to
# the correct next pool:
#
#   discover  → pool_{extract|pdf|image_menu} based on discovered menu_url
#   extract   → pool_modifier (items ≥ 3)
#             | pool_image_menu (items < 3 AND preflight.image_menu_urls
#                               AND not already rerouted — §7.18)
#             | needs_review 'deadletter_post_drain' (items < 3, no reroute path)
#   pdf       → pool_modifier (items ≥ 1) | needs_review
#   image_menu→ pool_modifier (items ≥ 1) | needs_review 'deadletter_post_drain'
#   modifier  → stays pool_modifier_done (group C join decides ready_to_assemble)
#   branding  → stays pool_branding_done (same)
#
# The reroute path writes `rerouted_from: 'extract'` into extraction_result
# so a second-pass image_menu failure can correctly distinguish "never got
# to image_menu" from "already tried image_menu and still failed".

_PDF_URL_RX = re.compile(r"\.pdf(?:\?|$)", re.IGNORECASE)


def _count_items(extraction_result: dict | None) -> int:
    """How many menu items the extraction result exposes. Handles both the
    `items: [...]` shape used by pdf/image_menu/ld+json and older result
    envelopes (`menu: {items: [...]}`). Missing/malformed → 0."""
    if not isinstance(extraction_result, dict):
        return 0
    items = extraction_result.get("items")
    if isinstance(items, list):
        return len(items)
    menu = extraction_result.get("menu")
    if isinstance(menu, dict):
        items = menu.get("items")
        if isinstance(items, list):
            return len(items)
    return 0


def _fetch_transition_rows(row_ids: list[str]) -> list[dict]:
    """Pull just the columns transition needs for the given IDs. Paginated
    with `id.in.(...)` — PostgREST caps IN-list length by URL size but the
    batches we call this with are <=10K, well within limits."""
    if not row_ids:
        return []
    url = f"{SUPABASE_URL}/rest/v1/batch_queue"
    select = (
        "id,status,preflight,extraction_result,modifier_result,"
        "branding_result,restaurant_type,menu_url"
    )
    # Chunk at 500 to keep the query-string sane.
    out: list[dict] = []
    for i in range(0, len(row_ids), 500):
        chunk = row_ids[i:i + 500]
        r = requests.get(
            url,
            headers={**HEADERS, "Accept": "application/json"},
            params={
                "id": f"in.({','.join(chunk)})",
                "select": select,
            },
            timeout=30,
        )
        r.raise_for_status()
        out.extend(r.json() or [])
    return out


def _transition_between_stages(
    stage: AiStage,
    row_ids: list[str],
    run_id: str,
) -> dict[str, int]:
    """After `wait_and_drain` parked rows at pool_{stage}_done, route each
    row to the correct next pool per §7.6 + §7.18. Returns per-next-pool
    counts for reporting.
    """
    counts: dict[str, int] = {}
    if not row_ids:
        return counts
    rows = _fetch_transition_rows(row_ids)
    by_id = {r["id"]: r for r in rows}

    for rid in row_ids:
        row = by_id.get(rid)
        if row is None:
            continue
        status = row.get("status")
        # Only rows that actually drained successfully are eligible for
        # transition. needs_review rows (truncated/errored/canceled/expired)
        # are owned by --recover-review, not us.
        if status != f"pool_{stage}_done":
            continue

        extraction = row.get("extraction_result") or {}
        preflight = row.get("preflight") or {}
        image_menu_urls = preflight.get("image_menu_urls") or []
        already_rerouted = (
            isinstance(extraction, dict)
            and extraction.get("rerouted_from") == "extract"
        )

        next_pool: str
        event_type: str = "transitioned"
        review_reason: Optional[str] = None
        extra_patch: dict = {}

        if stage == "discover":
            # discover writes the winning URL into extraction_result.menu_url
            # (shape inherited from deploy_agent's build_discover_msg). Route
            # by URL class: pdf→pool_pdf, else pool_extract.
            discovered = None
            if isinstance(extraction, dict):
                discovered = (
                    extraction.get("menu_url")
                    or extraction.get("menuUrl")
                    or extraction.get("selected_url")
                )
            if isinstance(discovered, str) and _PDF_URL_RX.search(discovered):
                next_pool = "pool_pdf"
            elif isinstance(discovered, str) and discovered.strip():
                next_pool = "pool_extract"
            else:
                next_pool = "needs_review"
                review_reason = "discover_no_url"

        elif stage == "extract":
            item_count = _count_items(extraction)
            if item_count >= 3:
                next_pool = "pool_modifier"
            elif image_menu_urls and not already_rerouted:
                next_pool = "pool_image_menu"
                event_type = "rerouted"
                # Tag so a subsequent image_menu drain with <1 items knows
                # it was already on the reroute path and must go to
                # deadletter_post_drain (not loop back).
                merged = dict(extraction) if isinstance(extraction, dict) else {}
                merged["rerouted_from"] = "extract"
                extra_patch["extraction_result"] = merged
            else:
                next_pool = "needs_review"
                review_reason = "deadletter_post_drain"

        elif stage in ("pdf", "image_menu"):
            item_count = _count_items(extraction)
            if item_count >= 1:
                next_pool = "pool_modifier"
            else:
                next_pool = "needs_review"
                # image_menu that was a reroute target and still failed is
                # the classic dead-letter case. pdf failures on first pass
                # are just errored (no reroute path exists for pdf).
                if stage == "image_menu" and already_rerouted:
                    review_reason = "deadletter_post_drain"
                else:
                    review_reason = "deadletter_post_drain"

        elif stage in ("modifier", "branding"):
            # Group C does not advance here — the per-row join to
            # `ready_to_assemble` happens in `_sync_group_c_join` once
            # BOTH modifier_result AND branding_result are present.
            next_pool = f"pool_{stage}_done"
            if row.get("status") == next_pool:
                counts[next_pool] = counts.get(next_pool, 0) + 1
                continue

        else:
            raise ValueError(f"unexpected stage in transition: {stage}")

        patch = {"status": next_pool, "active_batch_run_id": None}
        if review_reason:
            patch["review_reason"] = review_reason
        patch.update(extra_patch)
        _patch_row(rid, patch)

        log_event(
            batch_queue_id=rid,
            rebuild_run_id=run_id,
            stage=stage,
            event_type=event_type,
            review_reason=review_reason,
            error_text=(f"stage {stage} → {next_pool}" if event_type == "rerouted" else None),
        )
        counts[next_pool] = counts.get(next_pool, 0) + 1

    return counts


def _sync_group_c_join(row_ids: list[str], run_id: str) -> int:
    """After group C (modifier + branding) fully drains, promote rows that
    have BOTH result columns populated to `ready_to_assemble`. Rows still
    missing one side stay at `pool_{stage}_done` (the other stage may have
    landed them in `needs_review` — operator recovery). Returns count
    promoted.
    """
    if not row_ids:
        return 0
    rows = _fetch_transition_rows(row_ids)
    promoted = 0
    for r in rows:
        if r.get("modifier_result") and r.get("branding_result"):
            status = r.get("status")
            if status in ("pool_modifier_done", "pool_branding_done",
                          "ready_to_assemble"):
                if status != "ready_to_assemble":
                    _patch_row(r["id"], {"status": "ready_to_assemble"})
                    log_event(
                        batch_queue_id=r["id"],
                        rebuild_run_id=run_id,
                        stage="branding",  # marker; join crosses stages
                        event_type="transitioned",
                        error_text="modifier+branding → ready_to_assemble",
                    )
                    promoted += 1
    return promoted


# ---------------------------------------------------------------------------
# run_stage_group — per-stage bucket partition + submit/drain + transition
# ---------------------------------------------------------------------------
#
# One call per dependency-graph group (A: discover; B: extract+pdf+image_menu;
# C: modifier+branding). Within the group, stages are run in parallel threads
# (one per stage). Each stage thread:
#
#   1. Partition the stage's candidate rows per §7.6 (GONE / DRAINED / FRESH
#      / ACTIVE).
#   2. For FRESH: §2.5a orphan reconciliation first; then `submit_batch`
#      (which internally adopts any orphan match for the same batch_key).
#   3. For ACTIVE: `wait_and_drain` the already-submitted batch(es).
#   4. After drain: `_transition_between_stages` routes rows to next pool.
#
# Group-level join (C only) happens after all stage threads join.

@dataclass
class StageGroupResult:
    stage: AiStage
    submitted: int = 0
    adopted: int = 0
    drained: int = 0
    skipped_fresh: int = 0  # rows that preflight marked ai_needed but had no raw payload
    errors: list[str] = field(default_factory=list)
    anthropic_batch_ids: list[str] = field(default_factory=list)
    transition_counts: dict[str, int] = field(default_factory=dict)


def _ai_needed_has(row: dict, stage: AiStage) -> bool:
    pf = row.get("preflight") or {}
    needed = pf.get("ai_needed") or []
    return stage in needed if isinstance(needed, list) else False


def _bucket_rows_for_stage(
    rows: list[dict],
    stage: AiStage,
    run_id: str,
) -> tuple[list[dict], dict[str, list[dict]]]:
    """Partition rows into (fresh, active_by_batch_id) for a given stage.
    DRAINED and GONE rows are dropped. ACTIVE rows are bucketed by their
    `{stage}_batch_id` so one wait_and_drain call covers each batch.
    """
    meta = STAGES[stage]
    batch_id_col = meta["batch_id_col"]
    result_col = meta["result_col"]
    fresh: list[dict] = []
    active: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("rebuild_run_id") != run_id:
            continue  # GONE
        if result_col and r.get(result_col) is not None:
            continue  # DRAINED
        if not _ai_needed_has(r, stage):
            continue  # preflight said this stage not needed
        bid = r.get(batch_id_col)
        arr = r.get("active_batch_run_id")
        if bid and arr == run_id:
            active.setdefault(bid, []).append(r)
        elif not bid:
            fresh.append(r)
        else:
            # bid set but not our run — §2.0b stuck_orphan path (already
            # routed to needs_review by reset/cleanup). Skip.
            continue
    return fresh, active


# NOTE: `run_stage_group` stitches bucket partition + submit + drain +
# transition together but delegates the actual Anthropic request-payload
# construction to caller-provided `build_requests_fn`. That function lives
# in the stage dispatcher (e.g., `build_extract_requests`) and reads
# per-row context out of the DB row — keeping run_stage_group stage-agnostic.

def run_stage_group(
    *,
    group_name: str,
    stages: list[AiStage],
    rows: list[dict],
    run_id: str,
    build_requests_fn,   # Callable[[AiStage, list[dict]], tuple[list[dict], dict]]
    model_for_stage,     # Callable[[AiStage], str]
    request_params_extra_for_stage=None,  # Callable[[AiStage], dict] | None
    poll_interval_s: int = 15,
) -> list[StageGroupResult]:
    """Submit + drain + transition every stage in the group.

    `build_requests_fn(stage, fresh_rows) -> (requests_payload, extra_meta)`
    returns the list of Anthropic request dicts (with matching row IDs as
    custom_ids) and a dict (currently unused, reserved for per-stage
    provenance the caller might want echoed back). If it returns an empty
    requests list despite fresh_rows being non-empty, those rows are
    counted in `skipped_fresh`.
    """
    print(f"\n── Group {group_name}: stages={stages}, rows={len(rows)} ──")
    results: list[StageGroupResult] = []

    def _run_one_stage(stage: AiStage) -> StageGroupResult:
        sgr = StageGroupResult(stage=stage)
        fresh, active = _bucket_rows_for_stage(rows, stage, run_id)
        print(f"  [{stage}] FRESH={len(fresh)}  ACTIVE_batches={len(active)}")

        # --- ACTIVE: drain existing batches --------------------------------
        for bid, act_rows in active.items():
            sgr.anthropic_batch_ids.append(bid)
            row_ids = [r["id"] for r in act_rows]
            try:
                stats = wait_and_drain(
                    stage=stage,
                    anthropic_batch_id=bid,
                    row_ids=row_ids,
                    run_id=run_id,
                    poll_interval_s=poll_interval_s,
                )
                sgr.drained += stats.success + stats.errored + stats.truncated + stats.canceled + stats.expired
                print(f"  [{stage}] drained ACTIVE {bid}: "
                      f"ok={stats.success} err={stats.errored} "
                      f"trunc={stats.truncated} cancel={stats.canceled} "
                      f"exp={stats.expired}")
                sgr.transition_counts.update(
                    _transition_between_stages(stage, row_ids, run_id)
                )
            except Exception as e:
                msg = f"drain {stage}/{bid}: {type(e).__name__}: {e}"
                sgr.errors.append(msg)
                print(f"  [{stage}] ERROR {msg}")

        # --- FRESH: orphan reconcile + submit ------------------------------
        if fresh:
            run_start_ts = int(time.time()) - 24 * 60 * 60  # conservative window
            try:
                orphans = reconcile_orphan_batches(stage, run_id, run_start_ts)
            except Exception as e:
                print(f"  [{stage}] orphan reconcile failed ({e}); proceeding without")
                orphans = {}
            try:
                requests_payload, _extra = build_requests_fn(stage, fresh)
            except Exception as e:
                sgr.errors.append(f"build_requests {stage}: {type(e).__name__}: {e}")
                print(f"  [{stage}] ERROR build_requests: {e}")
                return sgr
            if not requests_payload:
                sgr.skipped_fresh += len(fresh)
                print(f"  [{stage}] skipped_fresh={len(fresh)} (no requests produced)")
                return sgr
            submitted_row_ids = [r["custom_id"] for r in requests_payload]
            try:
                sr = submit_batch(
                    stage=stage,
                    row_ids=submitted_row_ids,
                    requests_payload=requests_payload,
                    run_id=run_id,
                    orphans=orphans,
                    model=model_for_stage(stage),
                    request_params_extra=(
                        request_params_extra_for_stage(stage)
                        if request_params_extra_for_stage else None
                    ),
                )
                if sr.adopted:
                    sgr.adopted += len(submitted_row_ids)
                    print(f"  [{stage}] adopted orphan {sr.anthropic_batch_id} "
                          f"({len(submitted_row_ids)} rows)")
                else:
                    sgr.submitted += len(submitted_row_ids)
                    print(f"  [{stage}] submitted {sr.anthropic_batch_id} "
                          f"({len(submitted_row_ids)} rows)")
                sgr.anthropic_batch_ids.append(sr.anthropic_batch_id)
                # Drain it now so the group finishes in one call (§7.6 drain-only).
                stats = wait_and_drain(
                    stage=stage,
                    anthropic_batch_id=sr.anthropic_batch_id,
                    row_ids=submitted_row_ids,
                    run_id=run_id,
                    poll_interval_s=poll_interval_s,
                )
                sgr.drained += (stats.success + stats.errored + stats.truncated
                                + stats.canceled + stats.expired)
                print(f"  [{stage}] drained FRESH: ok={stats.success} "
                      f"err={stats.errored} trunc={stats.truncated}")
                sgr.transition_counts.update(
                    _transition_between_stages(stage, submitted_row_ids, run_id)
                )
            except Exception as e:
                sgr.errors.append(f"submit/drain {stage}: {type(e).__name__}: {e}")
                print(f"  [{stage}] ERROR submit/drain: {e}")

        return sgr

    # Parallel within group (thread per stage)
    with ThreadPoolExecutor(max_workers=max(len(stages), 1)) as pool:
        futures = {pool.submit(_run_one_stage, s): s for s in stages}
        for fut in as_completed(futures):
            stage = futures[fut]
            try:
                results.append(fut.result())
            except Exception as e:
                print(f"  [{stage}] STAGE CRASHED: {e}")
                results.append(StageGroupResult(stage=stage, errors=[str(e)]))

    # Group C join — after both modifier+branding transitioned, promote
    # rows that have BOTH result columns to ready_to_assemble.
    if set(stages) >= {"modifier", "branding"}:
        all_row_ids = [r["id"] for r in rows]
        promoted = _sync_group_c_join(all_row_ids, run_id)
        print(f"  [group C] promoted {promoted} rows → ready_to_assemble")

    return results


# ---------------------------------------------------------------------------
# run_assemble — parallel POST /api/batch/ingest (§2.4a + §7.17)
# ---------------------------------------------------------------------------
#
# Assemble is a synchronous Vercel route, not an Anthropic batch. The §7.6
# matrix doesn't apply; §2.4a's PENDING bucket does. `run_assemble` walks
# every `ready_to_assemble` row under our run_id, POSTs to the ingest route
# with bounded parallelism (ASSEMBLE_WORKERS, default 4), and handles:
#
#   - 200 ok        → batch_queue row moves to status='done' (route owns it)
#   - 409 conflict  → deploy already in flight; mark needs_review
#                     review_reason='deploy_in_flight_collision' (§2.4)
#   - 429 throttle  → retry-with-jitter; give up after MAX_429_RETRIES
#   - other 5xx/4xx → needs_review review_reason='assemble_validation'
#
# `ready_to_assemble` entry is the ONLY rebuild-owned path — the status is
# only set by `_sync_group_c_join` after group C fully drains, or by legacy
# single-row flows that land rows there directly (hot-path).

ASSEMBLE_WORKERS: int = int(os.environ.get("ASSEMBLE_WORKERS", "4"))
ASSEMBLE_TIMEOUT_S: int = int(os.environ.get("ASSEMBLE_TIMEOUT_S", "310"))
MAX_429_RETRIES: int = 5
DEMO_BUILDER_API_URL: str = os.environ.get(
    "DEMO_BUILDER_API_URL", "http://localhost:3002"
)


@dataclass
class AssembleStats:
    ok: int = 0
    conflict_409: int = 0
    throttled_gave_up: int = 0
    other_error: int = 0


def _post_ingest_once(
    session: "requests.Session",
    queue_id: str,
    run_id: str,
) -> tuple[str, Optional[dict], int]:
    """Single POST attempt. Returns (outcome, response_json, status_code).
    Outcome is one of: 'ok', 'conflict_409', 'throttled', 'other_error', 'network_error'.
    """
    try:
        resp = session.post(
            f"{DEMO_BUILDER_API_URL}/api/batch/ingest",
            json={"queue_id": queue_id, "rebuild_run_id": run_id},
            timeout=ASSEMBLE_TIMEOUT_S,
        )
    except requests.RequestException as e:
        return ("network_error", {"error": str(e)[:400]}, 0)
    try:
        body = resp.json()
    except Exception:
        body = {"error": f"non-json response: {resp.text[:400]}"}
    if resp.status_code == 200:
        return ("ok", body, 200)
    if resp.status_code == 409:
        return ("conflict_409", body, 409)
    if resp.status_code == 429:
        return ("throttled", body, 429)
    return ("other_error", body, resp.status_code)


def _post_ingest(
    row: dict,
    run_id: str,
    session: "requests.Session",
) -> str:
    """Per-row ingest with 429 retry-with-jitter. Returns the outcome
    string ('ok', 'conflict_409', 'throttled_gave_up', 'other_error')."""
    import random  # local — only used by the jitter path
    queue_id = row["id"]
    last_body: Optional[dict] = None
    last_status: int = 0
    for attempt in range(MAX_429_RETRIES + 1):
        outcome, body, status = _post_ingest_once(session, queue_id, run_id)
        last_body, last_status = body, status
        if outcome == "ok":
            log_event(
                batch_queue_id=queue_id, rebuild_run_id=run_id,
                stage="branding",  # assemble isn't an AI stage; use branding as boundary marker
                event_type="transitioned",
                http_status=200,
                error_text=f"ingest ok → session {(body or {}).get('session_id', '?')[:8]}",
            )
            return "ok"
        if outcome == "conflict_409":
            _patch_row(queue_id, {
                "status":        "needs_review",
                "review_reason": "deploy_in_flight_collision",
            })
            log_event(
                batch_queue_id=queue_id, rebuild_run_id=run_id,
                stage="branding", event_type="drained_errored",
                http_status=409,
                review_reason="deploy_in_flight_collision",
                error_text=(json.dumps(body)[:800] if body else None),
            )
            return "conflict_409"
        if outcome == "throttled":
            if attempt < MAX_429_RETRIES:
                # Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s plus 0–1s
                sleep_s = (2 ** attempt) + random.random()
                time.sleep(sleep_s)
                continue
            # fall through to "other_error" path
        # other_error OR throttled-exhausted OR network_error
        _patch_row(queue_id, {
            "status":        "needs_review",
            "review_reason": "assemble_validation",
        })
        log_event(
            batch_queue_id=queue_id, rebuild_run_id=run_id,
            stage="branding", event_type="drained_errored",
            http_status=(status or None),
            review_reason="assemble_validation",
            error_text=(json.dumps(body)[:800] if body else None),
        )
        return "throttled_gave_up" if outcome == "throttled" else "other_error"
    return "other_error"


def run_assemble(run_id: str, workers: int = ASSEMBLE_WORKERS) -> AssembleStats:
    """POST /api/batch/ingest for every `ready_to_assemble` row under this
    rebuild_run_id. See §2.4a + §7.17. Returns AssembleStats.
    """
    stats = AssembleStats()
    url = f"{SUPABASE_URL}/rest/v1/batch_queue"
    params = {
        "select": "id,pt_record_id,name",
        "status": "eq.ready_to_assemble",
        "rebuild_run_id": f"eq.{run_id}",
        "order": "created_at.asc",
    }
    r = requests.get(
        url, headers={**HEADERS, "Accept": "application/json"},
        params=params, timeout=60,
    )
    r.raise_for_status()
    rows = r.json() or []
    if not rows:
        print(f"\n[ASSEMBLE] no ready_to_assemble rows for run={run_id[:8]}")
        return stats
    print(f"\n[ASSEMBLE] {len(rows)} rows, workers={workers}, target={DEMO_BUILDER_API_URL}")

    session = requests.Session()  # reused across workers for conn pooling

    def _worker(row: dict) -> str:
        return _post_ingest(row, run_id, session)

    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_worker, row): row for row in rows}
        for fut in as_completed(futs):
            outcome = fut.result()
            if outcome == "ok":
                stats.ok += 1
            elif outcome == "conflict_409":
                stats.conflict_409 += 1
            elif outcome == "throttled_gave_up":
                stats.throttled_gave_up += 1
            else:
                stats.other_error += 1
            done += 1
            if done % 25 == 0 or done == len(rows):
                elapsed = time.time() - t0
                rate = done / elapsed if elapsed else 0
                print(f"  [ASSEMBLE] {done}/{len(rows)}  {rate:.1f}/s  "
                      f"ok={stats.ok} 409={stats.conflict_409} "
                      f"429_give_up={stats.throttled_gave_up} "
                      f"other_err={stats.other_error}")
    return stats


# ---------------------------------------------------------------------------
# Advisory lock — pg_try_advisory_lock on session pool (§7.12)
# ---------------------------------------------------------------------------
#
# Must run on Supabase's session pool (port 5432), NOT the transaction pool
# (6543). PgBouncer transaction mode silently releases session-scoped
# advisory locks at end-of-statement, so the lock would no-op without error.
#
# The lock connection is held open for the entire rebuild process. Closing
# it releases the lock — including via atexit, SIGTERM, SIGINT, or process
# death. No block/wait: if the lock is held we fail fast.

import atexit
import signal

REBUILD_LOCK_KEY = int(hashlib.sha256(b"rebuild_batch").hexdigest()[:8], 16)

_lock_conn = None  # live psycopg2 connection holding the advisory lock


def acquire_rebuild_lock() -> None:
    """Acquire pg_try_advisory_lock on a session-pool Supabase connection.
    Fails fast if another rebuild_batch is running. Registers atexit +
    signal handlers to release on exit.
    """
    global _lock_conn
    direct_url = os.environ.get("SUPABASE_DIRECT_URL")
    if not direct_url:
        raise SystemExit(
            "ERROR: SUPABASE_DIRECT_URL (port 5432 session pool) required "
            "for advisory lock per §7.12. Transaction-pooled URLs (port "
            "6543) silently no-op session-scoped locks."
        )
    try:
        import psycopg2
    except ImportError:
        raise SystemExit(
            "ERROR: psycopg2 not installed. Run: pip install psycopg2-binary"
        )

    conn = psycopg2.connect(direct_url)
    conn.autocommit = True
    cur = conn.cursor()

    # Sanity check the connection is session-mode — if we're on the 6543
    # pool, pg_advisory_lock_held would return false after acquisition.
    cur.execute("SHOW port")
    row = cur.fetchone()
    port = int(row[0]) if row else -1
    if port == 6543:
        cur.close()
        conn.close()
        raise SystemExit(
            f"ERROR: SUPABASE_DIRECT_URL points at port {port} "
            f"(transaction-pooled). Session-level advisory locks silently "
            f"no-op there. Use port 5432."
        )

    cur.execute("SELECT pg_try_advisory_lock(%s)", (REBUILD_LOCK_KEY,))
    got = cur.fetchone()[0]
    if not got:
        # Probe for the holder to help the operator decide next steps.
        cur.execute("""
            SELECT pid, state, now() - query_start AS idle_for, query
              FROM pg_stat_activity
             WHERE state IS NOT NULL
               AND backend_type = 'client backend'
               AND pid <> pg_backend_pid()
             ORDER BY query_start ASC
             LIMIT 5
        """)
        holders = cur.fetchall()
        cur.close()
        conn.close()
        msg = ["ERROR: another rebuild_batch process holds the advisory lock."]
        if holders:
            msg.append("  Top 5 active sessions on this DB:")
            for pid, state, idle_for, query in holders:
                msg.append(f"    pid={pid} state={state} idle={idle_for} "
                           f"query={(query or '')[:80]!r}")
            msg.append("  If the holder is truly dead, operator can run in "
                       "Supabase SQL editor: SELECT pg_terminate_backend(<pid>);")
        raise SystemExit("\n".join(msg))

    # Verify lock is really held (fails fast on transaction-pooler surprises).
    cur.execute("""
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory' AND objid = %s
             AND pid = pg_backend_pid() AND granted
        )
    """, (REBUILD_LOCK_KEY,))
    held = cur.fetchone()[0]
    if not held:
        cur.close()
        conn.close()
        raise SystemExit(
            "ERROR: advisory lock acquisition returned true but "
            "pg_locks disagrees. Likely transaction-pooled connection. "
            "Set SUPABASE_DIRECT_URL to the port-5432 session URL."
        )

    _lock_conn = conn
    print(f"[LOCK] acquired rebuild_batch advisory lock (key={REBUILD_LOCK_KEY})")

    atexit.register(release_rebuild_lock)
    signal.signal(signal.SIGTERM, _signal_release)
    signal.signal(signal.SIGINT, _signal_release)


def release_rebuild_lock() -> None:
    global _lock_conn
    conn = _lock_conn
    _lock_conn = None
    if conn is None:
        return
    try:
        cur = conn.cursor()
        cur.execute("SELECT pg_advisory_unlock(%s)", (REBUILD_LOCK_KEY,))
        cur.close()
    except Exception as e:
        print(f"[LOCK] release WARN: {e}")
    try:
        conn.close()
    except Exception:
        pass
    print("[LOCK] released rebuild_batch advisory lock")


def _signal_release(signum, frame):
    try:
        release_rebuild_lock()
    finally:
        raise SystemExit(128 + signum)


# ---------------------------------------------------------------------------
# select_cache_mode — pre-submit cache decision (§2.8)
# ---------------------------------------------------------------------------
#
# 2026-04-16 regression: batch+cache cost MORE than sync at small N or when
# TTL expired mid-batch (`feedback_batch_caching_cost_regression.md`).
# select_cache_mode runs pre-submit; the CLI flag --cache-mode
# {auto,off,force-5min,force-1h} overrides.
#
# Starting drain-minute estimates come from 2026-04-15/16 runs
# (feedback_anthropic_batch_sla.md: ~6 min for 2229 reqs, 40+ min for
# 1-2 req tiny batches). The in-process moving average updates after each
# stage drains.

CacheMode = Literal["off", "5min", "1h"]
CacheModeCli = Literal["auto", "off", "force-5min", "force-1h"]

# Initial drain-time estimates per stage, minutes. Updated in-place during
# a run as actual timings come in (empirical moving average).
ESTIMATED_DRAIN_MINUTES: dict[str, float] = {
    "discover":   6.0,
    "extract":    6.0,
    "modifier":   6.0,
    "branding":   6.0,
    "pdf":        10.0,
    "image_menu": 10.0,
}

# Cache-read-vs-write ratio that triggers runtime override. If over a stage
# the creation tokens dominate, subsequent stages in the run go cache-off.
_cache_disabled_stages: set[AiStage] = set()


def update_drain_estimate(stage: AiStage, actual_minutes: float) -> None:
    """Exponential moving average with alpha=0.5 — fast reaction to new data."""
    prior = ESTIMATED_DRAIN_MINUTES.get(stage, 6.0)
    ESTIMATED_DRAIN_MINUTES[stage] = 0.5 * prior + 0.5 * actual_minutes


def note_cache_amortization(
    stage: AiStage,
    cache_creation_tok: int,
    cache_read_tok: int,
) -> None:
    """Called post-drain per stage. If cache_creation > cache_read, mark
    this stage cache-disabled for the remainder of the run."""
    if cache_creation_tok > cache_read_tok and cache_creation_tok > 0:
        if stage not in _cache_disabled_stages:
            print(f"  [CACHE] stage={stage} create={cache_creation_tok} "
                  f"> read={cache_read_tok} — disabling cache for remainder of run")
            _cache_disabled_stages.add(stage)


def select_cache_mode(
    stage: AiStage,
    n_requests: int,
    t_sys: int,
    est_drain_minutes: Optional[float] = None,
    cli_override: CacheModeCli = "auto",
) -> CacheMode:
    """Pre-submit cache-mode decision per §2.8.

    - `t_sys` is the approximate token count of the system prompt block
      (sentinel cache_control anchor). Haiku's prompt-cache minimum is
      empirically 4096 tokens, not 2048 (project_prompt_caching_gap.md).
    - Below break-even N, attaching cache_control is a pure premium.
    - If a prior stage in the same run failed to amortize, this stage is
      forced to 'off' regardless of policy.
    """
    # CLI forces win over everything except the empirical-override.
    if cli_override == "off":
        return "off"
    if stage in _cache_disabled_stages:
        return "off"
    if cli_override == "force-5min":
        return "5min"
    if cli_override == "force-1h":
        return "1h"

    if t_sys < 4096:
        return "off"
    if n_requests <= 1:
        return "off"

    edm = est_drain_minutes if est_drain_minutes is not None \
        else ESTIMATED_DRAIN_MINUTES.get(stage, 6.0)

    if edm > 4 and n_requests < 50:
        # 5-min TTL likely expires mid-batch; 1h would be needed but is
        # only worth it at N>=3 and very long drains.
        if edm > 50:
            return "1h" if n_requests >= 3 else "off"
        return "off"
    if edm > 50:
        return "1h" if n_requests >= 3 else "off"
    return "5min"


# ---------------------------------------------------------------------------
# recover_review — --recover-review <reason> (§2.10)
# ---------------------------------------------------------------------------
#
# Operator-driven recovery of `status='needs_review'` rows. One reason at a
# time. `stuck_orphan`/`truncated`/`errored`/`canceled`/`expired` are
# self-serve. `assemble_validation`/`deadletter_post_drain` require --force.
# `deploy_in_flight_collision` re-queries sessions.deploy_status first and
# skips if the deploy is still live.

# Reasons that require --force.
MANUAL_ONLY_REASONS = {"assemble_validation", "deadletter_post_drain"}
ALL_REVIEW_REASONS = {
    "stuck_orphan", "truncated", "errored", "canceled", "expired",
    "deploy_in_flight_collision", "assemble_validation",
    "deadletter_post_drain", "discover_no_url",
}


def _select_needs_review_rows(
    reason: str,
    run_id: Optional[str],
) -> list[dict]:
    url = f"{SUPABASE_URL}/rest/v1/batch_queue"
    params = {
        "select": ("id,pt_record_id,status,review_reason,preflight,"
                   "extraction_result,modifier_result,branding_result,"
                   "discover_batch_id,extract_batch_id,modifier_batch_id,"
                   "branding_batch_id,pdf_batch_id,image_menu_batch_id,"
                   "active_batch_run_id,rebuild_run_id"),
        "status": "eq.needs_review",
        "review_reason": f"eq.{reason}",
        "order": "updated_at.asc",
    }
    if run_id:
        params["rebuild_run_id"] = f"eq.{run_id}"
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"},
                     params=params, timeout=60)
    r.raise_for_status()
    return r.json() or []


def _stage_batch_id_col_from_row(row: dict, stage: AiStage) -> Optional[str]:
    return row.get(STAGES[stage]["batch_id_col"])


def _session_deploy_status(pt_record_id: str) -> Optional[str]:
    """Look up the current deploy_status for a row's session. Returns None
    if no session row exists (e.g., deploy was never assembled)."""
    if not pt_record_id:
        return None
    url = f"{SUPABASE_URL}/rest/v1/sessions"
    r = requests.get(
        url, headers={**HEADERS, "Accept": "application/json"},
        params={"pt_record_id": f"eq.{pt_record_id}",
                "select": "deploy_status", "limit": "1"},
        timeout=15,
    )
    r.raise_for_status()
    rows = r.json() or []
    return rows[0].get("deploy_status") if rows else None


def _recover_stuck_orphan(row: dict, run_id_for_event: Optional[str]) -> tuple[dict, str]:
    """Clear any active batch_id + active_batch_run_id; back to 'queued'.
    Recovery applies to whichever stage's batch_id is currently set."""
    patch = {"status": "queued", "review_reason": None,
             "active_batch_run_id": None}
    # Null out whichever stage's batch_id is present (one at a time — rows
    # in stuck_orphan are per-stage).
    for stage in ("discover", "extract", "modifier", "branding", "pdf", "image_menu"):
        col = STAGES[stage]["batch_id_col"]
        if row.get(col):
            patch[col] = None
    return patch, "recovered_stuck_orphan"


def _recover_truncated(row: dict, run_id_for_event: Optional[str]) -> tuple[dict, str]:
    extraction = row.get("extraction_result") or {}
    if not isinstance(extraction, dict):
        raise ValueError(f"truncated row {row['id']} has non-dict extraction_result")
    trunc_stage = extraction.get("truncated_stage")
    if trunc_stage not in STAGES:
        raise ValueError(f"row {row['id']} extraction_result.truncated_stage missing/invalid: {trunc_stage!r}")
    archive_trunc = list(extraction.get("archive_truncated") or [])
    archive_tokens = list(extraction.get("archive_max_tokens") or [])
    raw = extraction.get("raw_truncated_response")
    if raw is not None:
        archive_trunc.append(raw)
    tok = extraction.get("truncated_max_tokens")
    if tok is not None:
        archive_tokens.append(tok)
    new_extraction = {k: v for k, v in extraction.items()
                      if k not in ("raw_truncated_response",
                                   "truncated_stage",
                                   "truncated_max_tokens")}
    new_extraction["archive_truncated"] = archive_trunc
    new_extraction["archive_max_tokens"] = archive_tokens
    patch = {
        "status":              f"pool_{trunc_stage}",
        "review_reason":       None,
        "active_batch_run_id": None,
        "extraction_result":   new_extraction,
        STAGES[trunc_stage]["batch_id_col"]: None,
    }
    # Warn if operator likely forgot to bump max_tokens.
    if len(archive_trunc) > 1 and tok == DEFAULT_MAX_TOKENS:
        print(f"    WARN: row {row['id'][:8]} has {len(archive_trunc)} "
              f"prior truncations AND last max_tokens == current default "
              f"({DEFAULT_MAX_TOKENS}). Did you forget to bump it?")
    return patch, "recovered_truncated"


def _recover_errored_like(row: dict, run_id_for_event: Optional[str], reason: str) -> tuple[dict, str]:
    """errored/canceled/expired — clear that stage's batch_id + active_batch_run_id,
    back to pool_{stage}. Stage is inferred from whichever batch_id column is set."""
    target_stage: Optional[AiStage] = None
    for stage in ("discover", "extract", "modifier", "branding", "pdf", "image_menu"):
        if row.get(STAGES[stage]["batch_id_col"]):
            target_stage = stage
            break
    if target_stage is None:
        # Fall back to the status-less "queued" requeue; no batch_id to clear.
        patch = {"status": "queued", "review_reason": None,
                 "active_batch_run_id": None}
        return patch, f"recovered_{reason}"
    patch = {
        "status":              f"pool_{target_stage}",
        "review_reason":       None,
        "active_batch_run_id": None,
        STAGES[target_stage]["batch_id_col"]: None,
    }
    return patch, f"recovered_{reason}"


def _recover_deploy_collision(row: dict, run_id_for_event: Optional[str]) -> Optional[tuple[dict, str]]:
    """Verify liveness first: re-query sessions.deploy_status. If still in
    queued/executing, skip (return None). Else promote to ready_to_assemble."""
    pt_id = row.get("pt_record_id")
    live = _session_deploy_status(pt_id) if pt_id else None
    if live in ("queued", "executing"):
        print(f"    SKIP row {row['id'][:8]}: sessions.deploy_status={live} — deploy still live")
        return None
    patch = {"status": "ready_to_assemble", "review_reason": None}
    return patch, "recovered_deploy_collision"


def _recover_assemble_validation(row: dict, run_id_for_event: Optional[str]) -> tuple[dict, str]:
    patch = {"status": "ready_to_assemble", "review_reason": None}
    return patch, "recovered_assemble_validation"


def _recover_deadletter_post_drain(row: dict, run_id_for_event: Optional[str]) -> tuple[dict, str]:
    """Clear preflight to force re-classification on the next rebuild."""
    patch = {"status": "queued", "review_reason": None, "preflight": None,
             "active_batch_run_id": None}
    # Also clear all stage batch_ids — the row needs a clean slate.
    for stage in ("discover", "extract", "modifier", "branding", "pdf", "image_menu"):
        col = STAGES[stage]["batch_id_col"]
        if row.get(col):
            patch[col] = None
    return patch, "recovered_deadletter_post_drain"


def recover_review(
    reason: str,
    *,
    run_id: Optional[str] = None,
    force: bool = False,
    dry_run: bool = True,
) -> dict[str, int]:
    """Recover `needs_review`/`review_reason=<reason>` rows per §2.10.
    Returns {'eligible': N, 'recovered': M, 'skipped': K}.
    """
    if reason not in ALL_REVIEW_REASONS:
        raise ValueError(f"unknown review_reason {reason!r}. "
                         f"Known: {sorted(ALL_REVIEW_REASONS)}")
    if reason in MANUAL_ONLY_REASONS and not force:
        raise SystemExit(f"ERROR: --recover-review {reason} requires --force "
                         f"(manual-only per §2.10)")

    rows = _select_needs_review_rows(reason, run_id)
    print(f"\n[RECOVER] reason={reason} run_id={run_id or '*'} "
          f"eligible={len(rows)} dry_run={dry_run}")

    stats = {"eligible": len(rows), "recovered": 0, "skipped": 0}
    if dry_run:
        return stats

    dispatch = {
        "stuck_orphan":               _recover_stuck_orphan,
        "truncated":                  _recover_truncated,
        "deploy_in_flight_collision": _recover_deploy_collision,
        "assemble_validation":        _recover_assemble_validation,
        "deadletter_post_drain":      _recover_deadletter_post_drain,
    }
    recover_fn = dispatch.get(reason)
    if recover_fn is None:
        # errored / canceled / expired / discover_no_url
        recover_fn = lambda row, rid: _recover_errored_like(row, rid, reason)  # noqa: E731

    for row in rows:
        try:
            result = recover_fn(row, run_id)
            if result is None:
                stats["skipped"] += 1
                continue
            patch, event_type = result
            _patch_row(row["id"], patch)
            # Target stage for the event: whichever pool it was re-pooled to.
            new_status = patch.get("status", "")
            stage_for_event: AiStage = "branding"
            if new_status.startswith("pool_"):
                candidate = new_status[len("pool_"):]
                if candidate in STAGES:
                    stage_for_event = candidate  # type: ignore
            log_event(
                batch_queue_id=row["id"],
                rebuild_run_id=row.get("rebuild_run_id") or run_id or "",
                stage=stage_for_event,
                event_type=event_type,
                error_text=f"{reason} → {new_status}",
                review_reason=None,
            )
            stats["recovered"] += 1
        except Exception as e:
            print(f"    ERROR row {row['id'][:8]}: {type(e).__name__}: {e}")
            stats["skipped"] += 1

    print(f"[RECOVER] done: recovered={stats['recovered']} "
          f"skipped={stats['skipped']} of {stats['eligible']}")
    return stats


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
# Post-flight report — cost variance + cache stats (§7.16)
# ---------------------------------------------------------------------------
#
# project_cost() runs pre-submit from preflight verdicts. print_report()
# closes the loop by pulling actuals from Anthropic + batch_queue_events and
# surfacing drift (>10% triggers a cost-model recalibration WARNING) plus
# per-stage cache amortization verdict.

# P95 multiplier applied to output-heavy stages (extract, modifier, pdf,
# image_menu) per §7 — per-row cost is long-tailed; mean-based projection
# systematically under-counts.
_P95_STAGES: set[AiStage] = {"extract", "modifier", "pdf", "image_menu"}
_P95_MULTIPLIER = 1.5


def project_cost_p95(verdicts: list[PreflightVerdict]) -> float:
    counts, _ = project_cost(verdicts)
    total = 0.0
    for stage, n in counts.items():
        mult = _P95_MULTIPLIER if stage in _P95_STAGES else 1.0
        total += n * COST_PER_REQ_USD[stage] * mult
    return total


def _fetch_event_cost_totals(run_id: str) -> tuple[float, dict[AiStage, dict[str, int]]]:
    """Pull events for this run and aggregate cost_usd + token counts per
    stage. Returns (total_usd, per_stage_token_table).
    Token table shape: {stage: {input, output, cache_creation, cache_read, n_reqs}}
    """
    url = f"{SUPABASE_URL}/rest/v1/batch_queue_events"
    total = 0.0
    per_stage: dict[AiStage, dict[str, int]] = {}
    offset = 0
    page_size = 1000
    while True:
        params = {
            "select": ("stage,cost_usd,input_tokens,output_tokens,"
                       "cache_creation_tokens,cache_read_tokens,event_type"),
            "rebuild_run_id": f"eq.{run_id}",
            "event_type": "in.(drained_success,drained_truncated)",
            "limit": str(page_size),
            "offset": str(offset),
            "order": "ts.asc",
        }
        r = requests.get(url, headers={**HEADERS, "Accept": "application/json"},
                         params=params, timeout=60)
        r.raise_for_status()
        rows = r.json() or []
        for ev in rows:
            stg = ev.get("stage")
            if stg not in STAGES:
                continue
            entry = per_stage.setdefault(stg, {
                "input": 0, "output": 0,
                "cache_creation": 0, "cache_read": 0, "n_reqs": 0,
            })
            entry["input"]          += int(ev.get("input_tokens") or 0)
            entry["output"]         += int(ev.get("output_tokens") or 0)
            entry["cache_creation"] += int(ev.get("cache_creation_tokens") or 0)
            entry["cache_read"]     += int(ev.get("cache_read_tokens") or 0)
            entry["n_reqs"]         += 1
            cu = ev.get("cost_usd")
            if cu is not None:
                try:
                    total += float(cu)
                except (TypeError, ValueError):
                    pass
        if len(rows) < page_size:
            break
        offset += page_size
    return total, per_stage


def print_report(
    verdicts: Optional[list[PreflightVerdict]],
    run_id: str,
    stage_group_results: Optional[list[StageGroupResult]] = None,
    assemble_stats: Optional[AssembleStats] = None,
) -> None:
    """End-of-run report: projected vs actual cost variance (§7.16) +
    per-stage cache stats table + assemble disposition.
    """
    print(f"\n{'=' * 68}")
    print(f"POST-FLIGHT REPORT — run_id={run_id}")
    print("=" * 68)

    projected_mean = 0.0
    projected_p95 = 0.0
    if verdicts:
        _, projected_mean = project_cost(verdicts)
        projected_p95 = project_cost_p95(verdicts)

    actual_usd, per_stage_tok = _fetch_event_cost_totals(run_id)
    print(f"\nCost — projected (mean): ${projected_mean:.2f}")
    print(f"Cost — projected (P95):  ${projected_p95:.2f}")
    print(f"Cost — actual (events):  ${actual_usd:.2f}")
    if projected_p95 > 0:
        delta = 100.0 * (actual_usd / projected_p95 - 1.0)
        print(f"Cost — delta vs P95:     {delta:+.1f}%")
        if abs(delta) > 10.0:
            print("WARNING: cost model drift >10% — regenerate "
                  "COST_PER_REQ_USD from this run before next rebuild.")

    # Per-stage cache stats
    print(f"\nPer-stage cache amortization:")
    print(f"  {'stage':<12} {'N':>5}  {'cache_create':>14}  "
          f"{'cache_read':>12}  {'ratio':>6}  verdict")
    for stage in ("discover", "extract", "modifier", "branding",
                  "pdf", "image_menu"):
        entry = per_stage_tok.get(stage)
        if not entry or entry["n_reqs"] == 0:
            continue
        cc = entry["cache_creation"]
        cr = entry["cache_read"]
        if cc == 0 and cr == 0:
            verdict = "— no cache"
            ratio_s = "—"
        else:
            ratio = (cr / cc) if cc > 0 else float("inf")
            if ratio >= 3.0:
                verdict = "✓ amortized"
            elif ratio >= 1.0:
                verdict = "⚠ marginal"
            else:
                verdict = "✗ LOSS — disable"
            ratio_s = f"{ratio:.2f}"
        print(f"  {stage:<12} {entry['n_reqs']:>5}  {cc:>14,}  "
              f"{cr:>12,}  {ratio_s:>6}  {verdict}")

    # Stage-group + assemble summary (per-group row counts)
    if stage_group_results:
        print(f"\nStage-group disposition:")
        for sgr in stage_group_results:
            route_summary = " ".join(
                f"{k}={v}" for k, v in sorted(sgr.transition_counts.items())
            )
            print(f"  {sgr.stage:<12} submitted={sgr.submitted} "
                  f"adopted={sgr.adopted} drained={sgr.drained} "
                  f"errors={len(sgr.errors)}")
            if route_summary:
                print(f"    → {route_summary}")
    if assemble_stats is not None:
        print(f"\nAssemble (POST /api/batch/ingest):")
        print(f"  ok={assemble_stats.ok}  "
              f"conflict_409={assemble_stats.conflict_409}  "
              f"throttled_give_up={assemble_stats.throttled_gave_up}  "
              f"other_error={assemble_stats.other_error}")
    print("=" * 68)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# build_requests_fn adapter — reuses batch_pipeline.py's proven per-stage
# message builders + prompt dict + model constants. Keeps PR3 a pure
# orchestration layer; PR2's builders remain single-source-of-truth.
# ---------------------------------------------------------------------------

def _cache_control_for(mode: "CacheMode") -> Optional[dict]:
    if mode == "5min":
        return {"type": "ephemeral"}
    if mode == "1h":
        return {"type": "ephemeral", "ttl": "1h"}
    return None


def _model_for_stage(stage: AiStage) -> str:
    from batch_pipeline import (  # noqa: E402
        BATCH_MODEL, PDF_BATCH_MODEL, IMAGE_MENU_BATCH_MODEL,
    )
    if stage == "pdf":
        return PDF_BATCH_MODEL
    if stage == "image_menu":
        return IMAGE_MENU_BATCH_MODEL
    return BATCH_MODEL


_STAGE_PROMPT_KEY: dict[AiStage, str] = {
    "discover":   "DISCOVERY_SYSTEM_PROMPT",
    "extract":    "MENU_EXTRACTION_SYSTEM_PROMPT",
    "modifier":   "MODIFIER_INFERENCE_SYSTEM_PROMPT",
    "branding":   "BRANDING_TOKENS_SYSTEM_PROMPT",
    "pdf":        "MENU_EXTRACTION_SYSTEM_PROMPT",
    "image_menu": "MENU_EXTRACTION_SYSTEM_PROMPT",
}

IMAGE_MENU_MAX_IMAGES = 6


def make_build_requests_fn(cli_cache_mode: "CacheModeCli"):
    """Return a build_requests_fn(stage, rows) suitable for run_stage_group.
    Imports batch_pipeline builders lazily so tests that don't need Anthropic
    prompts can still import rebuild_batch.
    """
    def _build(stage: AiStage, fresh: list[dict]) -> tuple[list[dict], dict]:
        from batch_pipeline import (  # noqa: E402
            _STAGE_PROMPTS, _build_discover_msg, _build_extract_msg,
            _build_modifier_msg, _build_branding_msg,
        )
        system_prompt = _STAGE_PROMPTS.get(_STAGE_PROMPT_KEY[stage])
        if not system_prompt:
            raise RuntimeError(f"missing system prompt for stage={stage}")

        # ~4 chars per token is the conventional rule of thumb for English.
        t_sys_approx = len(system_prompt) // 4
        mode = select_cache_mode(
            stage=stage,
            n_requests=len(fresh),
            t_sys=t_sys_approx,
            cli_override=cli_cache_mode,
        )
        sys_cache = _cache_control_for(mode)
        print(f"    [{stage}] cache_mode={mode} (t_sys≈{t_sys_approx}, n={len(fresh)})")

        system_block = {"type": "text", "text": system_prompt}
        if sys_cache is not None:
            system_block["cache_control"] = sys_cache

        model = _model_for_stage(stage)
        requests_list: list[dict] = []

        if stage in ("pdf", "image_menu"):
            for row in fresh:
                name = row.get("name") or "restaurant"
                rtype = row.get("restaurant_type") or "other"
                if stage == "pdf":
                    url = row.get("menu_url") or ""
                    if not url:
                        continue
                    content_blocks = [
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
                    ]
                else:
                    er = row.get("extraction_result") or {}
                    urls = er.get("image_menu_urls") if isinstance(er, dict) else None
                    if not urls:
                        continue
                    content_blocks = []
                    for i, u in enumerate(urls[:IMAGE_MENU_MAX_IMAGES]):
                        block = {"type": "image", "source": {"type": "url", "url": u}}
                        if i == 0:
                            block["cache_control"] = {"type": "ephemeral"}
                        content_blocks.append(block)
                    content_blocks.append({
                        "type": "text",
                        "text": (
                            f"Restaurant: {name}\nType: {rtype}\n\n"
                            "Extract all menu items from these menu images. "
                            "Follow the output schema exactly."
                        ),
                    })
                requests_list.append({
                    "custom_id": row["id"],
                    "params": {
                        "model": model,
                        "max_tokens": DEFAULT_MAX_TOKENS,
                        "system": [system_block],
                        "messages": [{"role": "user", "content": content_blocks}],
                    },
                })
            return requests_list, {}

        # Text stages: discover/extract/modifier/branding
        builder_for = {
            "discover": _build_discover_msg,
            "extract":  _build_extract_msg,
            "modifier": _build_modifier_msg,
            "branding": _build_branding_msg,
        }[stage]
        for row in fresh:
            try:
                user_msg = builder_for(row)
            except Exception as e:
                print(f"    [{stage}] build error for {row['id'][:8]}: {e}")
                continue
            if not user_msg:
                continue
            requests_list.append({
                "custom_id": row["id"],
                "params": {
                    "model": model,
                    "max_tokens": DEFAULT_MAX_TOKENS,
                    "system": [system_block],
                    "messages": [{"role": "user", "content": user_msg}],
                },
            })
        return requests_list, {}

    return _build


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="Single-shot batch rebuild agent (preflight + staged batches + assemble).",
    )
    # Execution mode — either start fresh, resume, or recover.
    mode = p.add_argument_group("execution mode")
    mode.add_argument(
        "--run-id", default=None,
        help="Resume an existing rebuild_run_id. Mutually exclusive with --reset.",
    )
    mode.add_argument(
        "--reset", action="store_true",
        help="Start a fresh run. Mutually exclusive with --run-id.",
    )
    mode.add_argument(
        "--dry-run", action="store_true",
        help="Preflight only — classify rows + project cost, then exit before "
             "any Anthropic batch submission.",
    )
    mode.add_argument(
        "--recover-review", default=None, metavar="REASON",
        help="Recover rows stuck at status='needs_review' with the given "
             "review_reason. See §2.10 for the matrix.",
    )
    mode.add_argument(
        "--recover-orphans", action="store_true",
        help="Alias for --recover-review stuck_orphan.",
    )
    mode.add_argument(
        "--force", action="store_true",
        help="Required for --recover-review {assemble_validation, "
             "deadletter_post_drain}.",
    )

    # Scope
    scope = p.add_argument_group("scope")
    scope.add_argument(
        "--status-filter", default=None,
        help="Comma-separated list of batch_queue.status values to include.",
    )
    scope.add_argument(
        "--limit", type=int, default=None,
        help="Cap the row set after fetching. Useful for smoke tests.",
    )
    scope.add_argument(
        "--include-done", action="store_true",
        help="Include rows already at status='done'. Default: skip them.",
    )
    scope.add_argument(
        "--workers", type=int, default=24,
        help="Parallel preflight workers (default 24).",
    )
    scope.add_argument(
        "--fetch", action="store_true",
        help="Re-fetch homepage/menu pages if raw_text/homepage_html is empty.",
    )

    # Behaviour flags
    beh = p.add_argument_group("behaviour")
    beh.add_argument(
        "--cache-mode", choices=("auto", "off", "force-5min", "force-1h"),
        default="auto",
        help="Per-stage cache-mode policy (§2.8). Default 'auto' uses the "
             "break-even heuristic.",
    )
    beh.add_argument(
        "--skip-assemble", action="store_true",
        help="Skip the POST /api/batch/ingest phase at the end.",
    )
    beh.add_argument(
        "--force-budget", action="store_true",
        help="Proceed even if projected cost exceeds BATCH_BUDGET_USD.",
    )
    beh.add_argument(
        "--replace-session", action="store_true",
        help="Pass replace_session=true to /api/batch/ingest.",
    )
    beh.add_argument(
        "--poll-interval", type=int, default=15,
        help="Anthropic batch poll interval in seconds (default 15).",
    )

    args = p.parse_args()
    if args.run_id and args.reset:
        p.error("--run-id and --reset are mutually exclusive")
    if args.recover_orphans:
        if args.recover_review and args.recover_review != "stuck_orphan":
            p.error("--recover-orphans conflicts with --recover-review=<other>")
        args.recover_review = "stuck_orphan"
    return args


def _env_preflight() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.stderr.write("ERROR: SUPABASE_URL / SUPABASE_KEY not set. Check agent/.env.\n")
        sys.exit(2)


def main():
    args = parse_args()
    _env_preflight()
    assert_schema()

    # §2.10 recover path — short-circuits everything else.
    if args.recover_review:
        stats = recover_review(
            reason=args.recover_review,
            run_id=args.run_id,
            force=args.force,
            dry_run=args.dry_run,
        )
        print(f"[RECOVER] {stats}")
        return

    # §7.12 advisory lock — fail fast if another rebuild is running.
    acquire_rebuild_lock()

    run_id = (
        args.run_id
        or f"rb-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}"
    )
    status_filter = None
    if args.status_filter:
        status_filter = [s.strip() for s in args.status_filter.split(",") if s.strip()]

    print(f"[REBUILD] run_id={run_id}  dry_run={args.dry_run}  cache_mode={args.cache_mode}")
    print(f"[REBUILD] status_filter={status_filter or 'ALL'}  "
          f"include_done={args.include_done}  limit={args.limit}")

    rows = fetch_rows(status_filter)
    if not args.include_done:
        rows = [r for r in rows if r.get("status") != "done"]
    if args.limit:
        rows = rows[: args.limit]
    print(f"[REBUILD] {len(rows)} rows in scope")
    if not rows:
        print("[REBUILD] nothing to do")
        return

    # Preflight — mandatory, populates `preflight` jsonb + rebuild_run_id tag.
    verdicts = run_preflight(rows, run_id, workers=args.workers, fetch=args.fetch)
    print_preflight_summary(verdicts)

    # Cost gate — check projected P95 against budget.
    from batch_pipeline import BATCH_BUDGET_USD  # noqa: E402
    projected_p95 = project_cost_p95(verdicts)
    print(f"\n[BUDGET] projected P95 ${projected_p95:.2f} vs "
          f"BATCH_BUDGET_USD=${BATCH_BUDGET_USD:.2f}")
    if projected_p95 > BATCH_BUDGET_USD and not args.force_budget:
        sys.stderr.write(
            f"ERROR: projected P95 cost ${projected_p95:.2f} exceeds budget "
            f"${BATCH_BUDGET_USD:.2f}. Pass --force-budget to override.\n"
        )
        sys.exit(3)

    if args.dry_run:
        print("[REBUILD] --dry-run: stopping before batch submission")
        print_report(verdicts, run_id)
        return

    # Re-fetch rows so we pick up the preflight JSONB we just wrote.
    all_rows = fetch_rows(status_filter)
    scope_ids = {v.row_id for v in verdicts}
    scoped_rows = [r for r in all_rows if r["id"] in scope_ids]

    build_requests_fn = make_build_requests_fn(args.cache_mode)

    stage_results: list[StageGroupResult] = []

    # Group A — discover (serial; its output feeds extract)
    a = run_stage_group(
        group_name="A",
        stages=["discover"],
        rows=scoped_rows,
        run_id=run_id,
        build_requests_fn=build_requests_fn,
        model_for_stage=_model_for_stage,
        poll_interval_s=args.poll_interval,
    )
    stage_results.extend(a)

    # Re-fetch between groups — discover writes menu_url which extract reads.
    scoped_rows = [r for r in fetch_rows(status_filter) if r["id"] in scope_ids]

    # Group B — extract + pdf + image_menu (parallel; all produce extraction_result)
    b = run_stage_group(
        group_name="B",
        stages=["extract", "pdf", "image_menu"],
        rows=scoped_rows,
        run_id=run_id,
        build_requests_fn=build_requests_fn,
        model_for_stage=_model_for_stage,
        poll_interval_s=args.poll_interval,
    )
    stage_results.extend(b)

    scoped_rows = [r for r in fetch_rows(status_filter) if r["id"] in scope_ids]

    # Group C — modifier + branding (parallel; join → ready_to_assemble)
    c = run_stage_group(
        group_name="C",
        stages=["modifier", "branding"],
        rows=scoped_rows,
        run_id=run_id,
        build_requests_fn=build_requests_fn,
        model_for_stage=_model_for_stage,
        poll_interval_s=args.poll_interval,
    )
    stage_results.extend(c)

    # Assemble — POST /api/batch/ingest for every ready_to_assemble row.
    assemble_stats = None
    if not args.skip_assemble:
        assemble_stats = run_assemble(run_id)
    else:
        print("[REBUILD] --skip-assemble: leaving rows at ready_to_assemble")

    print_report(verdicts, run_id, stage_results, assemble_stats)
    print(f"\n[REBUILD] done. run_id={run_id}")


if __name__ == "__main__":
    main()
