import type { GeneratedImage } from "@/store/designSlice";
import type {
  CreateImageLibraryInput,
  ImageLibraryEntry,
  ImageIntent,
  LibrarySearchParams,
} from "./types";

const LEGACY_IDB_NAME = "demo-builder";
const LEGACY_STORE = "imageLibrary";
const LEGACY_KEY = "images";

export async function listLibrary(params: {
  intent?: string;
  image_type?: string;
  limit?: number;
} = {}): Promise<ImageLibraryEntry[]> {
  const qs = new URLSearchParams();
  if (params.intent) qs.set("intent", params.intent);
  if (params.image_type) qs.set("image_type", params.image_type);
  if (params.limit) qs.set("limit", String(params.limit));

  const res = await fetch(`/api/library?${qs.toString()}`);
  if (!res.ok) throw new Error(`listLibrary failed: ${res.status}`);
  const data = (await res.json()) as { entries: ImageLibraryEntry[] };
  return data.entries;
}

export async function addToLibrary(
  input: CreateImageLibraryInput,
): Promise<ImageLibraryEntry> {
  const res = await fetch(`/api/library`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`addToLibrary failed: ${res.status}`);
  const data = (await res.json()) as { entry: ImageLibraryEntry };
  return data.entry;
}

export async function removeFromLibrary(id: string): Promise<void> {
  const res = await fetch(`/api/library?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`removeFromLibrary failed: ${res.status}`);
}

function readLegacyIdb(): Promise<GeneratedImage[]> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(LEGACY_IDB_NAME, 1);
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(LEGACY_STORE)) {
          resolve([]);
          return;
        }
        const tx = db.transaction(LEGACY_STORE, "readonly");
        const getReq = tx.objectStore(LEGACY_STORE).get(LEGACY_KEY);
        getReq.onsuccess = () => resolve((getReq.result as GeneratedImage[]) ?? []);
        getReq.onerror = () => resolve([]);
      };
    } catch {
      resolve([]);
    }
  });
}

export async function countLegacyIdbImages(): Promise<number> {
  const images = await readLegacyIdb();
  return images.length;
}

export async function seedLibraryFromLegacyIdb(
  onProgress?: (done: number, total: number) => void,
): Promise<{ seeded: number; skipped: number; failed: number }> {
  const images = await readLegacyIdb();
  let seeded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img.dataUri?.startsWith("data:")) {
      skipped++;
      continue;
    }
    try {
      await addToLibrary({
        image_type: img.type as ImageIntent,
        original_intent: img.type as ImageIntent,
        data_uri: img.dataUri,
        item_name: img.itemName,
        seamless_pair_id: img.seamlessId,
        concept_tags: img.conceptTags,
        cuisine_type: img.cuisineType,
        food_category: img.foodCategory,
        generated_for: img.generatedFor ?? img.restaurantName,
      });
      seeded++;
    } catch {
      failed++;
    }
    onProgress?.(i + 1, images.length);
  }

  return { seeded, skipped, failed };
}

export async function searchLibrary(
  params: LibrarySearchParams,
): Promise<{ entries: ImageLibraryEntry[]; matched: boolean }> {
  const qs = new URLSearchParams();
  if (params.intent) qs.set("intent", params.intent);
  if (params.tags?.length) qs.set("tags", params.tags.join(","));
  if (params.restaurant_type) qs.set("restaurant_type", params.restaurant_type);
  if (params.food_category) qs.set("food_category", params.food_category);
  if (params.cuisine_type) qs.set("cuisine_type", params.cuisine_type);
  if (params.item_name) qs.set("item_name", params.item_name);
  if (params.template_id) qs.set("template_id", params.template_id);
  if (params.limit) qs.set("limit", String(params.limit));

  const res = await fetch(`/api/library/search?${qs.toString()}`);
  if (!res.ok) throw new Error(`searchLibrary failed: ${res.status}`);
  return (await res.json()) as { entries: ImageLibraryEntry[]; matched: boolean };
}
