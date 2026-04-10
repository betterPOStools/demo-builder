// Stage a deployment: upload images to Vercel Blob, write SQL + image URLs to Turso.
// Storing URLs instead of data URIs keeps the DB payload tiny (~200 bytes/image vs ~60KB).
// The deploy agent fetches images from Blob URLs at deploy time via HTTP.

import { put } from "@vercel/blob";
import { turso, toJson } from "@/lib/turso";
import type { PendingImageTransfer } from "@/lib/types/deploy";

export const maxDuration = 60;

async function uploadImageToBlob(
  sessionId: string,
  img: PendingImageTransfer,
): Promise<PendingImageTransfer> {
  const url = img.image_url;
  if (!url?.startsWith("data:")) return img; // already a URL — skip

  try {
    const [meta, b64] = url.split(",");
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch?.[1] ?? "image/jpeg";
    const ext = mime.split("/")[1]?.split("+")[0] ?? "jpg";
    const buf = Buffer.from(b64, "base64");

    const blob = await put(`deploy/${sessionId}/${img.name}.${ext}`, buf, {
      access: "public",
      contentType: mime,
      addRandomSuffix: false,
    });

    return { ...img, image_url: blob.url };
  } catch (err) {
    // Blob upload failed — fall back to storing data URI directly in Turso.
    // Turso handles large TEXT values fine; this keeps deploys working even
    // if Vercel Blob is unavailable.
    console.warn("[deploy/stage] Blob upload failed, using data URI fallback:", (err as Error).message);
    return img;
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId: string;
      sql: string;
      stats: Record<string, number>;
      pendingImages: PendingImageTransfer[];
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
      return Response.json({ error: "Missing sessionId or sql" }, { status: 400 });
    }

    // Upload all data URI images to Vercel Blob in parallel.
    let imagesWithUrls: PendingImageTransfer[] = body.pendingImages ?? [];
    if (imagesWithUrls.length > 0) {
      imagesWithUrls = await Promise.all(
        imagesWithUrls.map((img) => uploadImageToBlob(body.sessionId, img)),
      );
    }

    const now = new Date().toISOString();
    await turso.execute({
      sql: `INSERT INTO sessions (id, generated_sql, pending_images, deploy_target, deploy_status, deploy_result, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              generated_sql=excluded.generated_sql,
              pending_images=excluded.pending_images,
              deploy_target=excluded.deploy_target,
              deploy_status='queued',
              deploy_result=NULL,
              updated_at=excluded.updated_at`,
      args: [
        body.sessionId,
        body.sql,
        toJson(imagesWithUrls),
        toJson(body.deployTarget ?? null),
        now,
        now,
      ],
    });

    return Response.json({
      ok: true,
      status: "queued",
      imageCount: imagesWithUrls.length,
      message: "Deploy staged. The agent will pick it up shortly.",
    });
  } catch (error: unknown) {
    const msg = (error as Error).message || "Staging failed";
    console.error("[deploy/stage] error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
