#!/usr/bin/env python3
"""Categorize failed batch_queue rows without re-running AI.

Core principle (2026-04-15 decision): "all failures get analysis — don't get
rerun through AI". This script lets you inspect WHY rows failed so you can
decide whether to fix the root cause (upstream URL pruning, code change, etc.)
or accept the failure. It does NOT call Anthropic.

Usage:
  python3 agent/analyze_failures.py                 # summary report
  python3 agent/analyze_failures.py --csv out.csv   # dump all failures
  python3 agent/analyze_failures.py --sample 20     # show 20 urls per category
"""
from __future__ import annotations

import os
import re
import json
import csv
import argparse
import urllib.request
from pathlib import Path
from collections import Counter, defaultdict
from urllib.parse import urlparse

env_path = Path(__file__).parent.parent / ".env.local"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

BASE = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# Non-restaurant / unscrapable domain patterns — these are "permanent fails"
# that should be pruned upstream before they ever enter the pipeline.
UNSCRAPABLE_DOMAINS = {
    "facebook.com": "facebook",
    "m.facebook.com": "facebook",
    "instagram.com": "instagram",
    "twitter.com": "social",
    "x.com": "social",
    "tiktok.com": "social",
    "youtube.com": "social",
    "yelp.com": "directory",
    "tripadvisor.com": "directory",
    "foursquare.com": "directory",
    "google.com": "search",
    "maps.google.com": "search",
    "amzn.to": "amazon",
    "amazon.com": "amazon",
}

# Hotel / accommodation chains — wrong entity type (prospect is a hotel, not a restaurant)
HOTEL_PATTERN = re.compile(
    r"choicehotels|marriott|hilton|hyatt|hotels?\.com|motel|resort|econolodge|"
    r"bestwestern|holidayinn|wyndham|comfort.?inn|suites?\.com|villas?\.com",
    re.IGNORECASE,
)

# Food-media / news / non-restaurant but food-related
MEDIA_PATTERN = re.compile(
    r"foodandwine\.com|foodnetwork|usatoday|foodsafety\.gov|seriouseats\.com|"
    r"eater\.com|thrillist\.com|foodnavigator|restaurantbusiness",
    re.IGNORECASE,
)


def classify_url(url: str) -> str:
    if not url:
        return "no_url"
    try:
        host = urlparse(url).netloc.lower().replace("www.", "")
    except Exception:
        return "malformed_url"
    for domain, label in UNSCRAPABLE_DOMAINS.items():
        if host.endswith(domain):
            return f"dead_url:{label}"
    if HOTEL_PATTERN.search(url):
        return "dead_url:hotel"
    if MEDIA_PATTERN.search(url):
        return "dead_url:food_media"
    # Generic /food-menu path often = discovery latched onto wrong entity
    if re.search(r"/food-menu/?$", url):
        return "suspect:generic_food_menu_path"
    return "real_url"


def classify_error(error: str) -> str:
    e = (error or "").strip().lower()
    if not e:
        return "no_error_msg"
    if "no items" in e:
        return "ai_extracted_0_items"
    if "no url returned" in e:
        return "discovery_no_url"
    if "skipped:" in e:
        return "skipped_quality_gate"
    if "review:" in e:
        return "needs_human_review"
    if "could not fetch" in e:
        return "fetch_failed_all_methods"
    if "homepage unreachable" in e or "cloudflare" in e:
        return "homepage_unreachable"
    if "batch errored" in e or "batch expired" in e:
        return "anthropic_batch_error"
    if "not json" in e or "json" in e:
        return "ai_malformed_response"
    if "pdf batch" in e:
        return "pdf_batch_error"
    if "image-menu" in e:
        return "image_menu_error"
    return "other"


def fetch_all_failures():
    h = {
        "apikey": KEY, "Authorization": f"Bearer {KEY}",
        "Accept-Profile": "demo_builder",
    }
    rows = []
    offset = 0
    while True:
        url = (f"{BASE}/rest/v1/batch_queue?select=id,name,menu_url,error,pt_record_id"
               f"&status=eq.failed&limit=500&offset={offset}")
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req) as r:
            page = json.load(r)
        if not page:
            break
        rows.extend(page)
        if len(page) < 500:
            break
        offset += 500
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="Write all failures with classification to this CSV")
    ap.add_argument("--sample", type=int, default=5, help="URLs to show per category (default 5)")
    args = ap.parse_args()

    rows = fetch_all_failures()
    print(f"Total failed rows: {len(rows)}\n")

    error_counts = Counter()
    url_counts = Counter()
    cross = defaultdict(list)  # (error_cat, url_cat) → [row]
    by_url_cat = defaultdict(list)

    for row in rows:
        err_cat = classify_error(row.get("error") or "")
        url_cat = classify_url(row.get("menu_url") or "")
        error_counts[err_cat] += 1
        url_counts[url_cat] += 1
        cross[(err_cat, url_cat)].append(row)
        by_url_cat[url_cat].append(row)

    print("=== BY ERROR TYPE ===")
    for cat, n in error_counts.most_common():
        pct = 100 * n / len(rows)
        print(f"  {n:5}  {pct:5.1f}%  {cat}")

    print("\n=== BY URL TYPE ===")
    for cat, n in url_counts.most_common():
        pct = 100 * n / len(rows)
        print(f"  {n:5}  {pct:5.1f}%  {cat}")

    # Recoverable buckets — failures that COULD succeed with a code change
    recoverable = [r for r in rows
                   if classify_url(r.get("menu_url") or "") == "real_url"
                   and classify_error(r.get("error") or "") in
                   ("ai_extracted_0_items", "skipped_quality_gate", "ai_malformed_response",
                    "anthropic_batch_error", "pdf_batch_error", "image_menu_error",
                    "homepage_unreachable", "fetch_failed_all_methods")]
    unrecoverable = [r for r in rows
                     if classify_url(r.get("menu_url") or "").startswith("dead_url")
                     or classify_url(r.get("menu_url") or "") == "no_url"]

    print(f"\n=== RECOVERABLE (real URL, fixable-in-code error) ===")
    print(f"  {len(recoverable)} rows — these are candidates for retry AFTER a code improvement")

    print(f"\n=== UNRECOVERABLE (dead URL or no URL) ===")
    print(f"  {len(unrecoverable)} rows — upstream URL pruning before the pipeline would save cost")

    print(f"\n=== SAMPLE URLS PER URL CATEGORY (first {args.sample}) ===")
    for cat in sorted(url_counts.keys()):
        print(f"\n  [{cat}]  {url_counts[cat]} total")
        for row in by_url_cat[cat][:args.sample]:
            name = (row.get("name") or "")[:40]
            url = (row.get("menu_url") or "")[:80]
            err = (row.get("error") or "")[:40]
            print(f"    {name:40}  {err:40}  {url}")

    if args.csv:
        with open(args.csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "name", "menu_url", "error", "error_category", "url_category", "recoverable"])
            for row in rows:
                err_cat = classify_error(row.get("error") or "")
                url_cat = classify_url(row.get("menu_url") or "")
                is_rec = url_cat == "real_url" and err_cat in (
                    "ai_extracted_0_items", "skipped_quality_gate", "ai_malformed_response",
                    "anthropic_batch_error", "pdf_batch_error", "image_menu_error",
                    "homepage_unreachable", "fetch_failed_all_methods")
                w.writerow([row["id"], row.get("name",""), row.get("menu_url",""),
                            row.get("error",""), err_cat, url_cat, "yes" if is_rec else "no"])
        print(f"\nCSV: wrote {len(rows)} rows to {args.csv}")


if __name__ == "__main__":
    main()
