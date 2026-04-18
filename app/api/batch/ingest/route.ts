// Batch ingest — called by the deploy agent once stages 1–4 have populated
// extraction_result / modifier_result / branding_result on a batch_queue row.
//
// Pipeline (deterministic, no AI):
//   row → buildDesignConfig (AI modifiers + AI branding merged in)
//       → parseDesignConfig → generateFullDeployment
//       → upload images to Vercel Blob → insert session (deploy_status='idle')
//       → mark batch_queue done

import { put } from "@vercel/blob";
import { createServerClient } from "@/lib/supabase/server";
import { buildDesignConfig, buildDesignState } from "@/lib/batch/buildDesignConfig";
import { parseDesignConfig } from "@/lib/sql/designParser";
import { generateFullDeployment } from "@/lib/sql/deployer";
import type { RestaurantType } from "@/lib/types/batch";
import type { MenuItemsPayload } from "@/lib/types";

export const maxDuration = 300;

interface ExtractionResult {
  restaurantType?: string;
  items?: Array<Record<string, unknown>>;
}

interface ModifierResult {
  modifierTemplates?: Array<{
    name: string;
    sections: Array<{
      name: string;
      min_selections: number;
      max_selections: number;
      modifiers: Array<{ name: string; price: number }>;
    }>;
  }>;
  itemTemplateMap?: Record<string, string | null>;
}

interface BrandingResult {
  background_color?: string;
  buttons_background_color?: string;
  buttons_font_color?: string;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { queue_id?: string };
  if (!body.queue_id) {
    return Response.json({ error: "Missing queue_id" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: job, error: fetchErr } = await supabase
    .from("batch_queue")
    .select("id, pt_record_id, name, menu_url, restaurant_type, status, extraction_result, modifier_result, branding_result")
    .eq("id", body.queue_id)
    .maybeSingle();

  if (fetchErr || !job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status !== "ready_to_assemble" && job.status !== "assembling") {
    return Response.json(
      { error: `Job is in state '${job.status}', expected 'ready_to_assemble' or 'assembling'` },
      { status: 409 },
    );
  }

  try {
    const extraction = (job.extraction_result ?? {}) as ExtractionResult;
    const modifier = (job.modifier_result ?? {}) as ModifierResult;
    const branding = (job.branding_result ?? null) as BrandingResult | null;

    if (!extraction.items || extraction.items.length === 0) {
      throw new Error("No items in extraction_result — stage 2 did not complete");
    }

    const VALID_TYPES: RestaurantType[] = [
      "pizza", "bar_grill", "fine_dining", "cafe", "fast_casual", "fast_food",
      "breakfast", "mexican", "asian", "seafood", "other",
    ];
    const extractedType = extraction.restaurantType as string | undefined;
    const restaurantType = (
      extractedType && VALID_TYPES.includes(extractedType as RestaurantType)
        ? extractedType
        : (job.restaurant_type ?? "other")
    ) as RestaurantType;

    const payload: MenuItemsPayload = {
      version: "1.0",
      source: "batch",
      extraction_id: body.queue_id,
      extracted_at: new Date().toISOString(),
      item_count: extraction.items.length,
      restaurant_name: job.name,
      items: extraction.items as MenuItemsPayload["items"],
    };

    const buildOpts = {
      payload,
      restaurantType,
      applyTypePalette: true,
      aiModifierTemplates: modifier.modifierTemplates,
      aiItemTemplateMap: modifier.itemTemplateMap,
      brandingOverride: branding ?? undefined,
    };

    const designConfig = buildDesignConfig(buildOpts);
    const designStateNodes = buildDesignState(buildOpts);

    const parsed = parseDesignConfig(designConfig);
    if (parsed.errors.length > 0) {
      console.warn(`[batch/ingest] ${job.name}: ${parsed.errors.length} parse warning(s)`, parsed.errors);
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
          const blob = await put(`deploy/${sessionId}/${img.name}.${ext}`, buf, {
            access: "public",
            contentType: mime,
          });
          return { ...base, image_url: blob.url };
        } catch (blobErr) {
          console.warn(`[batch/ingest] Blob upload failed for ${img.name}:`, blobErr);
          return { ...base, image_url: img.imageUrl };
        }
      }),
    );

    const designStateBlob = {
      groups: designStateNodes.groups,
      items: designStateNodes.items,
      rooms: designStateNodes.rooms,
      branding: designStateNodes.branding,
      designOrigin: {
        type: "menu_import" as const,
        importedAt: new Date().toISOString(),
      },
    };

    const { error: sessionErr } = await supabase.from("sessions").insert({
      id: sessionId,
      user_email: "aaron@valuesystemspos.com",
      name: job.name,
      restaurant_name: job.name,
      restaurant_type: restaurantType,
      pt_record_id: job.pt_record_id,
      generated_sql: deployment.sql,
      pending_images: pendingImages,
      design_state: designStateBlob,
      modifier_templates: designStateNodes.modifierTemplates,
      extracted_rows: extraction.items,
      deploy_status: "idle",
      deploy_target: null,
      current_step: 3,
    });

    if (sessionErr) {
      throw new Error(`Session insert failed: ${sessionErr.message}`);
    }

    await supabase
      .from("batch_queue")
      .update({
        status: "done",
        session_id: sessionId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.queue_id);

    console.log(
      `[batch/ingest] ✓ ${job.name} — session ${sessionId.slice(0, 8)}, ` +
        `${deployment.stats.menuItems} items, ${deployment.stats.groups} groups, ` +
        `${deployment.stats.modifierTemplates} modifier templates`,
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
    const msg = (err as Error).message ?? "Ingest failed";
    console.error("[batch/ingest] error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
