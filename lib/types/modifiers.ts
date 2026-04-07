// Modifier template types
// Ported from template-builder/src/types/modifiers.ts

export interface ModifierTemplateNode {
  id: string;
  name: string;
  sections: ModifierSectionNode[];
  source: "manual" | "ai" | "preset" | "import";
  restaurantType: string | null;
}

export interface ModifierSectionNode {
  id: string;
  name: string;
  sortOrder: number;
  minSelections: number;
  maxSelections: number;
  gridColumns: number;
  modifiers: ModifierNode[];
}

export interface ModifierNode {
  id: string;
  name: string;
  price: number;
  sortOrder: number;
  isDefault: boolean;
  imageAssetId: string | null;
  posImagePath: string | null;
  isPizzaCrust: boolean;
  isPizzaTopping: boolean;
  isBarMixer: boolean;
  isBarDrink: boolean;
}
