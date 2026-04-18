import { createHash } from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";
import {
  LIBRARY_BUCKET,
  type CreateImageLibraryInput,
  type ImageLibraryEntry,
  type ImageLibraryRow,
  type ImageIntent,
} from "@/lib/library/types";

function toPublicUrl(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${LIBRARY_BUCKET}/${storagePath}`;
}

function rowToEntry(row: ImageLibraryRow): ImageLibraryEntry {
  return { ...row, public_url: toPublicUrl(row.storage_path) };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent") as ImageIntent | null;
  const imageType = url.searchParams.get("image_type") as ImageIntent | null;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);

  const supabase = createServerClient();
  let query = supabase.from("image_library").select("*");

  if (intent) query = query.eq("original_intent", intent);
  if (imageType) query = query.eq("image_type", imageType);

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const entries = (data as ImageLibraryRow[]).map(rowToEntry);
  return Response.json({ entries });
}

export async function POST(request: Request) {
  const body = (await request.json()) as CreateImageLibraryInput;

  if (!body.data_uri?.startsWith("data:")) {
    return Response.json({ error: "data_uri must be a data: URI" }, { status: 400 });
  }

  const [meta, b64] = body.data_uri.split(",");
  const mime = meta.match(/data:([^;]+)/)?.[1] ?? "image/png";
  const ext = mime === "image/svg+xml" ? "svg" : mime.split("/")[1] ?? "png";
  const buf = Buffer.from(b64, "base64");

  const sha = createHash("sha256").update(buf).digest("hex");
  const storagePath = `${body.original_intent}/${sha}.${ext}`;

  const supabase = createServerClient();

  const { error: uploadError } = await supabase.storage
    .from(LIBRARY_BUCKET)
    .upload(storagePath, buf, { contentType: mime, upsert: true });

  if (uploadError) {
    return Response.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: existing } = await supabase
    .from("image_library")
    .select("*")
    .eq("storage_path", storagePath)
    .maybeSingle();

  if (existing) {
    return Response.json({ entry: rowToEntry(existing as ImageLibraryRow) });
  }

  const { data, error } = await supabase
    .from("image_library")
    .insert({
      image_type: body.image_type,
      original_intent: body.original_intent,
      storage_path: storagePath,
      template_id: body.template_id ?? null,
      item_name: body.item_name ?? null,
      seamless_pair_id: body.seamless_pair_id ?? null,
      concept_tags: body.concept_tags ?? [],
      cuisine_type: body.cuisine_type ?? null,
      food_category: body.food_category ?? null,
      restaurant_type: body.restaurant_type ?? null,
      dimensions: body.dimensions ?? null,
      generated_for: body.generated_for ?? null,
    })
    .select("*")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ entry: rowToEntry(data as ImageLibraryRow) });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const supabase = createServerClient();

  const { data: row, error: fetchError } = await supabase
    .from("image_library")
    .select("storage_path")
    .eq("id", id)
    .single();

  if (fetchError) return Response.json({ error: fetchError.message }, { status: 404 });

  const storagePath = (row as { storage_path: string }).storage_path;

  await supabase.storage.from(LIBRARY_BUCKET).remove([storagePath]);

  const { error: deleteError } = await supabase
    .from("image_library")
    .delete()
    .eq("id", id);

  if (deleteError) return Response.json({ error: deleteError.message }, { status: 500 });

  return Response.json({ ok: true });
}
