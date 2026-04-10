// POST /api/upload/:id — receive a file from mobile and store in Supabase Storage
// GET  /api/upload/:id — list files stored for this session
// DELETE /api/upload/:id?path=... — delete a stored file

import { createClient } from "@supabase/supabase-js";

const BUCKET = "menu-uploads";
let bucketReady = false;

function getStorageSupa() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function ensureBucket(supa: ReturnType<typeof getStorageSupa>) {
  if (bucketReady) return;
  // createBucket errors silently if bucket already exists — no need to list first
  await supa.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  bucketReady = true;
}

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

    const supa = getStorageSupa();
    await ensureBucket(supa);

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${sessionId}/${Date.now()}_${safeName}`;

    const bytes = await file.arrayBuffer();
    const { error: uploadErr } = await supa.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: false });

    if (uploadErr) {
      return Response.json({ error: uploadErr.message }, { status: 500 });
    }

    const { data: urlData } = supa.storage.from(BUCKET).getPublicUrl(path);
    return Response.json({ ok: true, url: urlData.publicUrl, name: file.name });
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
    const supa = getStorageSupa();

    const { data, error } = await supa.storage
      .from(BUCKET)
      .list(sessionId, { sortBy: { column: "created_at", order: "asc" } });

    if (error) return Response.json({ files: [] });

    const files = (data ?? []).map((f) => {
      const { data: urlData } = supa.storage
        .from(BUCKET)
        .getPublicUrl(`${sessionId}/${f.name}`);
      return { name: f.name, url: urlData.publicUrl, created_at: f.created_at };
    });

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

    const supa = getStorageSupa();
    const { error } = await supa.storage
      .from(BUCKET)
      .remove([`${sessionId}/${filename}`]);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
