# Demo-Builder Session Failure Taxonomy
Generated: 2026-04-30

## Data Source Clarification

The "1605 sessions" figure in HANDOFF.md refers to `batch_queue` rows (the menu extraction
batch pipeline), **not** the `sessions` deploy table. These are distinct tables with distinct
failure modes. This taxonomy covers both.

---

## Part A — Batch Pipeline (`batch_queue`) Failures

### Summary
| Metric | Count |
|--------|-------|
| Total `batch_queue` rows | 1,598 |
| `done` (extraction succeeded) | 495 |
| `failed` | 1,072 |
| `pool_image_menu` (waiting) | 17 |
| `pool_discover` (waiting) | 11 |
| `discovering` (in-flight) | 2 |
| `pool_pdf` (waiting) | 1 |

---

### Category 1: Zero Items Extracted — 368 occurrences (34.3%)
**Retryable:** Partially — requires prompt/technique improvements, not a transient error  
**Root cause:** AI extraction ran successfully against raw page text but returned 0 menu items.
The page text existed (discovery succeeded, fetch succeeded) but the model could not identify
priced menu items from the content. Common causes: pages with embedded images-only menus,
SSR skeletons that render content-free HTML, or menus structured in ways the extraction
prompt doesn't handle (e.g. embedded PDFs referenced inline, nested JS data blobs).  
**Fix needed:** Improved extraction prompts (few-shot examples of sparse/unusual menu layouts),
or fallback to image-based extraction for pages that pass content gate but still return 0 items.  
**Example error:** `no items`

---

### Category 2: Discovery — No Menu URL Found — 336 occurrences (31.3%)
**Retryable:** Partially — discovery prompt improvements could recover some; many are genuinely
menu-URL-less (catering-only, phone-order-only, or franchise sites with no per-location menu)  
**Root cause:** The AI discovery stage ran but returned no candidate menu URL. Either the
homepage has no menu link at all, the link is behind a login/JS wall, or the discovery prompt
failed to identify an unconventional menu link pattern.  
**Fix needed:** Enhanced discovery prompt with more URL pattern coverage (DoorDash, Grubhub,
Slice, etc.), plus a mechanical regex fallback for common third-party ordering domains before
invoking AI.  
**Example error:** `no url returned`

---

### Category 3: Batch Canceled — 90 occurrences (8.4%)
**Retryable:** YES — these are clean retries with no code change needed  
**Root cause:** The Anthropic batch that contained these rows was explicitly canceled (via
API or batch-governor denial), usually during agent restarts, crash-loops, or the 2026-04-15
spend incident. Preflight verdict for 87/90 is `ok`, meaning the rows were fully preflighted
and ready to process — they were interrupted mid-batch, not rejected for content reasons.  
**Fix needed:** None (code is correct). Requeue to `queued` status and re-run batch pipeline.  
**Example error:** `batch canceled`

---

### Category 4: Batch Errored — 69 occurrences (6.4%)
**Retryable:** YES — but investigate root cause first  
**Root cause:** The Anthropic batch job itself returned an error status (not a canceled status).
All 69 rows have `content_gate_verdict = not_evaluated`, meaning they entered a batch before
the preflight stage completed. This is consistent with the batch pipeline running rows that
hadn't been fully classified yet (race condition during pipeline restart or wave submission
before preflight was written back). 65 are HTML, 4 are PDF.  
**Fix needed:** Add a guard in `batch_pipeline.py` to verify `preflight_run_at IS NOT NULL`
before submitting rows to a batch wave. Then requeue to `queued`.  
**Example error:** `batch errored`

---

### Category 5: Network / Fetch Failed — 78 occurrences (7.3%)
**Retryable:** YES — transient network errors  
**Root cause:** `_fetch_homepage_html()` or `advance_stage_extract()` could not retrieve the
page. Causes include: temporary DNS failures, connection timeouts on slow restaurant websites,
or the agent running while on a network with restricted egress. Not a content problem.  
**Fix needed:** None (code is correct). Requeue to `queued` and retry. Consider adding
retry-with-backoff inside the fetch helper for transient errors.  
**Example error:** `Could not fetch menu page text`

---

### Category 6: Content Gate — No Price Signals — 55 occurrences (5.1%)
**Retryable:** No — these pages have no price information  
**Root cause:** The content gate (`content_gate_verdict = no_price`) determined the page text
had no price signals (dollar signs, numeric price patterns) on a long page. These are real
restaurants but their websites don't expose a priced menu publicly (catering inquiries only,
placeholder sites, etc.). 3 additional rows in this category were originally `batch canceled`
but had `no_price` preflight verdicts.  
**Fix needed:** None — correct behavior. Could add a `skip_no_price` requeue path for manual
human review if the restaurant is high-value.  
**Example error:** `skipped: no_price_signals_on_long_page`

---

### Category 7: Cloudflare / Homepage Unreachable — 51 occurrences (4.8%)
**Retryable:** Partially — some may resolve over time; most require a different fetch strategy  
**Root cause:** Restaurant homepage returned a Cloudflare challenge page, 403, or 429, blocking
the scraper. Common with larger chain websites and well-protected ordering portals.  
**Fix needed:** For high-value targets, add a Playwright-based fallback fetch with real browser
headers and cookie handling. For bulk retry, a residential proxy would bypass most CF blocks.  
**Example error:** `Homepage unreachable (CF or network)`

---

### Category 8: PDF Batch Errored — 8 occurrences (0.7%)
**Retryable:** YES — can re-submit the PDF document batch  
**Root cause:** The Anthropic Sonnet batch processing a PDF document block errored (not canceled).
Likely scanned/image-only PDFs that the vision model couldn't parse, or batch API transient
failures for very large documents.  
**Fix needed:** Requeue to `needs_pdf`. If persistent, add image-menu fallback for PDFs that
produce batch errors.  
**Example error:** `PDF batch errored`

---

### Category 9: Image-Menu Batch Errored — 9 occurrences (0.8%)
**Retryable:** YES — re-submit to image extraction batch  
**Root cause:** The image-menu extraction batch (vision model analyzing menu photos) errored.
All 9 are HTML-class URLs where the discovery found image URLs instead of text menus. The
vision batch job itself failed rather than returning 0 items.  
**Fix needed:** Requeue to `needs_image_menu` (or equivalent status) and re-run.  
**Example error:** `image-menu batch errored`

---

### Category 10: Malformed JSON Response — 8 occurrences (0.7%)
**Retryable:** YES — retry will likely succeed (transient model variance)  
**Root cause:** AI returned a response that wasn't valid JSON (model hallucinated prose or
code-fenced its JSON). The `not JSON` error was already handled in the 2026-04-16 requeue
session for 4 rows; these 8 appear to be new occurrences from subsequent runs.  
**Fix needed:** None (extraction response parser already validates JSON). Requeue to `queued`.  
**Example error:** `not JSON`

---

### Category 11: JS SPA / Nav Chrome Only — 1 occurrence (0.1%)
**Retryable:** No — requires Playwright wait-for-selector improvement  
**Root cause:** Page returned content shorter than 500 chars, classified as navigation chrome
only (no menu content). This is the "JS SPA" problem noted in prior analysis — ordering
portals (Olo, DoorDash, etc.) require JS execution to render menu items.  
**Fix needed:** Playwright `wait_for_selector` on menu-specific elements in the SPA fetch path.  
**Example error:** `skipped: too_sparse (<500 chars — nav chrome only)`

---

## Part B — Deploy Pipeline (`sessions`) Failures

### Summary
| Metric | Count |
|--------|-------|
| Total `sessions` rows | 1,253 |
| `done` | 13 |
| `idle` (assembled, not yet queued for deploy) | 1,238 |
| `executing` (in-flight) | 1 |
| `failed` | 1 |

### Deploy Failure — 1 occurrence
**Retryable:** YES — once tablet is online/reachable  
**Root cause:** MariaDB connection timeout to the demo tablet (`100.112.68.19:3306`). The
tablet was not reachable at the time the deploy agent ran (powered off, off-network, or
Tailscale disconnected).  
**Fix needed:** None (code is correct). Ensure tablet is reachable, requeue session to `queued`.  
**Error:** `2003: Can't connect to MySQL server on '100.112.68.19:3306' (timed out)`

---

## Recommended Actions Before Re-enabling Agent

### Batch Pipeline (fix extraction failures first)

1. **Requeue 90 batch-canceled rows** — No code change needed. These have `verdict=ok`
   and were interrupted mid-batch. Highest ROI: run a targeted SQL UPDATE to set
   `status='queued'` for `error='batch canceled'` rows.

2. **Requeue 78 network-fetch-failed rows** — Transient failures. Safe to retry as-is.

3. **Requeue 8 malformed-JSON rows** — Low count, safe to retry.

4. **Requeue 8 PDF-errored + 9 image-menu-errored rows** — Re-submit to their
   respective batch stages.

5. **Fix batch-errored guard (69 rows)** — Add `preflight_run_at IS NOT NULL` check in
   `batch_pipeline.py` before wave submission. Then requeue the 69 rows to `queued`.

6. **Discovery improvement (336 rows)** — Longer-term: improve discovery prompt with
   more third-party ordering domain patterns, add mechanical regex fallback. Do NOT
   requeue without a prompt fix — they'll fail again.

7. **Zero-items improvement (368 rows)** — Longer-term: improved extraction prompts or
   image-menu fallback. Do NOT requeue without a technique improvement.

8. **Cloudflare / blocked (51 rows)** — Consider Playwright-based fetch as fallback for
   high-value restaurants. Low priority for bulk retry.

### Deploy Pipeline

9. **Single deploy failure** — Verify tablet connectivity before re-enabling deploy agent.
   Requeue the 1 failed session manually.

---

## Retryable vs Needs-Fix Summary

| Category | Count | Retryable As-Is |
|----------|-------|-----------------|
| Batch canceled | 90 | YES |
| Network fetch failed | 78 | YES |
| Batch errored (preflight race) | 69 | After guard fix |
| Malformed JSON | 8 | YES |
| PDF batch errored | 8 | YES |
| Image-menu batch errored | 9 | YES |
| **Subtotal retryable** | **262** | |
| Zero items extracted | 368 | No — needs technique fix |
| Discovery no URL | 336 | No — needs prompt fix |
| Cloudflare blocked | 51 | Partial — needs Playwright |
| Content gate (no price) | 55 | No — correct rejection |
| JS SPA nav chrome | 1 | No — needs PW wait_for_selector |
| Human review flagged | 1 | Manual |
| **Subtotal needs fix** | **812** | |
| **Deploy: tablet timeout** | **1** | YES (tablet connectivity) |
