// 20-column POS menu item schema
// Ported from adv-menu-import/lib/types/menu.ts

export const COLUMNS = [
  "Menu Item Full Name",
  "Menu Item Group",
  "Menu Item Category",
  "Menu Item Description",
  "Default Price",
  "Dine In Price",
  "Bar Price",
  "Pick Up Price",
  "Take Out Price",
  "Delivery Price",
  "Open Price Item",
  "POS Orders Print At",
  "Tax 1",
  "Tax 2",
  "Tax 3",
  "This Is A Bar Item",
  "This Is A Weighted Item",
  "Tare",
  "Barcode",
  "Item Folder",
  "Belongs To Item Folder",
] as const;

export type ColumnName = (typeof COLUMNS)[number];

export const EXTRACTABLE_COLS = [
  "Menu Item Full Name",
  "Menu Item Group",
  "Menu Item Category",
  "Default Price",
  "Dine In Price",
  "Bar Price",
  "Pick Up Price",
  "Take Out Price",
  "Delivery Price",
] as const;

export const BOOLEAN_COLS = new Set([
  "Open Price Item",
  "This Is A Bar Item",
  "This Is A Weighted Item",
  "Item Folder",
]);

export type MenuCategory = "Food" | "Beverages" | "Bar";

export type MenuRow = Record<ColumnName, string>;

export interface MenuItemsPayload {
  version: string;
  source: string;
  restaurant_name: string;
  extraction_id: string;
  extracted_at: string;
  item_count: number;
  items: MenuRow[];
}

export interface ExtractedModifierTemplate {
  name: string;
  sections: {
    name: string;
    min_selections: number;
    max_selections: number;
    modifiers: { name: string; price: number }[];
  }[];
}

export interface ExtractionResult {
  rows: MenuRow[];
  modifierTemplates: ExtractedModifierTemplate[];
  restaurantType: string | null;
  graphics: ExtractedGraphic[];
  suggestedName: string | null;
}

export interface ExtractedGraphic {
  name: string;
  type: "logo" | "icon" | "photo" | "illustration" | "decoration" | "downloaded";
  description: string;
  mimeType?: string;
  base64?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}
