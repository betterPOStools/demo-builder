"""
PT ranking prototype — synchronously rank N prospects using Haiku + raw scrape data.

Reads batch_queue.raw_text + homepage_html for prospects already pushed through the
demo-builder pipeline (those have preserved scrape data). Prints Haiku's fit-tier
verdict + reasoning to let the user eyeball output quality before we scale to batch.

Run:  python3 agent/pt_rank_prototype.py                 # ranks 10 default samples
      python3 agent/pt_rank_prototype.py --limit 5
      python3 agent/pt_rank_prototype.py --id <uuid>     # single prospect

Env:  reads agent/.env (SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY)
"""

import argparse
import json
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import anthropic
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

MODEL = "claude-haiku-4-5-20251001"
MAX_RAW_CHARS = 12_000
MAX_HTML_CHARS = 6_000

SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept-Profile": "demo_builder",
}


RUBRIC_VERSION = "v7-2026-04-14"
RUBRIC_PATH = Path(__file__).parent / "prompts" / "pt_rank_rubric_v7.md"


def _load_rubric(path=RUBRIC_PATH):
    """Load rubric from markdown file, stripping leading YAML frontmatter."""
    text = path.read_text()
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            text = text[end + 5:]
    return text.lstrip()


RUBRIC_SYSTEM = _load_rubric()




def fetch_prospects(limit=10, specific_id=None):
    params = {
        "select": "id,name,menu_url,restaurant_type,raw_text,homepage_html",
        "raw_text": "not.is.null",
        "limit": str(limit),
        "order": "updated_at.desc",
    }
    if specific_id:
        params["id"] = f"eq.{specific_id}"
        params.pop("order", None)
        params.pop("raw_text", None)
    else:
        params["status"] = "eq.done"
    r = requests.get(f"{SUPABASE_URL}/rest/v1/batch_queue", headers=SB_HEADERS, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def build_user_message(row):
    raw = (row.get("raw_text") or "")[:MAX_RAW_CHARS]
    html = (row.get("homepage_html") or "")[:MAX_HTML_CHARS]
    return f"""Prospect metadata:
- name: {row.get("name")}
- menu_url: {row.get("menu_url")}
- restaurant_type hint: {row.get("restaurant_type") or "unknown"}

=== HOMEPAGE HTML (first {MAX_HTML_CHARS} chars) ===
{html}

=== MENU PAGE TEXT (first {MAX_RAW_CHARS} chars) ===
{raw}

Rank this prospect. Output JSON only."""


def rank_prospect(client, row):
    msg = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        temperature=0,
        system=[{"type": "text", "text": RUBRIC_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": build_user_message(row)}],
    )
    text = msg.content[0].text
    try:
        start = text.index("{")
        end = text.rindex("}") + 1
        parsed = json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError) as e:
        parsed = {"_parse_error": str(e), "_raw": text[:500]}
    return parsed, msg.usage


def fmt(parsed, usage, row):
    name = row["name"]
    if "_parse_error" in parsed:
        print(f"\n[!] {name} — parse error: {parsed['_parse_error']}")
        print(f"    raw: {parsed['_raw'][:300]}")
        return
    tier = parsed.get("tier", "?")
    score = parsed.get("score", "?")
    reasoning = parsed.get("reasoning", "")
    signals = parsed.get("fit_signals", [])
    concerns = parsed.get("concerns", [])

    tier_color = {
        "small_indie": "\033[32m",
        "mid_market": "\033[36m",
        "kiosk_tier": "\033[33m",
        "chain_nogo": "\033[31m",
        "not_a_fit": "\033[90m",
    }.get(tier, "")
    reset = "\033[0m"

    print(f"\n{tier_color}▸ {name}{reset}")
    print(f"  tier={tier_color}{tier}{reset}  score={score}  type_hint={row.get('restaurant_type') or '?'}")
    print(f"  reasoning: {reasoning}")
    if signals:
        print(f"  signals:")
        for s in signals:
            weight = s.get("weight", "?")
            w_color = "\033[32m" if weight == "+" else "\033[31m"
            print(f"    {w_color}{weight}{reset} {s.get('signal')}: {s.get('evidence', '')[:120]}")
    if concerns:
        print(f"  concerns: {'; '.join(concerns)}")
    print(
        f"  tokens: in={usage.input_tokens} out={usage.output_tokens} "
        f"cache_read={getattr(usage, 'cache_read_input_tokens', 0)} "
        f"cache_create={getattr(usage, 'cache_creation_input_tokens', 0)}"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--id", type=str, help="Specific batch_queue.id to rank")
    args = parser.parse_args()

    prospects = fetch_prospects(limit=args.limit, specific_id=args.id)
    if not prospects:
        print("No prospects found with raw_text preserved.")
        sys.exit(1)

    print(f"Ranking {len(prospects)} prospect(s) with {MODEL}")
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

    total_in = total_out = 0
    for row in prospects:
        try:
            parsed, usage = rank_prospect(client, row)
            fmt(parsed, usage, row)
            total_in += usage.input_tokens
            total_out += usage.output_tokens
        except anthropic.APIError as e:
            print(f"\n[!] {row['name']} — API error: {e}")

    # Haiku 4.5 list pricing: $1/MTok in, $5/MTok out (synchronous, no batch discount)
    cost = (total_in / 1_000_000) * 1.0 + (total_out / 1_000_000) * 5.0
    print(f"\n---\nTotal tokens: in={total_in} out={total_out}  est. cost ~${cost:.4f}")


if __name__ == "__main__":
    main()
