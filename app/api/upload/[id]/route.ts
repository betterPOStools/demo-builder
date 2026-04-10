// POST /api/upload/:id — receive a file and store in Vercel Blob
// GET  /api/upload/:id — list files stored for this session
// DELETE /api/upload/:id?path=... — delete a stored file

import { put, list, del } from "@vercel/blob";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const pathname = `uploads/${sessionId}/${Date.now()}_${safeName}`;

    const bytes = await file.arrayBuffer();
    const blob = await put(pathname, bytes, {
      access: "public",
      contentType: file.type,
      addRandomSuffix: false,
    });

    return Response.json({ ok: true, url: blob.url, name: file.name });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;
    const { blobs } = await list({ prefix: `uploads/${sessionId}/` });

    const files = blobs.map((b) => ({
      name: b.pathname.split("/").pop() ?? b.pathname,
      url: b.url,
      created_at: b.uploadedAt,
    }));

    return Response.json({ files });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;
    const url = new URL(request.url);
    const filename = url.searchParams.get("path");
    if (!filename) {
      return Response.json({ error: "Missing path param" }, { status: 400 });
    }

    // Accept either a full blob URL or just the filename
    const blobUrl = filename.startsWith("http")
      ? filename
      : `uploads/${sessionId}/${filename}`;

    await del(blobUrl);
    return Response.json({ ok: true });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
