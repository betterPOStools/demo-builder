"""
v8 rubric sanity check — re-rank the ~60 prospects we flagged as likely v7 mis-tiers
(breweries, bar-and-grills, taverns, pubs, + competitor-POS URL misses) using the new
v8 rubric, then diff against v7 output already stored in demo_builder.prospect_rankings.

Does NOT write to the database — pure eyeball check before committing to a full re-rank.

Run:  python3 agent/pt_rank_v8_sample.py
"""

import json
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import anthropic
import requests
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
from scrape_loader import load_prospects

load_dotenv(Path(__file__).parent / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

MODEL = "claude-haiku-4-5-20251001"
MAX_RAW_CHARS = 12_000
MAX_HTML_CHARS = 6_000

RUBRIC_V8_PATH = Path(__file__).parent / "prompts" / "pt_rank_rubric_v8.md"


def load_rubric(path):
    text = path.read_text()
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            text = text[end + 5:]
    return text.lstrip()


RUBRIC_V8 = load_rubric(RUBRIC_V8_PATH)


FLAG_KEYWORDS = [
    "brew", "tavern", "pub", "gastropub",
    "bar & grill", "bar and grill", "& grill",
    "sports bar",
]

COMPETITOR_POS_URLS = [
    "skytab", "smorefood",
]


def collect_flagged(prospects):
    flagged = []
    seen = set()
    for p in prospects:
        pid = p.get("place_id")
        if not pid or pid in seen:
            continue
        name = (p.get("name") or "").lower()
        web = (p.get("website") or "").lower()
        hit = None
        for kw in FLAG_KEYWORDS:
            if kw in name:
                hit = f"name:{kw}"
                break
        if not hit:
            for dom in COMPETITOR_POS_URLS:
                if dom in web:
                    hit = f"url:{dom}"
                    break
        if hit:
            p["_flag_reason"] = hit
            flagged.append(p)
            seen.add(pid)
    return flagged


def fetch_v7_rows(place_ids):
    """Fetch v7 rankings for the flagged prospects from demo_builder.prospect_rankings."""
    H = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
         "Accept-Profile": "demo_builder"}
    # PostgREST in.() with many ids — batch in chunks of 100
    out = {}
    for i in range(0, len(place_ids), 100):
        chunk = place_ids[i : i + 100]
        ids = ",".join(chunk)
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/prospect_rankings",
            headers=H,
            params={"select": "place_id,tier,score,reasoning", "place_id": f"in.({ids})"},
            timeout=30,
        )
        r.raise_for_status()
        for row in r.json():
            out[row["place_id"]] = row
    return out


def build_user_message(p):
    parts = ["Prospect metadata (Outscraper structured fields):"]
    fields = [
        ("name", "name"), ("category", "category"), ("subtypes", "subtypes"),
        ("website", "website"), ("phone", "phone"),
        ("street", "street"), ("city", "city"), ("state", "state"),
        ("company_name", "company_name (parent org)"),
        ("full_name", "owner_name"), ("title", "owner_title"), ("email", "email"),
        ("rating", "google_rating"), ("reviews", "review_count"),
        ("business_status", "business_status"),
        ("working_hours_csv_compatible", "hours"),
        ("about", "about_blurb"),
    ]
    for k, label in fields:
        v = p.get(k)
        if v:
            parts.append(f"- {label}: {v}")
    sibs = p.get("sibling_locations") or 1
    if sibs > 1:
        cities = p.get("sibling_cities") or ""
        parts.append(
            f"- DERIVED_location_count: {sibs} locations in our scrape corpus"
            + (f" (cities: {cities})" if cities else "")
            + ". Multi-location brand — treat as mid_market unless national franchise."
        )
    else:
        parts.append("- DERIVED_location_count: 1")
    raw = (p.get("raw_text") or "")[:MAX_RAW_CHARS]
    html = (p.get("homepage_html") or "")[:MAX_HTML_CHARS]
    if html:
        parts.append(f"\n=== HOMEPAGE HTML ===\n{html}")
    if raw:
        parts.append(f"\n=== MENU PAGE TEXT ===\n{raw}")
    if not (html or raw):
        parts.append(
            "\n(No raw scrape — rank from Outscraper fields only. Non-restaurant category = not_a_fit.)"
        )
    parts.append("\nRank this prospect. Output JSON only.")
    return "\n".join(parts)


def rank(client, p):
    msg = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        temperature=0,
        system=[{"type": "text", "text": RUBRIC_V8, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": build_user_message(p)}],
    )
    text = msg.content[0].text
    try:
        start = text.index("{")
        end = text.rindex("}") + 1
        return json.loads(text[start:end]), msg.usage
    except (ValueError, json.JSONDecodeError) as e:
        return {"_parse_error": str(e), "_raw": text[:400]}, msg.usage


def main():
    print("[load] scrape corpus…")
    prospects = load_prospects(enrich=True)
    flagged = collect_flagged(prospects)
    print(f"[flag] {len(flagged)} prospects flagged for re-rank")

    v7 = fetch_v7_rows([p["place_id"] for p in flagged])
    print(f"[v7] fetched {len(v7)} v7 rows")

    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

    # Tier transition matrix
    from collections import Counter, defaultdict
    flips = defaultdict(list)
    stays = Counter()
    total_in = total_out = total_cache_read = 0

    colors = {"small_indie":"\033[32m","mid_market":"\033[36m","kiosk_tier":"\033[33m",
              "chain_nogo":"\033[31m","not_a_fit":"\033[90m"}
    reset = "\033[0m"

    for i, p in enumerate(flagged, 1):
        try:
            parsed, usage = rank(client, p)
        except anthropic.APIError as e:
            print(f"[!] {p.get('name')} — API error: {e}")
            continue
        total_in += usage.input_tokens
        total_out += usage.output_tokens
        total_cache_read += getattr(usage, "cache_read_input_tokens", 0)

        if "_parse_error" in parsed:
            print(f"[!] {p.get('name')} parse error")
            continue

        v7_row = v7.get(p["place_id"])
        v7_tier = v7_row["tier"] if v7_row else "?"
        v7_score = v7_row["score"] if v7_row else "?"
        v8_tier = parsed.get("tier", "?")
        v8_score = parsed.get("score", 0)

        if v7_tier != v8_tier:
            flips[(v7_tier, v8_tier)].append((p["name"], v7_score, v8_score,
                                              parsed.get("reasoning",""), p["_flag_reason"]))
            arrow_color = colors.get(v8_tier, "")
            print(f"\n[{i}/{len(flagged)}] {arrow_color}FLIP{reset}  {p['name']}  ({p['_flag_reason']})")
            print(f"    v7: {colors.get(v7_tier,'')}{v7_tier}{reset}/{v7_score}  →  "
                  f"v8: {arrow_color}{v8_tier}{reset}/{v8_score}")
            print(f"    v8 reason: {parsed.get('reasoning','')[:180]}")
        else:
            stays[v8_tier] += 1
            print(f"[{i}/{len(flagged)}] same  {p['name']}  (v7={v7_tier}/{v7_score}, v8={v8_tier}/{v8_score})")

    print(f"\n\n=== SUMMARY ({len(flagged)} flagged) ===")
    print(f"Unchanged tiers: {dict(stays)}")
    print(f"Flips (v7 → v8):")
    for (f_from, f_to), items in sorted(flips.items(), key=lambda x: -len(x[1])):
        print(f"  {colors.get(f_from,'')}{f_from}{reset} → {colors.get(f_to,'')}{f_to}{reset}  ({len(items)})")
        for name, s7, s8, _, reason in items[:5]:
            print(f"      • {name}  ({s7}→{s8})  [flag: {reason}]")

    cost = (total_in / 1_000_000) * 1.0 + (total_out / 1_000_000) * 5.0
    cache_ratio = total_cache_read / max(total_in, 1) * 100
    print(f"\ntokens: in={total_in} out={total_out} cache_read={total_cache_read} "
          f"({cache_ratio:.0f}% cache hit)")
    print(f"cost: ~${cost:.4f} synchronous")


if __name__ == "__main__":
    main()
