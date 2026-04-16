# deploy_agent.py boundary audit (Phase 1)

**Purpose:** classify every function and module-level constant as **SHARED**, **BATCH**, or **DEPLOY** so `pipeline_shared.py` extraction (Phase 2 / REFACTOR_PLAN PR2) lands clean.

**Source:** `agent/deploy_agent.py` (2764 lines, scanned 2026-04-16 PM).

**Legend:**
- **SHARED** → move to `pipeline_shared.py`. Both daemon and CLI import it.
- **BATCH** → stays in `deploy_agent.py` today; moves to `batch_pipeline.py` (or folds into `rebuild_batch.py`) in Phase 3/PR4. Gated off today by `DEPLOY_ONLY=1`.
- **DEPLOY** → stays in `deploy_agent.py` as the daemon's own code.

---

## SHARED (move to `pipeline_shared.py`)

### Config / bootstrap
| Symbol | Line | Why SHARED |
|---|---|---|
| `load_env()` | 52 | Both daemon and CLI need `.env` loaded before Supabase/API keys resolve. |
| `SUPABASE_URL` | 65 | Both hit the same Supabase. |
| `SUPABASE_KEY` | 66 | Same. |
| `HEADERS` | 95 | PostgREST headers (`Accept-Profile: demo_builder`); every Supabase call uses it. |

### Supabase REST helpers
| Symbol | Line | Why SHARED |
|---|---|---|
| `supabase_get(table, params)` | 170 | rebuild_batch.py already imports; both pipelines read from `batch_queue`/`sessions`. |
| `supabase_patch(table, match, data)` | 179 | Same. Every status transition goes through it. |

### HTTP / page-fetch helpers (stateless, no AI)
| Symbol | Line | Why SHARED |
|---|---|---|
| `fetch_page_text_curl_cffi(url)` | 319 | Used by batch stages AND by `test_extract.py` AND needed by preflight live-discover. |
| `fetch_page_text_playwright(url, timeout_ms)` | 589 | Same — JS-SPA fallback. |
| `_fetch_homepage_html(url, max_chars)` | 887 | Lightweight HTML fetcher; preflight live-discover + batch discover both need it. |

### Parse / classify (mechanical, no AI)
| Symbol | Line | Why SHARED |
|---|---|---|
| `_extract_ldjson_menu_text(html)` | 285 | Pure string parsing; PR1 preflight already relies on it indirectly. |
| `_extract_menu_index_links(base_url, raw_text)` | 460 | Mechanical link extraction from menu-index pages; preflight + batch both use. |
| `_detect_menu_images(url, max_imgs)` | 529 | Pure Playwright probe; preflight image-menu classification needs it. |
| `extract_ldjson_full_menu(menu_url)` | 790 | Full ld+json parse path; batch uses, test_extract uses. |
| `_ldjson_items_to_rows(merged_text)` | 907 | ld+json → row-dict converter. Mechanical. |

### Discovery (mechanical-first, AI-fallback — see feedback_batch_mechanical_first.md)
| Symbol | Line | Why SHARED |
|---|---|---|
| `discover_menu_url(homepage_url)` | 654 | **Critical for PR2 Task 4** — wiring this into `preflight_row` drops PR3's discover batch from ~1430 to ~200-400. |
| `discover_menu_url_ai(page_text, base_url)` | 374 | Private helper to `discover_menu_url`. Moves with it; keeps the mechanical-first façade intact. |

### Utilities
| Symbol | Line | Why SHARED |
|---|---|---|
| `_now_iso()` | 863 | ISO-8601 timestamp for `updated_at` / `last_polled_at`; any Supabase writer needs it. |
| `_ApiLimitHit` (exception class) | 853 | Raised from any Anthropic call site; `dryrun_staged.py` already catches it. |

---

## BATCH (gated off today; moves to batch CLI in Phase 3)

### AI client + prompts (batch-only)
| Symbol | Line | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | 79 | Only AI paths need it. |
| `_anthropic` (module-level client) | 105 | Instantiated once; only batch pipelines call it. |
| `_PROMPTS_TS_PATH` | 112 | Path to `lib/extraction/prompts.ts`. |
| `_load_stage_prompts()` | 116 | Loader. |
| `_STAGE_PROMPTS` | 139 | Dict; `check_cache.py` already imports it. |
| `BATCH_MODEL` | 93 | Haiku model ID for batch. |
| `PDF_BATCH_MODEL` | 1364 | Sonnet for PDFs. |
| `IMAGE_MENU_BATCH_MODEL` | 1553 | Sonnet for image menus. |
| `IMAGE_MENU_MAX_IMAGES` | 1554 | Cap. |

### Wave config (batch-only)
| Symbol | Line |
|---|---|
| `WAVE_MIN_SIZE` | 86 |
| `WAVE_MAX_SIZE` | 89 |
| `BATCH_BUDGET_USD` | 90 (dead per `feedback_batch_budget_guard_gap.md`) |
| `FORCE_WAVE_AFTER_SECONDS` | 91 |
| `BATCH_POLL_INTERVAL_SEC` | 92 |

### Parse / classify (batch-specific)
| Symbol | Line | Notes |
|---|---|---|
| `_classify_extract_skip(raw)` | 427 | Content quality gate for extract stage; rebuild_batch.py has its own looser replacement. |
| `_classify_dead_url(url)` | 975 | Legacy stricter dead-URL gate; rebuild_batch.py has its own richer replacement at line 127. |
| `_parse_ai_json(text)` | 867 | JSON parser hardened against Claude's occasional fences; AI-only. |
| `_wave_is_ready(rows)` | 945 | Wave-sizing logic; N<WAVE_MIN and age checks. |

### Snapshot helpers
| Symbol | Line | Notes |
|---|---|---|
| `get_snapshot_path(name, pt_record_id, allow_versioning)` | 189 | Called only from batch assemble (1337) + legacy generate-queue (2153). Zero deploy-side callers. |
| `save_snapshot(...)` | 212 | Same. |

### Stage advances (S1–S5 + PDF + image-menu)
| Symbol | Line |
|---|---|
| `advance_stage_discover()` | 991 |
| `advance_stage_extract()` | 1082 |
| `advance_stage_modifier()` | 1192 |
| `_extract_branding_mechanical(html)` | 1240 |
| `advance_stage_branding()` | 1265 |
| `advance_stage_assemble()` | 1299 |
| `advance_stage_pdf()` | 1366 |
| `advance_stage_image_menu()` | 1557 |

### Wave submit/poll internals (stage-agnostic)
| Symbol | Line |
|---|---|
| `_submit_pdf_wave()` | 1397 |
| `_poll_pdf_waves()` | 1481 |
| `_submit_image_menu_wave()` | 1588 |
| `_poll_image_menu_waves()` | 1684 |
| `_submit_wave(pool_status, submitted_status, batch_id_col, ...)` | 1752 |
| `_poll_waves(submitted_status, batch_id_col, result_col, next_status, ...)` | 1832 |
| `_poll_discover_waves()` | 1992 |

### Per-stage message builders + parsers
| Symbol | Line |
|---|---|
| `_build_discover_msg(row)` | 1907 |
| `_parse_discover(text)` | 1917 |
| `_build_extract_msg(row)` | 1927 |
| `_parse_extract(text)` | 1936 |
| `_build_modifier_msg(row)` | 1945 |
| `_parse_modifier(text)` | 1962 |
| `_build_branding_msg(row)` | 1971 |
| `_parse_branding(text)` | 1981 |

### Orchestrators
| Symbol | Line | Notes |
|---|---|---|
| `run_staged_pipeline()` | 2059 | `dryrun_staged.py` already imports. |
| `_handle_process_result(job, jid, result, label)` | 2137 | Private to legacy generate-queue. |
| `process_generate_queue()` | 2175 | Legacy per-job; marked for deletion in REFACTOR_PLAN PR4. |

---

## DEPLOY (stays in daemon)

### MariaDB deploy
| Symbol | Line | Notes |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | 67–71 | Only `execute_sql` uses these. |
| `execute_sql(sql, deploy_target)` | 2339 | Only caller is `process_queued` (line 2652). Batch pipeline's assemble goes through `/api/batch/ingest` HTTP, not this function. |

### SSH / POS lifecycle
| Symbol | Line | Notes |
|---|---|---|
| `SSH_HOST`, `SSH_USER` | 72–73 | Daemon-only. |
| `POS_IMAGES_DIR`, `PSEXEC_PATH` | 74–75 | Daemon-only. |
| `POLL_INTERVAL` | 76 | Daemon's sleep interval. |
| `DEMO_BUILDER_API_URL` | 77 | Daemon's reference to Next.js app. |
| `SNAPSHOT_DIR` | 78 | Used by batch snapshot_path too, but set here; keep here, import into shared if needed. **Move with snapshot helpers to BATCH.** |
| `ssh_cmd(host, cmd, user, timeout)` | 145 | Only daemon-side callers (push_images_scp, POS lifecycle, process_queued's ssh_available check). |
| `ssh_available(host, user)` | 161 | Same. |
| `push_images_scp(pending_images, host, user)` | 2402 | Images → tablet. |
| `pos_is_running(host, user)` | 2472 | PsExec tasklist check. |
| `deploy_restart_script(host, user)` | 2478 | Writes restart.vbs to tablet. |
| `get_active_session_id(host, user)` | 2520 | Interactive-session lookup for PsExec `-i` flag. |
| `restart_pos(host, user, db_name)` | 2536 | Kill + relaunch POS via PsExec. |

### Daemon entry point
| Symbol | Line |
|---|---|
| `process_queued()` | 2616 |
| `main()` | 2706 |

---

## Decisions flagged for operator confirmation

1. **`SNAPSHOT_DIR` (line 78).** Set in the config block today but used by `save_snapshot` (BATCH). Proposal: move the constant into `batch_pipeline.py` when the snapshot helpers move. Keep in `deploy_agent.py` for now so the existing gated daemon still reads its `.env` in one place. **Decision needed in Phase 3, not Phase 2.**

2. **`_classify_dead_url` (line 975) and `_classify_extract_skip` (line 427).** Both have successor implementations in `rebuild_batch.py` that supersede them. Keep as BATCH for now; delete in PR4. **No action in PR2.**

3. **`process_generate_queue()` (line 2175).** Dead per `feedback_dual_pipeline_hides_spend.md` once staged pipeline covers everything. Stays BATCH; delete in PR4. **No action in PR2.**

4. **`_ApiLimitHit` exception (line 853).** Classified SHARED because `dryrun_staged.py` catches it. But only AI call sites raise it — SHARED is fine (exceptions can live with callers). **No concern.**

---

## Count

- **SHARED:** 15 symbols — the PR2 move list.
- **BATCH:** 35 symbols — stays gated.
- **DEPLOY:** 18 symbols — stays in `deploy_agent.py` forever.

SHARED is the smallest bucket, which is the correct shape: shared code is pure mechanical utilities; both flavored ends (batch AI, deploy SSH) are much larger.

---

## Caller reconciliation

After the SHARED extract, the four external callers reference these symbols:

| Caller | Symbols needed | Source after PR2 |
|---|---|---|
| `rebuild_batch.py` | `supabase_get`, `HEADERS`, `SUPABASE_URL`, `SUPABASE_KEY`, `_extract_ldjson_menu_text`, `_fetch_homepage_html`, `fetch_page_text_curl_cffi` | all **SHARED** ✅ |
| `rebuild_batch.py` (add for Task 4) | `discover_menu_url`, `_extract_menu_index_links`, `_detect_menu_images` | all **SHARED** ✅ |
| `dryrun_staged.py` | `supabase_get` (SHARED), `WAVE_MIN_SIZE` / `FORCE_WAVE_AFTER_SECONDS` (BATCH), `run_staged_pipeline` (BATCH), `_ApiLimitHit` (SHARED) | mixed — **temporarily** keeps `import deploy_agent as da` for the BATCH symbols, adds `import pipeline_shared as ps` for SHARED. When Phase 3 moves BATCH out of `deploy_agent.py`, updates `da` → `batch_pipeline`. |
| `check_cache.py` | `_STAGE_PROMPTS`, `_anthropic`, `BATCH_MODEL` — all **BATCH** | stays `import deploy_agent as da` in PR2; updates to `batch_pipeline` in Phase 3. |
| `test_extract.py` | `fetch_page_text_curl_cffi`, `fetch_page_text_playwright`, `extract_ldjson_full_menu`, `_extract_menu_index_links`, `_detect_menu_images` — all **SHARED** ✅ | switches to `from pipeline_shared import ...` cleanly. |

**Takeaway:** `rebuild_batch.py` and `test_extract.py` become clean `pipeline_shared` importers. `dryrun_staged.py` and `check_cache.py` stay partially pinned to `deploy_agent.py` until Phase 3 splits out BATCH.
