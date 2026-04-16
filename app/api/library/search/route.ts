import { createServerClient } from "@/lib/supabase/server";
import {
  LIBRARY_BUCKET,
  type ImageIntent,
  type ImageLibraryEntry,
  type ImageLibraryRow,
} from "@/lib/library/types";

function toPublicUrl(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${LIBRARY_BUCKET}/${storagePath}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent") as ImageIntent | null;
  const tagsParam = url.searchParams.get("tags") ?? "";
  const tags = tagsParam
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const restaurantType = url.searchParams.get("restaurant_type");
  const foodCategory = url.searchParams.get("food_category");
  const itemName = url.searchParams.get("item_name");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);

  const supabase = createServerClient();
  let query = supabase.from("image_library").select("*");

  if (intent) query = query.eq("original_intent", intent);
  if (restaurantType) query = query.eq("restaurant_type", restaurantType);
  if (foodCategory) query = query.eq("food_category", foodCategory);
  if (tags.length > 0) query = query.overlaps("concept_tags", tags);

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit * 3);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = (data as ImageLibraryRow[]) ?? [];

  const scored = rows
    .map((row) => {
      let score = 0;
      if (tags.length > 0) {
        const rowTags = new Set((row.concept_tags ?? []).map((t) => t.toLowerCase()));
        score += tags.reduce((acc, t) => acc + (rowTags.has(t) ? 1 : 0), 0);
      }
      if (itemName && row.item_name) {
        const a = itemName.toLowerCase();
        const b = row.item_name.toLowerCase();
        if (a === b) score += 10;
        else if (a.includes(b) || b.includes(a)) score += 4;
      }
      if (restaurantType && row.restaurant_type === restaurantType) score += 2;
      if (foodCategory && row.food_category === foodCategory) score += 1;
      return { row, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const entries: ImageLibraryEntry[] = scored.map(({ row }) => ({
    ...row,
    public_url: toPublicUrl(row.storage_path),
  }));

  return Response.json({ entries, matched: entries.length > 0 });
}
