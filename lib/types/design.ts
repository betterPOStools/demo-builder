// Core design state types
// Ported from template-builder/src/types/design.ts

export type CategoryName = "Food" | "Beverages" | "Bar";

export interface DesignOrigin {
  type: "fresh" | "menu_import" | "profile_import";
  importedAt?: string;
}

export interface CategoryNode {
  name: CategoryName;
  sortOrder: number;
}

export interface GroupNode {
  id: string;
  name: string;
  category: CategoryName;
  sortOrder: number;
  color: string | null;
  imageAssetId: string | null;
  posImagePath: string | null;
}

export interface ItemNode {
  id: string;
  name: string;
  groupId: string;
  sortOrder: number;

  // Prices
  defaultPrice: number;
  dineInPrice: number;
  barPrice: number;
  pickUpPrice: number;
  takeOutPrice: number;
  deliveryPrice: number;

  // POS flags
  printAt: number;
  tax1: boolean;
  tax2: boolean;
  tax3: boolean;
  isOpenPrice: boolean;
  isBarItem: boolean;
  isWeighted: boolean;
  tare: number;
  barcode: string | null;
  isFolder: boolean;
  belongsToFolder: string | null;

  // Template Builder additions
  modifierTemplateIds: string[];
  imageAssetId: string | null;
  posImagePath: string | null;
  color: string | null;
  active: boolean;
  description: string | null;
}

export interface RoomNode {
  id: string;
  name: string;
  color: string;
  gridSize: number;
  tables: TableNode[];
}

export interface TableNode {
  id: string;
  name: string;
  seats: number;
  isBarStool: boolean;
  rowIndex: number;
  columnIndex: number;
  color: string | null;
  posImagePath: string | null;
  imageAssetId: string | null;
}

export interface BrandAssetNode {
  id: string;
  name: string;
  type: "icon" | "logo" | "photo";
  mimeType: string;
  storagePath: string;
  assignedTo: string[];
}

export interface DesignState {
  id: string | null;
  name: string;
  restaurantName: string;
  restaurantType: string | null;
  isDirty: boolean;
  origin: DesignOrigin;
  categories: CategoryNode[];
  groups: GroupNode[];
  items: ItemNode[];
  brandAssets: BrandAssetNode[];
  rooms: RoomNode[];
}

export interface ImportedMenuItem {
  name: string;
  group: string;
  category: CategoryName;
  defaultPrice: number;
  dineInPrice: number;
  barPrice: number;
  pickUpPrice: number;
  takeOutPrice: number;
  deliveryPrice: number;
  isOpenPrice: boolean;
  printAt: number;
  tax1: boolean;
  tax2: boolean;
  tax3: boolean;
  isBarItem: boolean;
  isWeighted: boolean;
  tare: number;
  barcode: string | null;
  isFolder: boolean;
  belongsToFolder: string | null;
  description: string | null;
}

export const DEFAULT_CATEGORIES: CategoryNode[] = [
  { name: "Food", sortOrder: 0 },
  { name: "Beverages", sortOrder: 1 },
  { name: "Bar", sortOrder: 2 },
];

export function createEmptyDesignState(): DesignState {
  return {
    id: null,
    name: "Untitled",
    restaurantName: "",
    restaurantType: null,
    isDirty: false,
    origin: { type: "fresh" },
    categories: [...DEFAULT_CATEGORIES],
    groups: [],
    items: [],
    brandAssets: [],
    rooms: [],
  };
}
