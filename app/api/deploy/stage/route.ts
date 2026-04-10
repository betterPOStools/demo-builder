// Stage a deployment: write generated SQL + pending images to Supabase
// The deploy agent on the laptop polls for queued sessions and executes them.
//
// Image handling: data URI images are uploaded to Vercel Blob first, and only the
// public URL is stored in Supabase. This keeps the JSONB payload tiny (~200 bytes/image
// vs ~60KB data URI) — the original root cause of the Supabase PROD statement timeout
// on 2026-04-10 that killed the PROD project.
//
// The deploy agent already handles both data URIs and URLs in push_images_scp(), so
// no agent changes were needed — only this route needed to upload before upsert.

import { put } from "@vercel/blob";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId: string;
      sql: string;
      stats: Record<string, number>;
      pendingImages: { type: string; name: string; imageUrl: string; destPath: string }[];
      deployTarget?: {
        host: string;
        port: number;
        database: string;
        user: string;
        password: string;
        upload_server_url?: string;
      };
    };

    if (!body.sessionId || !body.sql) {
      return Response.json(
        { error: "Missing sessionId or sql" },
        { status: 400 },
      );
    }

    // Upload data URI images to Vercel Blob before writing to Supabase.
    // Each data URI is ~60KB; a Blob URL is ~100 bytes. Storing raw data URIs in
    // Supabase JSONB caused statement timeouts that killed the PROD project (2026-04-10).
    const pendingImagesWithUrls = await Promise.all(
      (body.pendingImages ?? []).map(async (img) => {
        if (!img.imageUrl?.startsWith("data:")) return img;
        try {
          const [meta, b64] = img.imageUrl.split(",");
          const mime = meta.match(/data:([^;]+)/)?.[1] ?? "image/jpeg";
          const ext = mime.split("/")[1] ?? "jpg";
          const buf = Buffer.from(b64, "base64");
          const blob = await put(
            `deploy/${body.sessionId}/${img.name}.${ext}`,
            buf,
            { access: "public", contentType: mime },
          );
          return { ...img, imageUrl: blob.url };
        } catch (err) {
          // Fallback: store data URI directly — better than failing the whole stage
          console.warn(`[deploy/stage] Blob upload failed for ${img.name}:`, err);
          return img;
        }
      }),
    );

    const supabase = createServerClient();

    // Upsert: create the session if it doesn't exist yet (app runs in-memory via Zustand)
    const { error } = await supabase
      .from("sessions")
      .upsert({
        id: body.sessionId,
        user_email: "aaron@valuesystemspos.com",
        generated_sql: body.sql,
        pending_images: pendingImagesWithUrls,
        deploy_target: body.deployTarget ?? null,
        deploy_status: "queued",
        deploy_result: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });

    if (error) {
      console.error("[deploy/stage] supabase error:", error.message);
      return Response.json(
        { error: `Failed to stage deploy: ${error.message}` },
        { status: 500 },
      );
    }

    return Response.json({
      ok: true,
      status: "queued",
      message: "Deploy staged. The agent will pick it up shortly.",
    });
  } catch (error: unknown) {
    const msg = (error as Error).message || "Staging failed";
    console.error("[deploy/stage] error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
