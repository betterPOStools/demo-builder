"""
Unified PT ranker — accepts a prospect dict with Outscraper fields + optional
raw_text/homepage_html. Reuses the RUBRIC_SYSTEM prompt from pt_rank_prototype.

Run:
    python3 agent/pt_rank_unified.py --limit 15                # random sample
    python3 agent/pt_rank_unified.py --limit 15 --with-html    # only prospects w/ HTML
    python3 agent/pt_rank_unified.py --limit 15 --no-html      # Outscraper-only
    python3 agent/pt_rank_unified.py --name "Big Bull's BBQ"
"""

import argparse
import json
import os
import random
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import anthropic
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

sys.path.insert(0, str(Path(__file__).parent))
from pt_rank_prototype import RUBRIC_SYSTEM, MODEL, MAX_RAW_CHARS, MAX_HTML_CHARS
from scrape_loader import load_prospects

ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]


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

    # Derived multi-location signal from Outscraper corpus (same normalized name at N place_ids)
    sibs = p.get("sibling_locations") or 1
    if sibs > 1:
        cities = p.get("sibling_cities") or ""
        parts.append(
            f"- DERIVED_location_count: {sibs} locations in our scrape corpus"
            + (f" (cities: {cities})" if cities else "")
            + ". This is a MULTI-LOCATION brand — treat as mid_market unless it matches a "
            "known national franchise from the chain_nogo list."
        )
    else:
        parts.append("- DERIVED_location_count: 1 (no sibling locations found in corpus)")

    raw = (p.get("raw_text") or "")[:MAX_RAW_CHARS]
    html = (p.get("homepage_html") or "")[:MAX_HTML_CHARS]
    if html:
        parts.append(f"\n=== HOMEPAGE HTML (first {MAX_HTML_CHARS} chars) ===\n{html}")
    if raw:
        parts.append(f"\n=== MENU PAGE TEXT (first {MAX_RAW_CHARS} chars) ===\n{raw}")
    if not (html or raw):
        parts.append(
            "\n(No raw scrape available — rank based on Outscraper structured fields alone. "
            "If the category is clearly non-restaurant, return not_a_fit.)"
        )
    parts.append("\nRank this prospect. Output JSON only.")
    return "\n".join(parts)


def rank(client, p):
    msg = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        temperature=0,
        system=[{"type": "text", "text": RUBRIC_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": build_user_message(p)}],
    )
    text = msg.content[0].text
    try:
        start = text.index("{")
        end = text.rindex("}") + 1
        parsed = json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError) as e:
        parsed = {"_parse_error": str(e), "_raw": text[:500]}
    return parsed, msg.usage


def fmt(p, parsed, usage):
    name = p.get("name")
    cat = p.get("category", "?")
    has_html = bool(p.get("raw_text") or p.get("homepage_html"))
    tag = "[HTML+]" if has_html else "[META ]"
    if "_parse_error" in parsed:
        print(f"\n[!] {tag} {name} — parse error: {parsed['_parse_error']}")
        print(f"    raw: {parsed['_raw'][:300]}")
        return

    tier = parsed.get("tier", "?")
    score = parsed.get("score", "?")
    reasoning = parsed.get("reasoning", "")
    colors = {"small_indie": "\033[32m", "mid_market": "\033[36m",
              "kiosk_tier": "\033[33m", "chain_nogo": "\033[31m",
              "not_a_fit": "\033[90m"}
    c = colors.get(tier, "")
    r = "\033[0m"
    print(f"\n{c}▸ {tag} {name}{r}  [{cat}]")
    print(f"  tier={c}{tier}{r}  score={score}")
    print(f"  reasoning: {reasoning}")
    signals = parsed.get("fit_signals", [])
    if signals:
        for s in signals[:6]:
            w = s.get("weight", "?")
            wc = "\033[32m" if w == "+" else "\033[31m"
            print(f"    {wc}{w}{r} {s.get('signal')}: {(s.get('evidence') or '')[:100]}")
    concerns = parsed.get("concerns", [])
    if concerns:
        print(f"  concerns: {'; '.join(concerns[:3])}")
    print(
        f"  tokens: in={usage.input_tokens} out={usage.output_tokens} "
        f"cache_read={getattr(usage, 'cache_read_input_tokens', 0)} "
        f"cache_create={getattr(usage, 'cache_creation_input_tokens', 0)}"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--with-html", action="store_true")
    ap.add_argument("--no-html", action="store_true")
    ap.add_argument("--name", type=str)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    prospects = load_prospects(enrich=True)
    if args.name:
        ps = [p for p in prospects if args.name.lower() in (p.get("name") or "").lower()]
    elif args.with_html:
        ps = [p for p in prospects if p.get("raw_text") or p.get("homepage_html")]
        random.seed(args.seed); random.shuffle(ps)
        ps = ps[: args.limit]
    elif args.no_html:
        ps = [p for p in prospects if not (p.get("raw_text") or p.get("homepage_html"))]
        random.seed(args.seed); random.shuffle(ps)
        ps = ps[: args.limit]
    else:
        random.seed(args.seed); random.shuffle(prospects)
        ps = prospects[: args.limit]

    if not ps:
        print("No prospects matched.")
        sys.exit(1)

    print(f"Ranking {len(ps)} prospect(s) with {MODEL}")
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

    from collections import Counter
    tier_hist = Counter()
    total_in = total_out = total_cache_read = 0
    for p in ps:
        try:
            parsed, usage = rank(client, p)
            fmt(p, parsed, usage)
            tier_hist[parsed.get("tier", "?")] += 1
            total_in += usage.input_tokens
            total_out += usage.output_tokens
            total_cache_read += getattr(usage, "cache_read_input_tokens", 0)
        except anthropic.APIError as e:
            print(f"[!] {p.get('name')} — API error: {e}")

    cost = (total_in / 1_000_000) * 1.0 + (total_out / 1_000_000) * 5.0
    print(f"\n---\ntier distribution: {dict(tier_hist)}")
    print(f"tokens: in={total_in} out={total_out} cache_read={total_cache_read}")
    print(f"est. cost ~${cost:.4f} (synchronous)")


if __name__ == "__main__":
    main()
