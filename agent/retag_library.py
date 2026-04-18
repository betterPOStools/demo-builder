#!/usr/bin/env python3
"""
retag_library.py — Enrich concept_tags on existing demo_builder.image_library rows.

Two passes, hybrid:
  Pass 1 (deterministic, free): re-tokenize item_name with stricter stopwords,
    fix the unicode stripping bug ("jalape" → "jalapeno"), and infer
    `food_category` from item_name keywords. Writes to concept_tags +
    food_category.
  Pass 2 (Haiku vision, ~$0.004/image): for rows still under MIN_TAGS after
    pass 1, fetch the image bytes via the bucket's public URL and ask Haiku
    4.5 for 6-10 visual-concept tags. Merges into concept_tags.

Usage:
  python3 agent/retag_library.py                    # dry-run pass 1 only
  python3 agent/retag_library.py --pass 1 --commit  # apply pass 1
  python3 agent/retag_library.py --pass 2 --commit  # apply pass 2 (Haiku, $)
  python3 agent/retag_library.py --pass both --commit
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.parse
from typing import Any

import requests

try:
    import anthropic
except ImportError:
    anthropic = None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def load_env():
    path = os.path.join(SCRIPT_DIR, ".env")
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
BUCKET = "image-library"
MIN_TAGS = 6

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
    "Accept-Profile": "demo_builder",
    "Content-Profile": "demo_builder",
}

NOISE = {
    "the", "and", "with", "our", "house", "fresh", "classic", "favorite",
    "original", "special", "famous", "served", "topped", "style", "sauce",
    "plate", "order", "combo", "basket", "platter",
    "lexi", "lexis", "mama", "mamas", "papa", "papas", "chef", "chefs",
}

UNICODE_FIX = {
    "jalape": "jalapeno",
    "jalapeno": "jalapeno",
    "creme": "cream",
    "frites": "fries",
    "cafe": "coffee",
}

CATEGORY_KEYWORDS: list[tuple[re.Pattern, str, list[str]]] = [
    (re.compile(r"\b(burger|cheeseburger|hamburger)\b"), "entree", ["burger", "beef", "sandwich"]),
    (re.compile(r"\b(pizza|pie|slice)\b"), "entree", ["pizza", "italian"]),
    (re.compile(r"\b(wings?|drumstick)\b"), "appetizer", ["chicken", "wings"]),
    (re.compile(r"\b(shrimp|prawn|lobster|crab|oyster|clam|mussel|scallop|mahi|tuna|salmon|cod|halibut|fish)\b"), "entree", ["seafood"]),
    (re.compile(r"\b(taco|burrito|quesadilla|enchilada|nacho|fajita)\b"), "entree", ["mexican"]),
    (re.compile(r"\b(sushi|sashimi|ramen|udon|pho|dumpling|lo mein|pad thai)\b"), "entree", ["asian"]),
    (re.compile(r"\b(sandwich|wrap|hoagie|sub|panini|club)\b"), "entree", ["sandwich"]),
    (re.compile(r"\b(salad|caesar|greens|caprese)\b"), "salad", ["salad", "vegetable"]),
    (re.compile(r"\b(soup|chili|chowder|bisque|stew)\b"), "soup", ["soup"]),
    (re.compile(r"\b(fries|onion rings?|tots|chips|mozzarella|pickles?|poppers?)\b"), "side", ["side", "fried"]),
    (re.compile(r"\b(steak|ribeye|filet|sirloin|brisket|rib|chop)\b"), "entree", ["steak", "beef"]),
    (re.compile(r"\b(chicken|tender|nugget|popcorn)\b"), "entree", ["chicken"]),
    (re.compile(r"\b(pretzel|bread|biscuit|roll|bagel|toast)\b"), "appetizer", ["bread"]),
    (re.compile(r"\b(cake|pie|brownie|cookie|ice cream|sundae|dessert|pudding)\b"), "dessert", ["dessert", "sweet"]),
    (re.compile(r"\b(coffee|latte|espresso|cappuccino|mocha|americano)\b"), "drink", ["coffee"]),
    (re.compile(r"\b(beer|ale|lager|ipa|stout|pilsner)\b"), "drink", ["beer"]),
    (re.compile(r"\b(wine|chardonnay|merlot|cabernet|pinot|rose)\b"), "drink", ["wine"]),
    (re.compile(r"\b(cocktail|margarita|martini|mojito|daiquiri|bloody mary)\b"), "drink", ["cocktail"]),
    (re.compile(r"\b(juice|smoothie|soda|tea|lemonade)\b"), "drink", ["beverage"]),
    (re.compile(r"\b(egg|omelet|omelette|pancake|waffle|bacon|sausage)\b"), "breakfast", ["breakfast"]),
]

# ── Pass 1 ──────────────────────────────────────────────────────────────────

def normalize_tag(tag: str) -> str:
    t = tag.lower().strip()
    return UNICODE_FIX.get(t, t)

def retokenize(item_name: str) -> list[str]:
    text = item_name.lower()
    # Map common unicode first, then strip non-ascii
    text = text.replace("ñ", "n").replace("é", "e").replace("ó", "o")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    tokens = [t for t in text.split() if len(t) > 2 and t not in NOISE]
    return list(dict.fromkeys(normalize_tag(t) for t in tokens))

def infer_category(item_name: str) -> tuple[str | None, list[str]]:
    t = item_name.lower()
    for pat, cat, extra in CATEGORY_KEYWORDS:
        if pat.search(t):
            return cat, extra
    return None, []

def pass_one(row: dict[str, Any]) -> dict[str, Any] | None:
    """Returns patch dict if row needs update, else None."""
    item_name = row.get("item_name") or ""
    existing = [normalize_tag(t) for t in (row.get("concept_tags") or [])]
    existing_food_cat = row.get("food_category")

    new_tokens = retokenize(item_name) if item_name else []
    cat, extra = infer_category(item_name) if item_name else (None, [])

    merged = list(dict.fromkeys(existing + new_tokens + extra))
    # Drop pure-noise ("jalape" replaced by "jalapeno" etc.)
    merged = [t for t in merged if t and t not in NOISE]

    patch = {}
    if merged != existing:
        patch["concept_tags"] = merged
    if cat and not existing_food_cat:
        patch["food_category"] = cat
    return patch or None

# ── Pass 2 (Haiku vision) ───────────────────────────────────────────────────

HAIKU_SYSTEM = (
    "You are a food/drink/decor image tagger. Given an image, return a JSON "
    "array of 6-10 short lowercase concept tags a menu-image search would "
    "use. Include: what's shown (the food/drink/scene subject, ingredients, "
    "colors if striking), rendering style (photo/vector/illustration), "
    "and mood words (rustic, modern, playful). Return ONLY the JSON array."
)

def fetch_bytes(storage_path: str) -> bytes | None:
    path = urllib.parse.quote(storage_path, safe="/")
    url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{path}"
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        return r.content
    except Exception as e:
        print(f"  [FETCH] {storage_path}: {e}")
        return None

def haiku_tags(client, img_bytes: bytes, media_type: str, existing: list[str]) -> list[str]:
    """Call Haiku vision. Returns merged deduped tag list."""
    b64 = base64.standard_b64encode(img_bytes).decode()
    try:
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            temperature=0,
            system=[{"type": "text", "text": HAIKU_SYSTEM,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image",
                     "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text", "text": "Tag this image."},
                ],
            }],
        )
        text = msg.content[0].text.strip()
        m = re.search(r"\[[^\]]*\]", text, re.DOTALL)
        if not m:
            return existing
        tags = json.loads(m.group(0))
        if not isinstance(tags, list):
            return existing
        new = [normalize_tag(str(t)) for t in tags if isinstance(t, str) and len(t) < 25]
        merged = list(dict.fromkeys(existing + new))
        return [t for t in merged if t and t not in NOISE]
    except Exception as e:
        print(f"  [HAIKU] {e}")
        return existing

EXT_MEDIA = {
    ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

def pass_two(row: dict[str, Any], client) -> dict[str, Any] | None:
    existing = [normalize_tag(t) for t in (row.get("concept_tags") or [])]
    if len(existing) >= MIN_TAGS:
        return None
    storage_path = row.get("storage_path") or ""
    ext = os.path.splitext(storage_path.lower())[1]
    media = EXT_MEDIA.get(ext)
    if not media:
        print(f"    [SKIP] unsupported format: {ext}")
        return None
    img = fetch_bytes(storage_path)
    if not img:
        return None
    new_tags = haiku_tags(client, img, media, existing)
    if new_tags != existing:
        return {"concept_tags": new_tags}
    return None

# ── Supabase I/O ────────────────────────────────────────────────────────────

def fetch_all_rows() -> list[dict[str, Any]]:
    url = f"{SUPABASE_URL}/rest/v1/image_library"
    params = {"select": "id,item_name,generated_for,storage_path,concept_tags,food_category,image_type",
              "order": "created_at.desc"}
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"},
                     params=params, timeout=15)
    r.raise_for_status()
    return r.json()

def apply_patch(row_id: str, patch: dict[str, Any]) -> bool:
    url = f"{SUPABASE_URL}/rest/v1/image_library"
    r = requests.patch(url, headers=HEADERS, params={"id": f"eq.{row_id}"},
                       json=patch, timeout=10)
    if r.status_code >= 300:
        print(f"  [PATCH] {row_id}: HTTP {r.status_code} {r.text}")
        return False
    return True

# ── Main ────────────────────────────────────────────────────────────────────

def diff_str(before: list[str], after: list[str]) -> str:
    added = [t for t in after if t not in before]
    removed = [t for t in before if t not in after]
    parts = []
    if added: parts.append(f"+{added}")
    if removed: parts.append(f"-{removed}")
    return " ".join(parts)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pass", dest="which", choices=["1", "2", "both"], default="1")
    ap.add_argument("--commit", action="store_true", help="Write changes (default: dry-run)")
    ap.add_argument("--limit", type=int, default=0, help="Limit rows processed (0 = all)")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_KEY must be set in agent/.env")
        sys.exit(2)

    rows = fetch_all_rows()
    if args.limit:
        rows = rows[:args.limit]
    print(f"Fetched {len(rows)} library rows. Mode: {'COMMIT' if args.commit else 'DRY-RUN'}")

    # Pass 1
    if args.which in ("1", "both"):
        print(f"\n── Pass 1 (deterministic) ──")
        p1_changed = 0
        for row in rows:
            patch = pass_one(row)
            if not patch:
                continue
            p1_changed += 1
            before = row.get("concept_tags") or []
            after = patch.get("concept_tags", before)
            extra = f"  food_category={patch['food_category']}" if "food_category" in patch else ""
            if p1_changed <= 20:
                print(f"  {row['item_name'] or row['storage_path']}: {diff_str(before, after)}{extra}")
            if args.commit:
                apply_patch(row["id"], patch)
        print(f"  {p1_changed}/{len(rows)} rows changed by pass 1.")

    # Pass 2
    if args.which in ("2", "both"):
        print(f"\n── Pass 2 (Haiku vision, rows with <{MIN_TAGS} tags) ──")
        if not anthropic or not ANTHROPIC_API_KEY:
            print("  ERROR: anthropic lib + ANTHROPIC_API_KEY required.")
            sys.exit(2)
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

        # Re-fetch if pass 1 committed, else reuse (dry-run merge is tricky; keep simple)
        if args.which == "both" and args.commit:
            rows = fetch_all_rows()
            if args.limit:
                rows = rows[:args.limit]

        targets = [r for r in rows if len(r.get("concept_tags") or []) < MIN_TAGS]
        print(f"  {len(targets)} rows eligible for vision pass.")
        p2_changed = 0
        for i, row in enumerate(targets):
            print(f"  [{i+1}/{len(targets)}] {row.get('item_name') or row['storage_path']}")
            patch = pass_two(row, client)
            if not patch:
                continue
            p2_changed += 1
            before = row.get("concept_tags") or []
            after = patch["concept_tags"]
            print(f"    {diff_str(before, after)}")
            if args.commit:
                apply_patch(row["id"], patch)
            time.sleep(0.25)
        print(f"  {p2_changed}/{len(targets)} rows changed by pass 2.")

    if not args.commit:
        print("\n(dry-run — re-run with --commit to apply)")

if __name__ == "__main__":
    main()
