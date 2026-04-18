#!/usr/bin/env python3
"""Single-query extraction tester — no batches, no caching.

Usage:
  python3 agent/test_extract.py <url>
  python3 agent/test_extract.py --row <batch_queue_id>
  python3 agent/test_extract.py --urls-file urls.txt

Runs the full fetch → extract pipeline against one URL and prints the item
count + first few items. Use this to iterate on fetch logic and prompts
without waiting 10+ min for batch submissions.
"""
import os
import sys
import json
import argparse
import urllib.request
from pathlib import Path

# Load .env.local
env_path = Path(__file__).parent.parent / ".env.local"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

sys.path.insert(0, str(Path(__file__).parent))
from pipeline_shared import (  # noqa: E402
    fetch_page_text_curl_cffi,
    fetch_page_text_playwright,
    extract_ldjson_full_menu,
    _extract_menu_index_links,
    _detect_menu_images,
)

import anthropic  # noqa: E402


# Mirror the extract system prompt from lib/extraction/prompts.ts
# (shortened for single-query testing — no cache needed since we're not batching)
EXTRACT_SYSTEM = """You extract restaurant menu items from raw page text.

Return ONLY a JSON object with shape:
{
  "restaurantType": "pizza|bar_grill|fine_dining|cafe|fast_casual|fast_food|breakfast|mexican|asian|seafood|other",
  "items": [
    { "name": str, "price": number|null, "category": str, "group": str, "description": str|null }
  ]
}

Rules:
- Category is one of: Food, Drink, Alcohol, Dessert
- Group is like "Pizzas", "Burgers", "Salads", "Appetizers", etc.
- Skip nav/header/footer/button text — only real menu items with names
- If the page has no menu items, return {"restaurantType":"other","items":[]}
- No markdown, no explanation, just the JSON."""


def fetch(url):
    """Full fetch: ldjson → curl → (curl < 1500 → playwright) → pick longest."""
    ldjson = extract_ldjson_full_menu(url)
    if ldjson:
        print(f"  ld+json: {len(ldjson)} chars")
    raw_curl = fetch_page_text_curl_cffi(url)
    raw_pw = None
    if not raw_curl or len(raw_curl) < 1500:
        raw_pw = fetch_page_text_playwright(url)

    cands = [(r, label) for r, label in
             [(ldjson, "ld+json"), (raw_curl, "curl_cffi"), (raw_pw, "playwright")]
             if r]
    if not cands:
        return None, None
    best_text, best_label = max(cands, key=lambda x: len(x[0]))

    # Menu-index link follow-through
    subs = _extract_menu_index_links(url, best_text)
    if subs:
        print(f"  menu-index: {len(subs)} sub-link(s)")
        pieces = [best_text]
        for sub in subs[:3]:
            sub_text = fetch_page_text_curl_cffi(sub) or fetch_page_text_playwright(sub)
            if sub_text and len(sub_text) > 200:
                pieces.append(f"\n\n=== SUB-MENU: {sub} ===\n{sub_text}")
                print(f"    + {len(sub_text)} from {sub}")
        best_text = "\n".join(pieces)
        best_label = f"{best_label}+sub-links"

    return best_text, best_label


def extract_ai(raw_text, url):
    """Direct Haiku call — no batch, no cache."""
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=8192,
        system=EXTRACT_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"URL: {url}\n\nPage text:\n{raw_text[:40000]}",
        }],
    )
    text = resp.content[0].text.strip()
    # Strip ```json fences if present
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError as e:
        print(f"  JSON parse error: {e}")
        print(f"  Raw: {text[:500]}")
        return None


def test_url(url):
    print(f"\n=== {url} ===")
    best, source = fetch(url)
    if not best:
        print("  NO TEXT FETCHED")
        return
    print(f"  source={source} len={len(best)}")
    print(f"  preview: {best[:200]!r}")
    result = extract_ai(best, url)
    if result is None:
        print("  EXTRACTION FAILED")
        return
    items = result.get("items", [])
    rtype = result.get("restaurantType", "?")
    print(f"  → restaurantType={rtype}, {len(items)} items")
    for i in items[:5]:
        price = i.get("price")
        price_s = f"${price}" if price else "—"
        print(f"    • {i.get('name','?')} [{i.get('group','?')}] {price_s}")
    if len(items) > 5:
        print(f"    ... +{len(items)-5} more")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?")
    ap.add_argument("--row", help="batch_queue row id")
    ap.add_argument("--urls-file")
    args = ap.parse_args()

    urls = []
    if args.url:
        urls = [args.url]
    elif args.row:
        base = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        req = urllib.request.Request(
            f"{base}/rest/v1/batch_queue?id=eq.{args.row}&select=menu_url",
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Accept-Profile": "demo_builder"})
        with urllib.request.urlopen(req) as resp:
            rows = json.load(resp)
        urls = [rows[0]["menu_url"]] if rows else []
    elif args.urls_file:
        urls = [l.strip() for l in Path(args.urls_file).read_text().splitlines()
                if l.strip() and not l.startswith("#")]

    if not urls:
        ap.print_help()
        sys.exit(1)

    for u in urls:
        try:
            test_url(u)
        except Exception as e:
            print(f"  ERROR: {e}")


if __name__ == "__main__":
    main()
