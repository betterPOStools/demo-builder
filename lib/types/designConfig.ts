// DesignConfig v2.0 — output format for Scaffold SQL generation
// Ported from template-builder/src/types/designConfig.ts

export interface DesignConfigV2 {
  version: "2.0";
  restaurant_name: string | null;
  groups: DesignConfigGroup[];
  items: DesignConfigItem[];
  modifier_templates: DesignConfigModifierTemplate[];
  rooms: DesignConfigRoom[];
  branding: DesignConfigBranding;
  station_settings: DesignConfigStationSettings;
}

export interface DesignConfigGroup {
  id: string;
  name: string;
  category: "Food" | "Beverages" | "Bar";
  image_path: string | null;
  image_url: string | null;
  color: string | null;
}

export interface DesignConfigItem {
  name: string;
  price: number;
  group_id: string;
  modifier_template_ids: string[];
  print_at: number | null;
  active: boolean;
  tax1: boolean;
  tax2: boolean;
  tax3: boolean;
  is_bar_item: boolean;
  is_weighted: boolean;
  is_open_price: boolean;
  barcode: string | null;
  dine_in_price: number | null;
  bar_price: number | null;
  pick_up_price: number | null;
  take_out_price: number | null;
  delivery_price: number | null;
  image_path: string | null;
  image_url: string | null;
  color: string | null;
}

export interface DesignConfigModifierTemplate {
  id: string;
  name: string;
  sections: DesignConfigModifierSection[];
}

export interface DesignConfigModifierSection {
  name: string;
  min_selections: number;
  max_selections: number;
  modifiers: DesignConfigModifier[];
}

export interface DesignConfigModifier {
  name: string;
  price: number;
  preselected: boolean;
  is_pizza_crust: boolean;
  is_pizza_topping: boolean;
  is_bar_mixer: boolean;
  is_bar_drink: boolean;
  image_path: string | null;
  image_url: string | null;
}

export interface DesignConfigRoom {
  name: string;
  color: string;
  grid_size: number;
  tables: DesignConfigTable[];
}

export interface DesignConfigTable {
  name: string;
  seats: number;
  is_bar_stool: boolean;
  row_index: number;
  column_index: number;
  color: string | null;
  image_path: string | null;
  image_url: string | null;
}

export interface DesignConfigBranding {
  background: string | null;
  background_url: string | null;
  background_picture: string | null;
  buttons_background_color: string | null;
  buttons_font_color: string | null;
  sidebar_picture: string | null;
  sidebar_picture_url: string | null;
}

export interface DesignConfigStationSettings {
  enable_dine_in: boolean;
  enable_pick_up: boolean;
  enable_take_out: boolean;
  enable_bar: boolean;
  enable_delivery: boolean;
  dine_in_order: number;
  pick_up_order: number;
  take_out_order: number;
  bar_order: number;
  delivery_order: number;
  sidebar_picture: string | null;
}
