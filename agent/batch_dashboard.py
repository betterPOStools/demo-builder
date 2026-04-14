#!/usr/bin/env python3
"""
Live batch queue dashboard.
Polls Supabase every 5s and redraws in-place.

Usage:
    python3 agent/batch_dashboard.py
"""

import os
import sys
import time
import concurrent.futures
from collections import deque
from datetime import datetime

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
LOG_PATH = os.path.expanduser("~/Library/Logs/demo-builder-agent.log")
POLL_INTERVAL = 5
LOG_LINES = 18

# ── ANSI ────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BLUE   = "\033[94m"
DIM    = "\033[2m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def clr():
    sys.stdout.write("\033[2J\033[H")

# ── Data fetching ────────────────────────────────────────────────
STATUSES = ["queued", "processing", "done", "failed", "needs_pdf"]

def _fetch_count(status: str) -> tuple[str, int]:
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/batch_queue",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Accept-Profile": "demo_builder",
            "Prefer": "count=exact",
        },
        params={"select": "status", "status": f"eq.{status}", "limit": 1},
        timeout=10,
    )
    cr = r.headers.get("content-range", "0-0/0")
    return status, int(cr.split("/")[-1])

def get_counts() -> dict[str, int]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        futures = [ex.submit(_fetch_count, s) for s in STATUSES]
        return {s: n for s, n in (f.result() for f in futures)}

# ── Log tail ────────────────────────────────────────────────────
def tail_log(n: int) -> list[str]:
    try:
        with open(LOG_PATH, "rb") as f:
            f.seek(0, 2)
            buf = b""
            pos = f.tell()
            lines_found = 0
            while pos > 0 and lines_found < n + 1:
                chunk = min(4096, pos)
                pos -= chunk
                f.seek(pos)
                buf = f.read(chunk) + buf
                lines_found = buf.count(b"\n")
            return buf.decode("utf-8", errors="replace").splitlines()[-n:]
    except Exception:
        return []

# ── Rendering ────────────────────────────────────────────────────
def progress_bar(done: int, total: int, width: int = 50) -> str:
    if total == 0:
        return DIM + "░" * width + RESET
    filled = int(done / total * width)
    return GREEN + "█" * filled + DIM + "░" * (width - filled) + RESET

def fmt_eta(remaining: int, rate_hr: float) -> str:
    if rate_hr <= 0:
        return "—"
    hrs = remaining / rate_hr
    if hrs < 1:
        return f"{int(hrs * 60)}m"
    if hrs < 48:
        return f"{hrs:.1f}h"
    return f"{hrs / 24:.1f}d"

def colorize(line: str) -> str:
    line = line.rstrip()
    if any(x in line for x in ("[RETRY] Done", "[SNAP] Saved", "[GEN] Done")):
        return GREEN + line + RESET
    if "Failed" in line or "Error" in line or "error" in line:
        return RED + line + RESET
    if "[GEN] Job" in line:
        return BOLD + line + RESET
    if any(x in line for x in ("[DISC]", "[AI]", "[LD]")):
        return CYAN + line + RESET
    if any(x in line for x in ("[CF]", "[PW]", "[RETRY]")):
        return YELLOW + line + RESET
    if "[GEN] Failed" in line:
        return RED + line + RESET
    return DIM + line + RESET

def draw(counts: dict, history: deque, log_lines: list, width: int):
    done       = counts.get("done", 0)
    failed     = counts.get("failed", 0)
    queued     = counts.get("queued", 0)
    pdf        = counts.get("needs_pdf", 0)
    processing = counts.get("processing", 0)
    total      = sum(counts.values())
    terminal   = done + failed + pdf  # jobs that won't change

    # Rate from history (jobs completed over session)
    rate_hr = 0.0
    if len(history) >= 2:
        t0, d0 = history[0]
        t1, d1 = history[-1]
        elapsed = (t1 - t0) / 3600
        if elapsed > 0:
            rate_hr = (d1 - d0) / elapsed

    now   = datetime.now().strftime("%H:%M:%S")
    bar_w = max(20, width - 22)
    bar   = progress_bar(terminal, total, bar_w)
    pct   = f"{terminal / total * 100:.1f}%" if total else "0%"
    sep   = DIM + "  " + "─" * (width - 4) + RESET

    clr()
    print(f"  {BOLD}DEMO BUILDER BATCH{RESET}{DIM}  ·  {now}{RESET}")
    print(sep)
    print()
    print(f"  {bar}  {BOLD}{pct}{RESET}")
    print(f"  {DIM}{terminal:,} of {total:,} processed  ·  {queued + processing:,} remaining{RESET}")
    print()

    # Stats grid
    g_done  = f"{GREEN}✓ done      {done:>5}{RESET}"
    g_fail  = f"{RED}✗ failed    {failed:>5}{RESET}"
    g_q     = f"{BLUE}◷ queued  {queued:>7}{RESET}"
    g_act   = f"{YELLOW}⚙ active    {processing:>5}{RESET}"
    g_pdf   = f"{DIM}  pdf         {pdf:>5}{RESET}"
    print(f"  {g_done}    {g_fail}")
    print(f"  {g_q}    {g_act}")
    print(f"  {g_pdf}")
    print()

    if rate_hr > 0:
        eta = fmt_eta(queued + processing, rate_hr)
        print(f"  {DIM}Rate: {rate_hr:.1f}/hr  ·  ETA: {eta}{RESET}")
    else:
        print(f"  {DIM}Rate: warming up…{RESET}")

    print()
    print(sep)
    print(f"  {BOLD}RECENT ACTIVITY{RESET}")
    print()
    for line in log_lines:
        truncated = line[:width - 4]
        print("  " + colorize(truncated))

    sys.stdout.flush()


def main():
    history: deque = deque(maxlen=720)  # ~1hr at 5s intervals

    print("  Loading…")
    while True:
        try:
            width = os.get_terminal_size().columns
        except Exception:
            width = 100

        try:
            counts = get_counts()
            history.append((time.time(), counts.get("done", 0)))
            log_lines = tail_log(LOG_LINES)
            draw(counts, history, log_lines, width)
        except KeyboardInterrupt:
            clr()
            print("\n  Dashboard closed.\n")
            sys.exit(0)
        except Exception as e:
            print(f"\n  [dashboard] poll error: {e}\n")

        try:
            time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            clr()
            print("\n  Dashboard closed.\n")
            sys.exit(0)


if __name__ == "__main__":
    main()
