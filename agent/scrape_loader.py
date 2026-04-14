"""
Unified scrape loader for PT ranking.

Loads 16 Outscraper JSON/XLSX exports from prospect-tracker/Scrapes/,
dedups by place_id, optionally left-joins raw_text + homepage_html from
demo_builder.batch_queue for prospects that went through the pipeline.

Usage:
    from scrape_loader import load_prospects
    prospects = load_prospects(enrich=True)
    # each prospect dict has Outscraper fields + optional raw_text / homepage_html
"""

import glob
import json
import os
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import openpyxl
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

SCRAPES_DIR = "/Users/nomad/Projects/betterpostools/prospect-tracker/Scrapes"

OUTSCRAPER_KEYS = [
    "name", "subtypes", "category", "phone", "website",
    "street", "city", "state", "postal_code",
    "company_name", "full_name", "first_name", "last_name", "title", "email",
    "rating", "reviews", "business_status",
    "working_hours_csv_compatible", "about", "description",
    "place_id", "google_id",
    "company_linkedin", "company_facebook", "company_instagram",
]


def _norm(v):
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


def _load_json_file(path):
    with open(path) as fh:
        data = json.load(fh)
    rows = data if isinstance(data, list) else data.get("data", [])
    if rows and isinstance(rows[0], list):
        rows = [r for sub in rows for r in sub]
    return rows


def _load_xlsx_file(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    it = ws.iter_rows(values_only=True)
    header = next(it)
    out = []
    for r in it:
        d = dict(zip(header, r))
        if d.get("name"):
            out.append(d)
    wb.close()
    return out


def load_raw_rows():
    rows = []
    for f in sorted(glob.glob(f"{SCRAPES_DIR}/*.json")):
        rows.extend(_load_json_file(f))
    for f in sorted(glob.glob(f"{SCRAPES_DIR}/*.xlsx")):
        rows.extend(_load_xlsx_file(f))
    return rows


def dedup_by_place_id(rows):
    seen = set()
    out = []
    for r in rows:
        pid = _norm(r.get("place_id"))
        if pid and pid in seen:
            continue
        if pid:
            seen.add(pid)
        out.append(r)
    return out


def _norm_name(s):
    if not s:
        return ""
    s = str(s).lower().strip()
    # strip location suffixes like "#3", "- columbia", "North Myrtle Beach"
    import re
    s = re.sub(r"\s*#\s*\d+\s*$", "", s)
    s = re.sub(r"\s*-\s*[^-]+$", "", s)
    s = re.sub(r"[^a-z0-9 ]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def annotate_location_counts(prospects):
    """Add 'sibling_locations' count + 'sibling_cities' sample based on normalized name."""
    from collections import defaultdict
    groups = defaultdict(list)
    for p in prospects:
        k = _norm_name(p.get("name"))
        if k:
            groups[k].append(p)
    for p in prospects:
        k = _norm_name(p.get("name"))
        siblings = groups.get(k, [])
        p["sibling_locations"] = len(siblings)
        if len(siblings) > 1:
            cities = [s.get("city") for s in siblings if s.get("city")]
            unique_cities = list(dict.fromkeys(cities))[:5]
            p["sibling_cities"] = ", ".join(unique_cities)
    return prospects


def slim(r):
    """Keep only ranker-relevant fields; drop None/empty."""
    out = {}
    for k in OUTSCRAPER_KEYS:
        v = _norm(r.get(k))
        if v is not None:
            out[k] = v
    return out


def _enrich_from_batch_queue(prospects):
    """Left-join raw_text + homepage_html from demo_builder.batch_queue by website match."""
    SUPABASE_URL = os.environ.get("SUPABASE_URL")
    SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("[enrich] SUPABASE_URL/SUPABASE_KEY not set — skipping batch_queue join")
        return prospects

    hdr = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept-Profile": "demo_builder",
    }
    offset = 0
    bq_by_name = {}
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/batch_queue",
            headers=hdr,
            params={
                "select": "id,name,menu_url,raw_text,homepage_html,status",
                "raw_text": "not.is.null",
                "limit": "1000",
                "offset": str(offset),
            },
            timeout=30,
        )
        r.raise_for_status()
        chunk = r.json()
        if not chunk:
            break
        for row in chunk:
            key = (row["name"] or "").strip().lower()
            if key and key not in bq_by_name:
                bq_by_name[key] = row
        if len(chunk) < 1000:
            break
        offset += 1000

    print(f"[enrich] batch_queue rows with raw_text: {len(bq_by_name)}")
    matched = 0
    for p in prospects:
        k = (p.get("name") or "").strip().lower()
        bq = bq_by_name.get(k)
        if bq:
            p["raw_text"] = bq.get("raw_text")
            p["homepage_html"] = bq.get("homepage_html")
            p["batch_queue_id"] = bq.get("id")
            p["menu_url"] = bq.get("menu_url") or p.get("website")
            matched += 1
    print(f"[enrich] matched by name: {matched}/{len(prospects)}")
    return prospects


def load_prospects(enrich=False):
    raw = load_raw_rows()
    uniq = dedup_by_place_id(raw)
    slimmed = [slim(r) for r in uniq]
    slimmed = annotate_location_counts(slimmed)
    if enrich:
        slimmed = _enrich_from_batch_queue(slimmed)
    return slimmed


if __name__ == "__main__":
    import sys
    enrich = "--enrich" in sys.argv
    ps = load_prospects(enrich=enrich)
    print(f"loaded: {len(ps)} prospects")
    with_html = sum(1 for p in ps if p.get("raw_text"))
    print(f"with raw_text: {with_html}")
    if ps:
        print("sample:", json.dumps(ps[0], indent=2, default=str)[:600])
