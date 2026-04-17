// lib/sql/fromTablet.ts
//
// Reverse-mapper for the "Load from Tablet" flow. Consumes the JSON emitted
// by agent/snapshot_server.py's /snapshot endpoint and produces the subset
// of Zustand-store shape the Design step needs (groups, items, branding,
// restaurantName).
//
// Scope decisions:
//   - Snapshot groups have no Food/Beverages/Bar bucket — the tablet schema
//     tracks a separate MenuCategoryId that doesn't round-trip to our
//     CategoryName. All groups default to "Food"; user re-categorizes in
//     the Design step if needed.
//   - Item images (menuitems.PicturePath) are ignored. The tablet rarely
//     has them populated and round-tripping would require N image fetches
//     per item just to hydrate the Design page. posImagePath is null; user
//     regenerates on demand via the existing ImageGenerator.
//   - Branding images (background + sidebar) ARE fetched and inlined as
//     data URIs. There are at most 2 of them and they're what makes the
//     Design page feel "loaded".
//   - Modifier templates are NOT included — snapshot_server.py doesn't
//     expose them yet. Items round-trip with empty modifierTemplateIds.

import type { GroupNode, ItemNode } from "@/lib/types";
import type { BrandingState } from "@/store/designSlice";
import { generateId } from "@/lib/utils";

export interface TabletSnapshotGroup {
  id: number;
  name: string;
  index: number;
  picture_path: string | null;
  color: string | null;
  grid_rows: number | null;
  grid_columns: number | null;
}

export interface TabletSnapshotItem {
  id: number;
  name: string;
  description: string | null;
  default_price: number | null;
  is_open_price_item: boolean;
  group_id: number;
  category_id: number | null;
  row_index: number | null;
  column_index: number | null;
  index: number;
  picture_path: string | null;
  color: string | null;
  barcode: string | null;
  is_bar_item: boolean;
  is_weighted: boolean;
  modifier_template_id: number | null;
}

export interface TabletSnapshotBranding {
  background: string | null;
  buttons_background_color: string | null;
  buttons_font_color: string | null;
  sidebar_picture: string | null;
}

export interface TabletSnapshot {
  restaurant_name: string;
  database: string;
  groups: TabletSnapshotGroup[];
  items: TabletSnapshotItem[];
  branding: TabletSnapshotBranding;
  store_settings: Record<string, string>;
}

export interface TabletSnapshotMapped {
  restaurantName: string;
  groups: GroupNode[];
  items: ItemNode[];
  branding: BrandingState;
}

export function mapTabletSnapshot(snap: TabletSnapshot): TabletSnapshotMapped {
  // Pecan group ID (number) → new generated id (string) so items can wire up.
  const groupIdMap = new Map<number, string>();

  const groups: GroupNode[] = snap.groups.map((g, idx) => {
    const newId = generateId();
    groupIdMap.set(g.id, newId);
    return {
      id: newId,
      name: g.name || "Ungrouped",
      category: "Food",
      sortOrder: typeof g.index === "number" ? g.index : idx,
      color: g.color ?? null,
      imageAssetId: null,
      posImagePath: null,
    };
  });

  // Drop items whose group was deleted/missing — the snapshot enforces
  // MenuGroupId FK so this shouldn't happen, but defend against it.
  const items: ItemNode[] = snap.items
    .filter((it) => groupIdMap.has(it.group_id))
    .map((it, idx) => ({
      id: generateId(),
      name: it.name || "Unnamed",
      groupId: groupIdMap.get(it.group_id)!,
      sortOrder: typeof it.index === "number" ? it.index : idx,
      defaultPrice: typeof it.default_price === "number" ? it.default_price : 0,
      dineInPrice: 0,
      barPrice: 0,
      pickUpPrice: 0,
      takeOutPrice: 0,
      deliveryPrice: 0,
      printAt: 1,
      tax1: false,
      tax2: false,
      tax3: false,
      isOpenPrice: Boolean(it.is_open_price_item),
      isBarItem: Boolean(it.is_bar_item),
      isWeighted: Boolean(it.is_weighted),
      tare: 0,
      barcode: it.barcode ?? null,
      isFolder: false,
      belongsToFolder: null,
      modifierTemplateIds: [],
      imageAssetId: null,
      posImagePath: null,
      color: it.color ?? null,
      active: true,
      description: it.description ?? null,
    }));

  const branding: BrandingState = {
    background: snap.branding.background ?? null,
    // background_picture + sidebar_picture are populated asynchronously by
    // the caller after fetching /image for the raw paths. See hydrateBranding
    // helper below.
    background_picture: null,
    buttons_background_color: snap.branding.buttons_background_color ?? null,
    buttons_font_color: snap.branding.buttons_font_color ?? null,
    sidebar_picture: null,
  };

  return {
    restaurantName: snap.restaurant_name && !isDbLikeName(snap.restaurant_name)
      ? snap.restaurant_name
      : "",
    groups,
    items,
    branding,
  };
}

// Supabase-picked-from-DB-name fallback smell test. snapshot_server.py falls
// back to the database name when no RestaurantName/StoreName/BusinessName is
// present in storesettings — that name usually looks like "pecandemodb" or
// "LittlePigs_Test" and is never a real display name.
function isDbLikeName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith("db")) return true;
  if (lower.endsWith("_test") || lower.endsWith("_prod")) return true;
  if (/^[a-z0-9_]+$/i.test(name) && !name.includes(" ")) return true;
  return false;
}

export interface BrandingImagePaths {
  background: string | null;
  sidebar: string | null;
}

export function extractBrandingImagePaths(snap: TabletSnapshot): BrandingImagePaths {
  return {
    background: snap.branding.background || null,
    sidebar: snap.branding.sidebar_picture || null,
  };
}

export async function fetchImageAsDataUri(
  snapshotBaseUrl: string,
  host: string,
  path: string,
  sshUser = "admin",
): Promise<string> {
  const url = new URL(`${snapshotBaseUrl.replace(/\/$/, "")}/image`);
  url.searchParams.set("host", host);
  url.searchParams.set("path", path);
  url.searchParams.set("user", sshUser);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`image fetch ${path} failed: ${res.status}`);
  }
  const blob = await res.blob();
  return await blobToDataUri(blob);
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(fr.result as string);
    fr.readAsDataURL(blob);
  });
}
