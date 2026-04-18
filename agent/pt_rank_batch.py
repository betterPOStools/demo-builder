"""
One-shot batch ranker for PT prospects.

1. Load ~2229 prospects from scrape_loader (Outscraper + optional batch_queue HTML).
2. Submit one Anthropic Messages Batch with a ranking request per prospect.
3. Poll the batch until it ends (Anthropic SLA: up to 24h, typically minutes).
4. Parse each result JSON and upsert into demo_builder.prospect_rankings.

Run:
    python3 agent/pt_rank_batch.py --dry-run       # build requests, print stats, do not submit
    python3 agent/pt_rank_batch.py --submit        # submit, exit (poll later)
    python3 agent/pt_rank_batch.py --poll          # poll latest submitted batch + ingest
    python3 agent/pt_rank_batch.py --run           # submit + poll + ingest (blocks until done)
    python3 agent/pt_rank_batch.py --limit 50 --run    # rank only first 50 prospects
    python3 agent/pt_rank_batch.py --only-missing --run    # rank prospects not already in table

Env (reads agent/.env): ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY
"""

import argparse
import json
import os
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import anthropic  # noqa: F401 — retained for type compatibility / SDK types
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

# Batch-governor client shims. The governor + calc_tokens packages are
# siblings under ``batch-governor/clients/python/`` and are re-exported via
# ``clients.python.*`` inside their own ``__init__.py`` — add BOTH the repo
# root and the ``clients/python`` dir to sys.path so short imports resolve.
_BATCH_GOVERNOR_ROOT = "/Users/nomad/Projects/betterpostools/batch-governor"
if _BATCH_GOVERNOR_ROOT not in sys.path:
    sys.path.insert(0, _BATCH_GOVERNOR_ROOT)
_BATCH_GOVERNOR_PY_CLIENTS = f"{_BATCH_GOVERNOR_ROOT}/clients/python"
if _BATCH_GOVERNOR_PY_CLIENTS not in sys.path:
    sys.path.insert(0, _BATCH_GOVERNOR_PY_CLIENTS)

from governor import Anthropic  # drop-in subclass; routes batches through :5185
from calc_tokens import CalcTokensClient  # cost projection + calibration client

sys.path.insert(0, str(Path(__file__).parent))
from pt_rank_prototype import MODEL
from pt_rank_unified import build_user_message
from scrape_loader import load_prospects

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

RUBRIC_VERSION = "v8-2026-04-14"
RUBRIC_PATH = Path(__file__).parent / "prompts" / f"pt_rank_rubric_{RUBRIC_VERSION.split('-')[0]}.md"


def _load_rubric(path=RUBRIC_PATH):
    text = path.read_text()
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            text = text[end + 5:]
    return text.lstrip()


RUBRIC_SYSTEM = _load_rubric()
STATE_FILE = Path(__file__).parent / ".pt_rank_batch_state.json"

SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept-Profile": "demo_builder",
    "Content-Profile": "demo_builder",
    "Content-Type": "application/json",
}


def save_state(d):
    STATE_FILE.write_text(json.dumps(d, indent=2))


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def build_request(p):
    """Anthropic Messages Batch request shape. custom_id = place_id."""
    return {
        "custom_id": p["place_id"],
        "params": {
            "model": MODEL,
            "max_tokens": 2000,
            "temperature": 0,
            "system": [{
                "type": "text",
                "text": RUBRIC_SYSTEM,
                "cache_control": {"type": "ephemeral"},
            }],
            "messages": [{"role": "user", "content": build_user_message(p)}],
        },
    }


def fetch_existing_place_ids():
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/prospect_rankings",
        headers=SB_HEADERS,
        params={"select": "place_id", "limit": "10000"},
        timeout=30,
    )
    r.raise_for_status()
    return {row["place_id"] for row in r.json()}


def prepare_prospects(limit=None, only_missing=False, require_place_id=True):
    ps = load_prospects(enrich=True)
    if require_place_id:
        ps = [p for p in ps if p.get("place_id")]
    if only_missing:
        have = fetch_existing_place_ids()
        ps = [p for p in ps if p["place_id"] not in have]
        print(f"[prep] skipping {len(have)} already-ranked prospects")
    if limit:
        ps = ps[:limit]
    return ps


def submit_batch(prospects):
    print(f"[submit] building {len(prospects)} requests")
    requests_list = [build_request(p) for p in prospects]
    # AI: Haiku 4.5 batch ranker. Routes through batch-governor :5185 which
    # applies pre-submit gate (batch-size cap, per-submit cap, dedup, model
    # allowlist) before calling Anthropic's batches API. Fail-open per ADR-005.
    client = Anthropic(app="demo-builder-pt-rank", api_key=ANTHROPIC_KEY)
    batch = client.messages.batches.create(requests=requests_list)
    state = load_state()
    state["batch_id"] = batch.id
    state["submitted_at"] = int(time.time())
    state["request_count"] = len(requests_list)
    state["rubric_version"] = RUBRIC_VERSION
    state["model"] = MODEL
    save_state(state)
    print(f"[submit] ✓ batch_id={batch.id}  requests={len(requests_list)}")
    return batch.id


def poll_until_done(batch_id, poll_interval=30):
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    while True:
        b = client.messages.batches.retrieve(batch_id)
        counts = b.request_counts
        print(
            f"[poll] status={b.processing_status} "
            f"proc={counts.processing} succ={counts.succeeded} "
            f"err={counts.errored} exp={counts.expired} can={counts.canceled}"
        )
        if b.processing_status == "ended":
            return b
        time.sleep(poll_interval)


def parse_ai_json(text):
    try:
        s = text.index("{")
        e = text.rindex("}") + 1
        return json.loads(text[s:e])
    except Exception:
        return None


def ingest_results(batch_id, prospects_by_pid):
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    rows_to_upsert = []
    errs = 0
    for entry in client.messages.batches.results(batch_id):
        pid = entry.custom_id
        p = prospects_by_pid.get(pid)
        if not p:
            continue
        if entry.result.type != "succeeded":
            errs += 1
            continue
        msg = entry.result.message
        text = msg.content[0].text if msg.content else ""
        parsed = parse_ai_json(text)
        if not parsed or "tier" not in parsed:
            errs += 1
            continue

        usage = msg.usage
        rows_to_upsert.append({
            "place_id": pid,
            "name": p.get("name") or "",
            "website": p.get("website"),
            "city": p.get("city"),
            "state": p.get("state"),
            "category": p.get("category"),
            "tier": parsed.get("tier"),
            "score": int(parsed.get("score", 0)),
            "reasoning": parsed.get("reasoning"),
            "fit_signals": parsed.get("fit_signals") or [],
            "concerns": parsed.get("concerns") or [],
            "detected_pos": parsed.get("detected_pos"),
            "detected_pos_evidence": parsed.get("detected_pos_evidence"),
            "estimated_swipe_volume": parsed.get("estimated_swipe_volume"),
            "swipe_volume_evidence": parsed.get("swipe_volume_evidence"),
            "sibling_locations": int(p.get("sibling_locations") or 1),
            "has_html_input": bool(p.get("raw_text") or p.get("homepage_html")),
            "rubric_version": RUBRIC_VERSION,
            "model": MODEL,
            "batch_id": batch_id,
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
            "cache_read_tokens": getattr(usage, "cache_read_input_tokens", None),
        })

    print(f"[ingest] parsed {len(rows_to_upsert)} rows, {errs} failed")
    if not rows_to_upsert:
        return

    # Chunked upsert (Postgrest prefers batches ≤1000)
    chunk_size = 500
    for i in range(0, len(rows_to_upsert), chunk_size):
        chunk = rows_to_upsert[i:i + chunk_size]
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/prospect_rankings",
            headers={**SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=chunk,
            timeout=60,
        )
        if not r.ok:
            print(f"[ingest] upsert failed {r.status_code}: {r.text[:500]}")
            return
        print(f"[ingest] ✓ upserted {i + len(chunk)}/{len(rows_to_upsert)}")

    # BUSINESS RULE: every run must feed the calculator's per-operation
    # reservoir so future projections converge on truth (ADR-001). Aggregate
    # actual token usage + derive cost via the calc service pricing table.
    try:
        total_input = sum((row.get("input_tokens") or 0) for row in rows_to_upsert)
        total_output = sum((row.get("output_tokens") or 0) for row in rows_to_upsert)
        total_cache_read = sum((row.get("cache_read_tokens") or 0) for row in rows_to_upsert)
        calc = CalcTokensClient()
        pricing = calc.getPricingTable().get(MODEL)
        if pricing is not None and rows_to_upsert:
            actual_cost_usd = (
                total_input * pricing["input_per_token"]
                + total_output * pricing["output_per_token"]
                + total_cache_read * pricing["cache_read_per_token"]
            )
            # Feed P50/P95/P99 reservoir with per-request averages so the
            # reservoir holds realistic per-request distribution, not batch sums.
            n = len(rows_to_upsert)
            calc.calibrateWithActualUsage({
                "operation": "pt-rank",
                "model": MODEL,
                "actual_input": int(total_input / n) if n else 0,
                "actual_output": int(total_output / n) if n else 0,
                "actual_cost_usd": float(actual_cost_usd / n) if n else 0.0,
            })
            print(
                f"[calibrate] ✓ operation=pt-rank model={MODEL} "
                f"total_in={total_input} total_out={total_output} "
                f"total_cost=${actual_cost_usd:.4f}"
            )
    except Exception as exc:  # calibration failure must never break ingest
        print(f"[calibrate] skipped (governor unreachable?): {exc}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--poll", action="store_true")
    ap.add_argument("--run", action="store_true", help="submit + poll + ingest")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--only-missing", action="store_true")
    args = ap.parse_args()

    if args.dry_run:
        ps = prepare_prospects(limit=args.limit, only_missing=args.only_missing)
        with_html = sum(1 for p in ps if p.get("raw_text") or p.get("homepage_html"))
        print(f"[dry-run] prospects: {len(ps)}  with_html: {with_html}")
        if ps:
            print("[dry-run] sample request:")
            req = build_request(ps[0])
            req["params"]["system"] = "<rubric omitted>"
            umsg = req["params"]["messages"][0]["content"]
            req["params"]["messages"] = [{"role": "user", "content": umsg[:800] + "..."}]
            print(json.dumps(req, indent=2))
        return

    if args.submit or args.run:
        ps = prepare_prospects(limit=args.limit, only_missing=args.only_missing)
        if not ps:
            print("no prospects to rank")
            return
        pid_map = {p["place_id"]: p for p in ps}
        state = load_state()
        state["prospect_place_ids"] = list(pid_map)
        save_state(state)
        batch_id = submit_batch(ps)
        if args.submit and not args.run:
            print(f"[submit] run `--poll` later or `--run` for one-shot")
            return
    else:
        batch_id = load_state().get("batch_id")
        if not batch_id:
            print("no submitted batch in state file")
            sys.exit(1)
        pid_set = set(load_state().get("prospect_place_ids") or [])
        ps = [p for p in load_prospects(enrich=True) if p.get("place_id") in pid_set]
        pid_map = {p["place_id"]: p for p in ps}

    if args.poll or args.run:
        b = poll_until_done(batch_id)
        print(f"[done] batch {batch_id} ended; ingesting…")
        ingest_results(batch_id, pid_map)


if __name__ == "__main__":
    main()
