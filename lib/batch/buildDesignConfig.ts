/**
 * Headless design config builder.
 *
 * Converts a MenuItemsPayload + restaurant type into a DesignConfigV2 without
 * needing the browser, React, or Zustand. Used by the batch pipeline script.
 *
 * Pipeline:
 *   MenuItemsPayload
 *     → parseMenuRows()        → ImportedMenuItem[]
 *     → buildGroupsAndItems()  → GroupNode[] + ItemNode[]
 *     → assignModifiers()      → ModifierTemplateNode[] wired to items
 *     → loadRooms()            → RoomNode[]
 *     → serializeDesignConfig() → DesignConfigV2
 */

import { parseMenuRows } from "@/lib/menuImport";
import { serializeDesignConfig } from "@/lib/serializer";
import { PREMADE_TEMPLATES } from "@/lib/presets/premadeTemplates";
import { RESTAURANT_TYPE_PALETTES } from "@/lib/presets/typePalettes";
import { LAYOUT_PRESETS } from "@/lib/sql/layout";
import { generateId } from "@/lib/utils";
import type { MenuItemsPayload, CategoryName } from "@/lib/types";
import type { GroupNode, ItemNode, RoomNode } from "@/lib/types/design";
import { createEmptyDesignState } from "@/lib/types/design";
import type { ModifierTemplateNode } from "@/lib/types/modifiers";
import type { DesignConfigV2 } from "@/lib/types/designConfig";
import type { RestaurantType } from "@/lib/types/batch";

// ---------------------------------------------------------------------------
// Restaurant type → preset mapping
// ---------------------------------------------------------------------------

interface TypePreset {
  layoutKey: string;
  templateKeys: string[];
}

const TYPE_PRESETS: Record<RestaurantType, TypePreset> = {
  pizza:       { layoutKey: "small_restaurant", templateKeys: ["pizza_modifiers", "drink_modifiers"] },
  bar_grill:   { layoutKey: "bar_focused",      templateKeys: ["burger_modifiers", "drink_modifiers"] },
  fine_dining: { layoutKey: "fine_dining",      templateKeys: ["steak_modifiers", "drink_modifiers"] },
  cafe:        { layoutKey: "fast_casual",      templateKeys: ["drink_modifiers"] },
  fast_casual: { layoutKey: "fast_casual",      templateKeys: ["sandwich_modifiers", "drink_modifiers"] },
  fast_food:   { layoutKey: "fast_casual",      templateKeys: ["burger_modifiers", "drink_modifiers"] },
  breakfast:   { layoutKey: "small_restaurant", templateKeys: ["breakfast_modifiers"] },
  mexican:     { layoutKey: "fast_casual",      templateKeys: ["sandwich_modifiers", "drink_modifiers"] },
  asian:       { layoutKey: "fast_casual",      templateKeys: ["drink_modifiers"] },
  seafood:     { layoutKey: "small_restaurant", templateKeys: ["steak_modifiers", "drink_modifiers"] },
  other:       { layoutKey: "small_restaurant", templateKeys: ["drink_modifiers"] },
};

// ---------------------------------------------------------------------------
// Step 1: MenuItemsPayload → GroupNode[] + ItemNode[]
// (extracted from designSlice.importExtractedData without Zustand)
// ---------------------------------------------------------------------------

function buildGroupsAndItems(payload: MenuItemsPayload): {
  groups: GroupNode[];
  items: ItemNode[];
} {
  const importedItems = parseMenuRows(payload.items);
  const groupMap = new Map<string, GroupNode>();
  const items: ItemNode[] = [];
  const groupSortCounters: Record<CategoryName, number> = {
    Food: 0,
    Beverages: 0,
    Bar: 0,
  };

  for (const mi of importedItems) {
    const groupKey = `${mi.category}::${mi.group}`;
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        id: generateId(),
        name: mi.group || "Ungrouped",
        category: mi.category,
        sortOrder: groupSortCounters[mi.category]++,
        color: null,
        imageAssetId: null,
        posImagePath: null,
      });
    }

    const group = groupMap.get(groupKey)!;
    const itemsInGroup = items.filter((i) => i.groupId === group.id);

    items.push({
      id: generateId(),
      name: mi.name,
      groupId: group.id,
      sortOrder: itemsInGroup.length,
      defaultPrice: mi.defaultPrice,
      dineInPrice: mi.dineInPrice,
      barPrice: mi.barPrice,
      pickUpPrice: mi.pickUpPrice,
      takeOutPrice: mi.takeOutPrice,
      deliveryPrice: mi.deliveryPrice,
      printAt: mi.printAt || 1,
      tax1: mi.tax1,
      tax2: mi.tax2,
      tax3: mi.tax3,
      isOpenPrice: mi.isOpenPrice,
      isBarItem: mi.isBarItem,
      isWeighted: mi.isWeighted,
      tare: mi.tare,
      barcode: mi.barcode,
      isFolder: mi.isFolder,
      belongsToFolder: mi.belongsToFolder,
      modifierTemplateIds: [],
      imageAssetId: null,
      posImagePath: null,
      color: null,
      active: true,
    });
  }

  return { groups: Array.from(groupMap.values()), items };
}

// ---------------------------------------------------------------------------
// Step 2: Clone modifier templates + wire to items by group name heuristic
// (extracted from presets/index.ts cloneBundle)
// ---------------------------------------------------------------------------

function assignModifiers(
  groups: GroupNode[],
  items: ItemNode[],
  templateKeys: string[],
): { items: ItemNode[]; modifierTemplates: ModifierTemplateNode[] } {
  const modifierTemplates: ModifierTemplateNode[] = [];
  const templateIdMap = new Map<string, string>();

  for (const key of templateKeys) {
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
        modifiers: s.modifiers.map((m) => ({ ...m, id: generateId() })),
      })),
    });
  }

  const wiredItems = items.map((item) => {
    const group = groups.find((g) => g.id === item.groupId);
    if (!group) return item;

    const gname = group.name.toLowerCase();
    const tids: string[] = [];

    if (gname.includes("pizza") && templateIdMap.has("pizza_modifiers"))
      tids.push(templateIdMap.get("pizza_modifiers")!);
    if ((gname.includes("burger") || gname.includes("steak")) && templateIdMap.has("burger_modifiers"))
      tids.push(templateIdMap.get("burger_modifiers")!);
    if (gname.includes("steak") && templateIdMap.has("steak_modifiers")) {
      tids.length = 0;
      tids.push(templateIdMap.get("steak_modifiers")!);
    }
    if ((gname.includes("sandwich") || gname.includes("wrap") || gname.includes("sub")) && templateIdMap.has("sandwich_modifiers"))
      tids.push(templateIdMap.get("sandwich_modifiers")!);
    if ((gname.includes("cocktail") || gname.includes("beer") || gname.includes("wine") || gname.includes("draft")) && templateIdMap.has("drink_modifiers"))
      tids.push(templateIdMap.get("drink_modifiers")!);
    if ((gname.includes("egg") || gname.includes("omelet") || gname.includes("pancake") || gname.includes("waffle")) && templateIdMap.has("breakfast_modifiers"))
      tids.push(templateIdMap.get("breakfast_modifiers")!);

    return tids.length > 0 ? { ...item, modifierTemplateIds: tids } : item;
  });

  return { items: wiredItems, modifierTemplates };
}

// ---------------------------------------------------------------------------
// Step 3: Load rooms from layout preset
// (extracted from designSlice.loadRoomsFromPreset)
// ---------------------------------------------------------------------------

function loadRooms(layoutKey: string): RoomNode[] {
  const preset = LAYOUT_PRESETS[layoutKey];
  if (!preset) return [];

  return preset.rooms.map((r) => ({
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
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildDesignConfigOptions {
  payload: MenuItemsPayload;
  restaurantType: RestaurantType;
  /** Override layout preset key (defaults to type mapping) */
  layoutKey?: string;
  /** Override modifier template keys (defaults to type mapping) */
  templateKeys?: string[];
  /**
   * When true, inject the static RESTAURANT_TYPE_PALETTES color into branding.
   * Used by the batch pipeline so demos have a designed color identity without
   * an AI call. Defaults to false to preserve existing behaviour.
   */
  applyTypePalette?: boolean;
  /**
   * AI-inferred modifier templates from stage 3. When provided, these REPLACE
   * the static preset templates. Each template's name is used as the link key
   * and aiItemTemplateMap maps item names → template name (or null).
   */
  aiModifierTemplates?: Array<{
    name: string;
    sections: Array<{
      name: string;
      min_selections: number;
      max_selections: number;
      modifiers: Array<{ name: string; price: number }>;
    }>;
  }>;
  aiItemTemplateMap?: Record<string, string | null>;
  /**
   * Branding override from stage 4. When provided, these colors override the
   * static type palette.
   */
  brandingOverride?: {
    background_color?: string;
    buttons_background_color?: string;
    buttons_font_color?: string;
  };
}

/** Build AI-inferred modifier templates + wire them to items by name. */
function assignAiModifiers(
  items: ItemNode[],
  aiTemplates: NonNullable<BuildDesignConfigOptions["aiModifierTemplates"]>,
  itemMap: Record<string, string | null>,
  restaurantType: RestaurantType,
): { items: ItemNode[]; modifierTemplates: ModifierTemplateNode[] } {
  const templatesByName = new Map<string, ModifierTemplateNode>();

  for (const t of aiTemplates) {
    const tid = generateId();
    templatesByName.set(t.name, {
      id: tid,
      name: t.name,
      source: "ai",
      restaurantType,
      sections: t.sections.map((s, sIdx) => ({
        id: generateId(),
        name: s.name,
        sortOrder: sIdx,
        minSelections: Math.max(0, s.min_selections ?? 0),
        maxSelections: Math.max(1, s.max_selections ?? 1),
        gridColumns: 6,
        modifiers: s.modifiers.map((m, mIdx) => ({
          id: generateId(),
          name: m.name,
          price: m.price ?? 0,
          sortOrder: mIdx,
          isDefault: false,
          imageAssetId: null,
          posImagePath: null,
          isPizzaCrust: false,
          isPizzaTopping: false,
          isBarMixer: false,
          isBarDrink: false,
        })),
      })),
    });
  }

  const wiredItems = items.map((item) => {
    const templateName = itemMap[item.name];
    if (!templateName) return item;
    const tmpl = templatesByName.get(templateName);
    if (!tmpl) return item;
    return { ...item, modifierTemplateIds: [tmpl.id] };
  });

  return { items: wiredItems, modifierTemplates: Array.from(templatesByName.values()) };
}

export function buildDesignConfig(opts: BuildDesignConfigOptions): DesignConfigV2 {
  const typePreset = TYPE_PRESETS[opts.restaurantType];
  const layoutKey = opts.layoutKey ?? typePreset.layoutKey;
  const templateKeys = opts.templateKeys ?? typePreset.templateKeys;

  const { groups, items: rawItems } = buildGroupsAndItems(opts.payload);
  const { items, modifierTemplates } =
    opts.aiModifierTemplates && opts.aiModifierTemplates.length > 0
      ? assignAiModifiers(
          rawItems,
          opts.aiModifierTemplates,
          opts.aiItemTemplateMap ?? {},
          opts.restaurantType,
        )
      : assignModifiers(groups, rawItems, templateKeys);
  const rooms = loadRooms(layoutKey);

  const state = {
    ...createEmptyDesignState(),
    restaurantName: opts.payload.restaurant_name ?? "",
    restaurantType: opts.restaurantType,
    groups,
    items,
    rooms,
  };

  const config = serializeDesignConfig(state, modifierTemplates);

  if (opts.applyTypePalette) {
    const palette = RESTAURANT_TYPE_PALETTES[opts.restaurantType];
    config.branding = {
      ...config.branding,
      buttons_background_color: palette.buttons_background_color,
      buttons_font_color: palette.buttons_font_color,
    };
  }

  if (opts.brandingOverride) {
    config.branding = {
      ...config.branding,
      ...(opts.brandingOverride.background_color && {
        background: opts.brandingOverride.background_color,
      }),
      ...(opts.brandingOverride.buttons_background_color && {
        buttons_background_color: opts.brandingOverride.buttons_background_color,
      }),
      ...(opts.brandingOverride.buttons_font_color && {
        buttons_font_color: opts.brandingOverride.buttons_font_color,
      }),
    };
  }

  return config;
}
