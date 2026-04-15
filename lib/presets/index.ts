export { PREMADE_TEMPLATES } from "./premadeTemplates";
export { RESTAURANT_BUNDLES, type RestaurantBundle } from "./restaurantBundles";

import { generateId } from "@/lib/utils";
import { PREMADE_TEMPLATES } from "./premadeTemplates";
import { LAYOUT_PRESETS } from "@/lib/sql/layout";
import type { RestaurantBundle } from "./restaurantBundles";
import type {
  GroupNode,
  ItemNode,
  RoomNode,
  CategoryName,
} from "@/lib/types";
import type { ModifierTemplateNode } from "@/lib/types";

export interface ClonedBundle {
  groups: GroupNode[];
  items: ItemNode[];
  rooms: RoomNode[];
  modifierTemplates: ModifierTemplateNode[];
  restaurantName: string;
}

export function cloneBundle(bundle: RestaurantBundle): ClonedBundle {
  const groups: GroupNode[] = [];
  const items: ItemNode[] = [];
  const groupSortCounters: Record<CategoryName, number> = {
    Food: 0,
    Beverages: 0,
    Bar: 0,
  };

  for (const bg of bundle.groups) {
    const gid = generateId();
    groups.push({
      id: gid,
      name: bg.name,
      category: bg.category,
      sortOrder: groupSortCounters[bg.category]++,
      color: null,
      imageAssetId: null,
      posImagePath: null,
    });

    for (let i = 0; i < bg.items.length; i++) {
      const bi = bg.items[i];
      items.push({
        id: generateId(),
        name: bi.name,
        groupId: gid,
        sortOrder: i,
        defaultPrice: bi.price,
        dineInPrice: 0,
        barPrice: 0,
        pickUpPrice: 0,
        takeOutPrice: 0,
        deliveryPrice: 0,
        printAt: bi.printAt ?? 1,
        tax1: true,
        tax2: false,
        tax3: false,
        isOpenPrice: false,
        isBarItem: bi.isBarItem ?? false,
        isWeighted: false,
        tare: 0,
        barcode: null,
        isFolder: false,
        belongsToFolder: null,
        modifierTemplateIds: [],
        imageAssetId: null,
        posImagePath: null,
        color: null,
        active: true,
        description: null,
      });
    }
  }

  // Clone modifier templates with fresh IDs
  const modifierTemplates: ModifierTemplateNode[] = [];
  const templateIdMap = new Map<string, string>();

  for (const key of bundle.templateKeys) {
    const source = PREMADE_TEMPLATES[key];
    if (!source) continue;

    const tid = generateId();
    templateIdMap.set(key, tid);

    modifierTemplates.push({
      ...source,
      id: tid,
      sections: source.sections.map((s) => ({
        ...s,
        id: generateId(),
        modifiers: s.modifiers.map((m) => ({
          ...m,
          id: generateId(),
        })),
      })),
    });
  }

  // Assign modifier templates to items by group name heuristic
  for (const item of items) {
    const group = groups.find((g) => g.id === item.groupId);
    if (!group) continue;

    const gname = group.name.toLowerCase();
    const tids: string[] = [];

    // Map group names to template keys
    if (
      gname.includes("pizza") &&
      templateIdMap.has("pizza_modifiers")
    ) {
      tids.push(templateIdMap.get("pizza_modifiers")!);
    }
    if (
      (gname.includes("burger") || gname.includes("steak")) &&
      templateIdMap.has("burger_modifiers")
    ) {
      tids.push(templateIdMap.get("burger_modifiers")!);
    }
    if (
      gname.includes("steak") &&
      templateIdMap.has("steak_modifiers")
    ) {
      // Replace burger_modifiers with steak_modifiers for steak groups
      tids.length = 0;
      tids.push(templateIdMap.get("steak_modifiers")!);
    }
    if (
      (gname.includes("sandwich") || gname.includes("wrap") || gname.includes("sub")) &&
      templateIdMap.has("sandwich_modifiers")
    ) {
      tids.push(templateIdMap.get("sandwich_modifiers")!);
    }
    if (
      (gname.includes("cocktail") || gname.includes("beer") ||
        gname.includes("wine") || gname.includes("draft")) &&
      templateIdMap.has("drink_modifiers")
    ) {
      tids.push(templateIdMap.get("drink_modifiers")!);
    }
    if (
      (gname.includes("egg") || gname.includes("omelet") ||
        gname.includes("pancake") || gname.includes("waffle")) &&
      templateIdMap.has("breakfast_modifiers")
    ) {
      tids.push(templateIdMap.get("breakfast_modifiers")!);
    }

    if (tids.length > 0) {
      item.modifierTemplateIds = tids;
    }
  }

  // Clone rooms from layout preset
  const rooms: RoomNode[] = [];
  const preset = LAYOUT_PRESETS[bundle.layoutPresetKey];
  if (preset) {
    for (const r of preset.rooms) {
      rooms.push({
        id: generateId(),
        name: r.name,
        color: r.color ?? "#fffdcc",
        gridSize: r.grid_size ?? 1,
        tables: r.tables.map((t) => ({
          id: generateId(),
          name: t.name,
          seats: t.capacity ?? 4,
          isBarStool: t.is_bar_stool ?? false,
          rowIndex: t.row_index ?? 0,
          columnIndex: t.column_index ?? 0,
          color: null,
          posImagePath: null,
          imageAssetId: null,
        })),
      });
    }
  }

  return {
    groups,
    items,
    rooms,
    modifierTemplates,
    restaurantName: bundle.name,
  };
}
