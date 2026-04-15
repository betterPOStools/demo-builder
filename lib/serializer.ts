// Ported from template-builder/src/lib/serializer.ts
// Transforms internal DesignState + ModifierTemplateNode[] into DesignConfigV2

import type { DesignState, BrandAssetNode } from "@/lib/types/design";
import type { ModifierTemplateNode } from "@/lib/types/modifiers";
import type {
  DesignConfigV2,
  DesignConfigBranding,
  DesignConfigStationSettings,
} from "@/lib/types/designConfig";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const BRAND_ASSETS_BUCKET = "brand-assets";

function buildPublicUrl(storagePath: string): string | null {
  if (!SUPABASE_URL) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${BRAND_ASSETS_BUCKET}/${storagePath}`;
}

function resolveImageUrl(
  assetId: string | null,
  assetMap: Map<string, BrandAssetNode>,
): string | null {
  if (!assetId) return null;
  const asset = assetMap.get(assetId);
  if (!asset) return null;
  return buildPublicUrl(asset.storagePath);
}

// --- Validation ---

export interface ValidationError {
  severity: "error" | "warning";
  message: string;
}

export function validateDesign(
  state: DesignState,
  templates: ModifierTemplateNode[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const groupIds = new Set(state.groups.map((g) => g.id));
  const templateIds = new Set(templates.map((t) => t.id));
  const templateNames = new Map<string, number>();

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];

    if (!item.name.trim()) {
      errors.push({
        severity: "error",
        message: `Item at position ${i + 1} has no name`,
      });
    }

    if (!groupIds.has(item.groupId)) {
      errors.push({
        severity: "error",
        message: `Item '${item.name}' references non-existent group`,
      });
    }

    for (const tid of item.modifierTemplateIds) {
      if (!templateIds.has(tid)) {
        errors.push({
          severity: "warning",
          message: `Item '${item.name}' references missing template, will be removed`,
        });
      }
    }
  }

  const validCategories = new Set(["Food", "Beverages", "Bar"]);
  for (const group of state.groups) {
    if (!validCategories.has(group.category)) {
      errors.push({
        severity: "error",
        message: `Group '${group.name}' has invalid category '${group.category}'`,
      });
    }
  }

  for (const t of templates) {
    const lower = t.name.toLowerCase();
    templateNames.set(lower, (templateNames.get(lower) ?? 0) + 1);
  }
  for (const [name, count] of templateNames) {
    if (count > 1) {
      errors.push({
        severity: "error",
        message: `Duplicate template name: '${name}'`,
      });
    }
  }

  for (const t of templates) {
    for (const s of t.sections) {
      if (s.minSelections >= 1 && !s.modifiers.some((m) => m.isDefault)) {
        errors.push({
          severity: "warning",
          message: `Section '${s.name}' in template '${t.name}' is forced but has no default modifier`,
        });
      }
    }
  }

  if (state.items.length === 0) {
    errors.push({
      severity: "warning",
      message: "Design has no menu items",
    });
  }

  return errors;
}

// --- Serialization ---

export function serializeDesignConfig(
  state: DesignState,
  templates: ModifierTemplateNode[],
  branding?: DesignConfigBranding,
  brandAssets?: BrandAssetNode[],
): DesignConfigV2 {
  const templateIds = new Set(templates.map((t) => t.id));

  const resolvedBranding: DesignConfigBranding = branding ?? {
    background: null,
    background_url: null,
    background_picture: null,
    buttons_background_color: null,
    buttons_font_color: null,
    sidebar_picture: null,
    sidebar_picture_url: null,
  };

  const stationSettings: DesignConfigStationSettings = {
    enable_dine_in: true,
    enable_pick_up: true,
    enable_take_out: true,
    enable_bar: true,
    enable_delivery: true,
    dine_in_order: 0,
    pick_up_order: 1,
    take_out_order: 2,
    bar_order: 3,
    delivery_order: 4,
    sidebar_picture: resolvedBranding.sidebar_picture ?? null,
  };

  const assetMap = new Map<string, BrandAssetNode>();
  for (const asset of brandAssets ?? []) {
    assetMap.set(asset.id, asset);
  }

  return {
    version: "2.0",
    restaurant_name: state.restaurantName || null,
    groups: state.groups.map((g) => ({
      id: g.id,
      name: g.name,
      category: g.category,
      image_path: g.posImagePath ?? null,
      image_url: resolveImageUrl(g.imageAssetId, assetMap),
      color: g.color ?? null,
    })),
    items: state.items.map((item) => ({
      name: item.name,
      price: item.defaultPrice,
      group_id: item.groupId,
      modifier_template_ids: item.modifierTemplateIds.filter((id) =>
        templateIds.has(id),
      ),
      print_at: item.printAt || null,
      active: item.active,
      tax1: item.tax1,
      tax2: item.tax2,
      tax3: item.tax3,
      is_bar_item: item.isBarItem,
      is_weighted: item.isWeighted,
      is_open_price: item.isOpenPrice,
      barcode: item.barcode || null,
      dine_in_price: item.dineInPrice || null,
      bar_price: item.barPrice || null,
      pick_up_price: item.pickUpPrice || null,
      take_out_price: item.takeOutPrice || null,
      delivery_price: item.deliveryPrice || null,
      image_path: item.posImagePath ?? null,
      image_url: resolveImageUrl(item.imageAssetId, assetMap),
      color: item.color ?? null,
      description: item.description ?? null,
    })),
    modifier_templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      sections: t.sections.map((s) => ({
        name: s.name,
        min_selections: s.minSelections,
        max_selections: s.maxSelections,
        modifiers: s.modifiers.map((m) => ({
          name: m.name,
          price: m.price,
          preselected: m.isDefault,
          is_pizza_crust: m.isPizzaCrust,
          is_pizza_topping: m.isPizzaTopping,
          is_bar_mixer: m.isBarMixer,
          is_bar_drink: m.isBarDrink,
          image_path: m.posImagePath ?? null,
          image_url: resolveImageUrl(m.imageAssetId, assetMap),
        })),
      })),
    })),
    rooms: state.rooms.map((r) => ({
      name: r.name,
      color: r.color,
      grid_size: r.gridSize,
      tables: r.tables.map((t) => ({
        name: t.name,
        seats: t.seats,
        is_bar_stool: t.isBarStool,
        row_index: t.rowIndex ?? 0,
        column_index: t.columnIndex ?? 0,
        color: t.color ?? null,
        image_path: t.posImagePath ?? null,
        image_url: resolveImageUrl(t.imageAssetId, assetMap),
      })),
    })),
    branding: resolvedBranding,
    station_settings: stationSettings,
  };
}
