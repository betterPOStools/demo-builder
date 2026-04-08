// Ported from pos-scaffold/app/core/design_parser.py
// Converts DesignConfigV2 into deployer-compatible structures.

import type { DesignConfigV2 } from "@/lib/types/designConfig";

// Printer number → column name mapping (POS has 10 kitchen + 1 bar)
const PRINTER_MAP: Record<number, string> = {
  1: "Kitchen Printer 1",
  2: "Kitchen Printer 2",
  3: "Kitchen Printer 3",
  4: "Bar Printer",
};

const PRINTER_COLUMNS: Record<string, string> = {
  "Kitchen Printer 1": "PrintOnKitchenPrinter1",
  "Kitchen Printer 2": "PrintOnKitchenPrinter2",
  "Kitchen Printer 3": "PrintOnKitchenPrinter3",
  "Kitchen Printer 4": "PrintOnKitchenPrinter4",
  "Kitchen Printer 5": "PrintOnKitchenPrinter5",
  "Kitchen Printer 6": "PrintOnKitchenPrinter6",
  "Kitchen Printer 7": "PrintOnKitchenPrinter7",
  "Kitchen Printer 8": "PrintOnKitchenPrinter8",
  "Kitchen Printer 9": "PrintOnKitchenPrinter9",
  "Kitchen Printer 10": "PrintOnKitchenPrinter10",
  "Bar Printer": "PrintOnBarPrinter",
};

function boolToInt(val: boolean): number {
  return val ? 1 : 0;
}

function resolvePrinter(
  printAt: number | null,
): { name: string; flags: Record<string, number> } {
  const flags: Record<string, number> = {};
  for (const col of Object.values(PRINTER_COLUMNS)) {
    flags[col] = 0;
  }

  if (printAt == null) {
    flags["PrintOnKitchenPrinter1"] = 3;
    return { name: "Kitchen Printer 1", flags };
  }

  const name = PRINTER_MAP[printAt] ?? "Kitchen Printer 1";
  const col = PRINTER_COLUMNS[name] ?? "PrintOnKitchenPrinter1";
  flags[col] = 3;
  return { name, flags };
}

// Deployer-compatible item format
export interface ParsedItem {
  name: string;
  group: string;
  category: string;
  default_price: number;
  dine_in_price: number;
  bar_price: number;
  pick_up_price: number;
  take_out_price: number;
  delivery_price: number;
  is_open_price: number;
  print_at: string;
  printers: Record<string, number>;
  tax1: number;
  tax2: number;
  tax3: number;
  is_bar_item: number;
  is_weighted: number;
  tare: number;
  barcode: string | null;
  is_folder: number;
  belongs_to_folder: string | null;
  modifier_template: string | null;
  image_path: string | null;
  image_url: string | null;
  color: string | null;
}

export interface ParsedModifierTemplate {
  name: string;
  sections: {
    name: string;
    min_selections: number;
    max_selections: number;
    modifiers: {
      name: string;
      price: number;
      preselected: boolean;
      is_pizza_crust: boolean;
      is_pizza_topping: boolean;
      is_bar_mixer: boolean;
      is_bar_drink: boolean;
      image_path: string | null;
      image_url: string | null;
      color?: string | null;
    }[];
  }[];
}

export interface GroupMeta {
  image_path: string | null;
  image_url: string | null;
  color: string | null;
}

export interface ParsedDesignConfig {
  items: ParsedItem[];
  groups: Map<string, number>;
  groupMeta: Record<string, GroupMeta>;
  categories: Map<string, number>;
  errors: string[];
  modifierTemplates: ParsedModifierTemplate[];
  templateAssignments: Record<string, string>;
  rooms: { name: string; color: string; grid_size: number; tables: { name: string; capacity: number; is_bar_stool: boolean; row_index: number; column_index: number }[] }[];
  metadata: { restaurant_name: string | null; version: string };
  branding: Record<string, unknown>;
}

export function parseDesignConfig(config: DesignConfigV2): ParsedDesignConfig {
  const items: ParsedItem[] = [];
  const groups = new Map<string, number>();
  const categories = new Map<string, number>();
  const errors: string[] = [];
  const templateAssignments: Record<string, string> = {};

  // Build lookup maps
  const groupMap = new Map(config.groups.map((g) => [g.id, g]));
  const templateMap = new Map(
    config.modifier_templates.map((t) => [t.id, t]),
  );

  // Group metadata
  const groupMeta: Record<string, GroupMeta> = {};
  for (const g of config.groups) {
    groupMeta[g.name] = {
      image_path: g.image_path,
      image_url: g.image_url,
      color: g.color,
    };
  }

  // Process groups → categories and group index
  for (const group of config.groups) {
    if (!groups.has(group.name)) {
      groups.set(group.name, groups.size);
    }
    if (!categories.has(group.category)) {
      categories.set(group.category, categories.size);
    }
  }

  // Process items
  for (const item of config.items) {
    const group = groupMap.get(item.group_id);
    if (!group) {
      errors.push(
        `Item '${item.name}' references unknown group_id '${item.group_id}'`,
      );
      continue;
    }

    const { name: printerName, flags: printerFlags } = resolvePrinter(
      item.print_at,
    );

    const parsedItem: ParsedItem = {
      name: item.name,
      group: group.name,
      category: group.category,
      default_price: item.price,
      dine_in_price: item.dine_in_price || 0,
      bar_price: item.bar_price || 0,
      pick_up_price: item.pick_up_price || 0,
      take_out_price: item.take_out_price || 0,
      delivery_price: item.delivery_price || 0,
      is_open_price: boolToInt(item.is_open_price),
      print_at: printerName,
      printers: printerFlags,
      tax1: boolToInt(item.tax1),
      tax2: boolToInt(item.tax2),
      tax3: boolToInt(item.tax3),
      is_bar_item: boolToInt(item.is_bar_item),
      is_weighted: boolToInt(item.is_weighted),
      tare: 0,
      barcode: item.barcode,
      is_folder: 0,
      belongs_to_folder: null,
      modifier_template: null,
      image_path: item.image_path,
      image_url: item.image_url,
      color: item.color,
    };

    // Track template assignments
    if (item.modifier_template_ids.length > 0) {
      const firstTid = item.modifier_template_ids[0];
      const tmpl = templateMap.get(firstTid);
      if (tmpl) {
        parsedItem.modifier_template = tmpl.name;
        templateAssignments[item.name] = tmpl.name;
        if (!(group.name in templateAssignments)) {
          templateAssignments[group.name] = tmpl.name;
        }
      }
    }

    items.push(parsedItem);
  }

  // Convert modifier templates
  const modifierTemplates: ParsedModifierTemplate[] =
    config.modifier_templates.map((tmpl) => ({
      name: tmpl.name,
      sections: tmpl.sections.map((sec) => ({
        name: sec.name,
        min_selections: sec.min_selections,
        max_selections: sec.max_selections,
        modifiers: sec.modifiers.map((mod) => ({
          name: mod.name,
          price: mod.price,
          preselected: mod.preselected,
          is_pizza_crust: mod.is_pizza_crust,
          is_pizza_topping: mod.is_pizza_topping,
          is_bar_mixer: mod.is_bar_mixer,
          is_bar_drink: mod.is_bar_drink,
          image_path: mod.image_path,
          image_url: mod.image_url,
        })),
      })),
    }));

  // Convert rooms → deployer-compatible format with grid positioning
  const rooms = config.rooms.map((r) => {
    return {
      name: r.name,
      color: r.color,
      grid_size: r.grid_size,
      tables: r.tables.map((t) => ({
        name: t.name,
        capacity: t.seats,
        is_bar_stool: t.is_bar_stool,
        row_index: t.row_index ?? 0,
        column_index: t.column_index ?? 0,
      })),
    };
  });

  return {
    items,
    groups,
    groupMeta,
    categories,
    errors,
    modifierTemplates,
    templateAssignments,
    rooms,
    metadata: {
      restaurant_name: config.restaurant_name,
      version: config.version,
    },
    branding: config.branding as unknown as Record<string, unknown>,
  };
}
