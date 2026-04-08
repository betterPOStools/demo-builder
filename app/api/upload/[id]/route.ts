// POST /api/upload/:id — receive a file from mobile and store in Supabase Storage
// GET  /api/upload/:id — list files stored for this session
// DELETE /api/upload/:id?path=... — delete a stored file

import { createServerClient } from "@/lib/supabase/server";

const BUCKET = "menu-uploads";

async function ensureBucket(supabase: ReturnType<typeof createServerClient>) {
  // Use the storage API with the public schema (not demo_builder)
  const storageSupa = (await import("@supabase/supabase-js")).createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: buckets } = await storageSupa.storage.listBuckets();
  if (!buckets?.find((b) => b.name === BUCKET)) {
    await storageSupa.storage.createBucket(BUCKET, { public: true });
  }
  return storageSupa;
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

    const supabase = createServerClient();
    const storageSupa = await ensureBucket(supabase);

    const ext = file.name.split(".").pop() ?? "jpg";
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${sessionId}/${Date.now()}_${safeName}`;

    const bytes = await file.arrayBuffer();
    const { error: uploadErr } = await storageSupa.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: false });

    if (uploadErr) {
      return Response.json({ error: uploadErr.message }, { status: 500 });
    }

    const { data: urlData } = storageSupa.storage.from(BUCKET).getPublicUrl(path);

    return Response.json({ ok: true, url: urlData.publicUrl, name: file.name });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

// GET /api/upload/:id — list files uploaded for this session
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;
    const storageSupa = (await import("@supabase/supabase-js")).createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data, error } = await storageSupa.storage
      .from(BUCKET)
      .list(sessionId, { sortBy: { column: "created_at", order: "asc" } });

    if (error) {
      // Bucket may not exist yet — return empty list
      return Response.json({ files: [] });
    }

    const files = (data ?? []).map((f) => {
      const { data: urlData } = storageSupa.storage
        .from(BUCKET)
        .getPublicUrl(`${sessionId}/${f.name}`);
      return { name: f.name, url: urlData.publicUrl, created_at: f.created_at };
    });

    return Response.json({ files });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

// DELETE /api/upload/:id?path=filename — remove a stored file
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

    const storageSupa = (await import("@supabase/supabase-js")).createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { error } = await storageSupa.storage
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
