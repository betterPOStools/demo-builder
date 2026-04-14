"""
Cross-validation: rank prospects that have BOTH Outscraper fields and raw_text/HTML,
once with HTML included and once with HTML stripped. Measure agreement.

Tests whether the Outscraper-only path produces verdicts consistent with the richer
HTML-inclusive path. If tier-level agreement is high (>80%), we can rank the whole
corpus with Outscraper-only as the baseline and only fall back to HTML when available.
"""

import argparse
import copy
import json
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import anthropic
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")
sys.path.insert(0, str(Path(__file__).parent))
from pt_rank_prototype import RUBRIC_SYSTEM, MODEL
from pt_rank_unified import build_user_message
from scrape_loader import load_prospects

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def rank(p):
    msg = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        temperature=0,
        system=[{"type": "text", "text": RUBRIC_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": build_user_message(p)}],
    )
    text = msg.content[0].text
    try:
        s = text.index("{")
        e = text.rindex("}") + 1
        return json.loads(text[s:e]), msg.usage
    except Exception as err:
        return {"_parse_error": str(err), "_raw": text[:300]}, msg.usage


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=15)
    args = ap.parse_args()

    prospects = load_prospects(enrich=True)
    both = [p for p in prospects if p.get("raw_text") or p.get("homepage_html")]
    print(f"Prospects with HTML: {len(both)}")
    both = both[: args.limit]
    print(f"Cross-checking {len(both)} prospects\n")

    tier_matches = 0
    score_deltas = []
    flips = []

    for p in both:
        p_html = p
        p_meta = copy.deepcopy(p)
        p_meta.pop("raw_text", None)
        p_meta.pop("homepage_html", None)

        v_html, u_html = rank(p_html)
        v_meta, u_meta = rank(p_meta)

        if "_parse_error" in v_html or "_parse_error" in v_meta:
            print(f"[!] {p['name']} — parse error")
            continue

        t_html, s_html = v_html.get("tier"), v_html.get("score", 0)
        t_meta, s_meta = v_meta.get("tier"), v_meta.get("score", 0)
        matched = t_html == t_meta
        tier_matches += int(matched)
        delta = s_meta - s_html
        score_deltas.append(delta)

        mark = "✓" if matched else "✗"
        line = f"{mark} {p['name'][:40]:40}  HTML={t_html}/{s_html}  META={t_meta}/{s_meta}  Δ={delta:+d}"
        print(line)
        if not matched:
            flips.append((p["name"], t_html, t_meta, v_meta.get("reasoning", "")[:200]))

    n = len(both)
    print(f"\n--- agreement ---")
    print(f"tier match: {tier_matches}/{n} ({100*tier_matches//n if n else 0}%)")
    if score_deltas:
        avg = sum(score_deltas) / len(score_deltas)
        absavg = sum(abs(d) for d in score_deltas) / len(score_deltas)
        print(f"score Δ: mean {avg:+.1f}, mean|Δ| {absavg:.1f}, range [{min(score_deltas)}, {max(score_deltas)}]")
    if flips:
        print(f"\ntier flips ({len(flips)}):")
        for name, th, tm, reas in flips:
            print(f"  {name}: {th} → {tm}")
            print(f"    META reasoning: {reas}")


if __name__ == "__main__":
    main()
