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

import anthropic
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

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
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
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
