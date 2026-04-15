// Batch generation processor — called by the deploy agent, one job at a time.
//
// Orchestrates the full headless pipeline for a single prospect:
//   batch_queue row → extract URL → build design config → generate SQL
//   → upload images to Vercel Blob → create session (deploy_status='idle')
//   → mark batch_queue done
//
// The agent claims the job (sets status='processing') before calling this route,
// so concurrent agent instances cannot double-process the same job.
//
// AI: Delegates to /api/extract-url internally. Uses claude-haiku-4-5 for
// text menus and claude-sonnet-4-6 for visual/PDF menus. Budget ~$0.05–0.15/restaurant.

import { put } from "@vercel/blob";
import { createServerClient } from "@/lib/supabase/server";
import { buildDesignConfig } from "@/lib/batch/buildDesignConfig";
import { parseDesignConfig } from "@/lib/sql/designParser";
import { generateFullDeployment } from "@/lib/sql/deployer";
import type { RestaurantType } from "@/lib/types/batch";

export const maxDuration = 300;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Derive the app's own base URL from the incoming request host. */
function getBaseUrl(request: Request): string {
  const host = request.headers.get("host") ?? "localhost:3002";
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

// ─── POST /api/batch/process ─────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { queue_id?: string; raw_text?: string };

  if (!body.queue_id) {
    return Response.json({ error: "Missing queue_id" }, { status: 400 });
  }

  const supabase = createServerClient();

  // ── 1. Fetch the batch_queue job ──────────────────────────────────────────
  const { data: job, error: fetchErr } = await supabase
    .from("batch_queue")
    .select("id, pt_record_id, name, menu_url, restaurant_type, status")
    .eq("id", body.queue_id)
    .maybeSingle();

  if (fetchErr || !job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  // BUSINESS RULE: agent must claim the job (status='processing') before calling
  // this route. Reject other statuses so re-queued jobs don't double-process.
  if (job.status !== "processing") {
    return Response.json(
      { error: `Job is in state '${job.status}', expected 'processing'` },
      { status: 409 },
    );
  }

  const markFailed = async (msg: string): Promise<void> => {
    try {
      await supabase
        .from("batch_queue")
        .update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("id", body.queue_id!);
    } catch {
      // best-effort; don't let a DB error mask the original failure
    }
  };

  try {
    // ── 2. Extract menu items from URL ──────────────────────────────────────
    const baseUrl = getBaseUrl(request);
    const extractRes = await fetch(`${baseUrl}/api/extract-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: job.menu_url, rawText: body.raw_text, extendedMode: true }),
    });

    if (!extractRes.ok) {
      const err = (await extractRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(`Extraction failed (HTTP ${extractRes.status}): ${err.error ?? extractRes.statusText}`);
    }

    const extracted = (await extractRes.json()) as {
      rows: unknown[];
      extendedRows?: unknown[];
      restaurantType?: string;
    };

    if (!extracted.rows || extracted.rows.length === 0) {
      const rawLen = body.raw_text?.length ?? 0;
      if (rawLen === 0) {
        throw new Error(`No content fetched from ${job.menu_url} (raw_text=0, agent sent no pre-fetched text and extract-url returned 0 items)`);
      }
      throw new Error(`AI extracted 0 items from ${rawLen} chars of raw_text (menu_url=${job.menu_url})`);
    }

    // ── 3. Build design config (headless) ───────────────────────────────────
    // Prefer extendedRows (include modifier hints) if available.
    const rows = extracted.extendedRows ?? extracted.rows;
    const restaurantType = (job.restaurant_type ?? "other") as RestaurantType;

    const designConfig = buildDesignConfig({
      payload: {
        version: "1.0",
        source: "batch",
        extraction_id: body.queue_id!,
        extracted_at: new Date().toISOString(),
        item_count: (rows as unknown[]).length,
        restaurant_name: job.name,
        items: rows as Parameters<typeof buildDesignConfig>[0]["payload"]["items"],
      },
      restaurantType,
      applyTypePalette: true,
    });

    // ── 4. Parse config and generate SQL ────────────────────────────────────
    const parsed = parseDesignConfig(designConfig);
    if (parsed.errors.length > 0) {
      console.warn(`[batch/process] ${job.name}: ${parsed.errors.length} parse warning(s)`, parsed.errors);
    }

    const deployment = generateFullDeployment({
      items: parsed.items,
      groups: parsed.groups,
      categories: parsed.categories,
      templateAssignments: parsed.templateAssignments,
      modifierTemplates: parsed.modifierTemplates,
      groupMeta: parsed.groupMeta,
      branding: parsed.branding,
      rooms: parsed.rooms,
    });

    // ── 5. Upload data URI images to Vercel Blob ─────────────────────────────
    // Stores blob URL (~100 bytes) instead of raw base64 (~60KB) in Supabase JSONB.
    // Prevents the statement timeout that killed the PROD project on 2026-04-10.
    const sessionId = crypto.randomUUID();

    const pendingImages = await Promise.all(
      deployment.pendingImageTransfers.map(async (img) => {
        const base = { type: img.type, name: img.name, dest_path: img.destPath };
        if (!img.imageUrl?.startsWith("data:")) {
          return { ...base, image_url: img.imageUrl };
        }
        try {
          const [meta, b64] = img.imageUrl.split(",");
          const mime = meta.match(/data:([^;]+)/)?.[1] ?? "image/png";
          const ext = mime.split("/")[1] ?? "png";
          const buf = Buffer.from(b64, "base64");
          const blob = await put(
            `deploy/${sessionId}/${img.name}.${ext}`,
            buf,
            { access: "public", contentType: mime },
          );
          return { ...base, image_url: blob.url };
        } catch (blobErr) {
          // Fallback: store data URI directly — better than failing the job
          console.warn(`[batch/process] Blob upload failed for ${img.name}:`, blobErr);
          return { ...base, image_url: img.imageUrl };
        }
      }),
    );

    // ── 6. Create session in Supabase ────────────────────────────────────────
    // deploy_status='idle' — agent will flip to 'queued' when PT presses "Load Demo"
    const { error: sessionErr } = await supabase.from("sessions").insert({
      id: sessionId,
      user_email: "aaron@valuesystemspos.com",
      name: job.name,
      restaurant_name: job.name,
      restaurant_type: restaurantType,
      pt_record_id: job.pt_record_id,
      generated_sql: deployment.sql,
      pending_images: pendingImages,
      deploy_status: "idle",
      deploy_target: null,
      current_step: 3,
    });

    if (sessionErr) {
      throw new Error(`Session insert failed: ${sessionErr.message}`);
    }

    // ── 7. Mark batch_queue job done ─────────────────────────────────────────
    await supabase
      .from("batch_queue")
      .update({
        status: "done",
        session_id: sessionId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.queue_id);

    console.log(
      `[batch/process] ✓ ${job.name} — session ${sessionId.slice(0, 8)}, ` +
      `${deployment.stats.menuItems} items, ${deployment.stats.groups} groups`,
    );

    return Response.json({
      ok: true,
      session_id: sessionId,
      stats: {
        items: deployment.stats.menuItems,
        groups: deployment.stats.groups,
        modifiers: deployment.stats.modifierTemplates,
      },
    });

  } catch (err: unknown) {
    const msg = (err as Error).message ?? "Processing failed";
    console.error("[batch/process] error:", msg);
    // DO NOT call markFailed here — the agent owns the failure lifecycle.
    // It will retry CF/PW fallbacks, then mark failed itself after all paths exhaust.
    // Marking failed in the route would burn the job before the agent can retry.
    return Response.json({ error: msg }, { status: 500 });
  }
}
