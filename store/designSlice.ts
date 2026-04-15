import type { StateCreator } from "zustand";
import type {
  CategoryName,
  GroupNode,
  ItemNode,
  RoomNode,
  TableNode,
  DesignOrigin,
  ImportedMenuItem,
} from "@/lib/types";
import { DEFAULT_CATEGORIES } from "@/lib/types/design";
import { LAYOUT_PRESETS } from "@/lib/sql/layout";
import { generateId } from "@/lib/utils";

export interface BrandingState {
  background: string | null;
  background_picture: string | null;
  buttons_background_color: string | null;
  buttons_font_color: string | null;
  sidebar_picture: string | null;
}

export interface GeneratedImage {
  id: string;
  type: "sidebar" | "background" | "item";
  dataUri: string; // PNG data URI
  createdAt: string;
  restaurantName?: string;
  itemName?: string; // for type "item" — which menu item this was generated for
  seamlessId?: string; // shared ID linking the sidebar+background pair from a seamless generation
  // Concept tagging for smart library reuse
  conceptTags?: string[];
  cuisineType?: string;
  foodCategory?: string;
  visualDescription?: string;
  generatedFor?: string; // restaurant name at time of generation
}

export interface SavedBrandAnalysis {
  id: string;
  createdAt: string;
  brandName: string;
  sourceType: "url" | "image";
  sourceLabel: string; // domain for URL, "Photo" for image
  thumbnailDataUri: string | null; // resized image for uploads; null for URL
  tokens: Record<string, unknown>;
}

export interface DesignSlice {
  // State
  groups: GroupNode[];
  items: ItemNode[];
  rooms: RoomNode[];
  branding: BrandingState;
  imageLibrary: GeneratedImage[];
  brandAnalyses: SavedBrandAnalysis[];
  designOrigin: DesignOrigin;
  isDirty: boolean;

  // Import from extraction
  importExtractedData: (
    importedItems: ImportedMenuItem[],
    restaurantName: string,
  ) => void;

  // Group operations
  addGroup: (name: string, category: CategoryName) => void;
  renameGroup: (groupId: string, name: string) => void;
  updateGroup: (groupId: string, changes: Partial<GroupNode>) => void;
  deleteGroup: (groupId: string) => void;
  moveGroup: (groupId: string, category: CategoryName) => void;
  reorderGroups: (category: CategoryName, groupIds: string[]) => void;

  // Item operations
  addItem: (groupId: string, name: string, defaultPrice: number) => void;
  updateItem: (itemId: string, changes: Partial<ItemNode>) => void;
  deleteItem: (itemId: string) => void;
  moveItem: (itemId: string, targetGroupId: string) => void;
  reorderItems: (groupId: string, itemIds: string[]) => void;

  // Template assignment
  addTemplateToItems: (itemIds: string[], templateId: string) => void;
  removeTemplateFromItems: (itemIds: string[], templateId: string) => void;

  // Room operations
  loadRoomsFromPreset: (presetKey: string) => void;
  addRoom: (name: string, color: string) => void;
  updateRoom: (roomId: string, changes: Partial<RoomNode>) => void;
  deleteRoom: (roomId: string) => void;
  addTable: (roomId: string, name: string, seats: number) => void;
  updateTable: (
    roomId: string,
    tableId: string,
    changes: Partial<TableNode>,
  ) => void;
  deleteTable: (roomId: string, tableId: string) => void;

  // Branding
  updateBranding: (changes: Partial<BrandingState>) => void;

  // Image library
  addGeneratedImage: (image: GeneratedImage) => void;
  deleteGeneratedImage: (imageId: string) => void;
  clearImageLibrary: (type?: GeneratedImage["type"]) => void;

  // Brand analyses
  saveBrandAnalysis: (analysis: SavedBrandAnalysis) => void;
  deleteBrandAnalysis: (id: string) => void;

  // Clear
  clearDesign: () => void;
}

const DEFAULT_BRANDING: BrandingState = {
  background: null,
  background_picture: null,
  buttons_background_color: null,
  buttons_font_color: null,
  sidebar_picture: null,
};

export const createDesignSlice: StateCreator<DesignSlice> = (set) => ({
  groups: [],
  items: [],
  rooms: [],
  branding: { ...DEFAULT_BRANDING },
  imageLibrary: [],
  brandAnalyses: [],
  designOrigin: { type: "fresh" },
  isDirty: false,

  importExtractedData: (importedItems, restaurantName) =>
    set(() => {
      const groupMap = new Map<string, GroupNode>();
      const items: ItemNode[] = [];
      let groupSortCounter: Record<CategoryName, number> = {
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
            sortOrder: groupSortCounter[mi.category]++,
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
          description: mi.description ?? null,
        });
      }

      return {
        groups: Array.from(groupMap.values()),
        items,
        rooms: [],
        designOrigin: {
          type: "menu_import" as const,
          importedAt: new Date().toISOString(),
        },
        restaurantName,
        isDirty: true,
      };
    }),

  addGroup: (name, category) =>
    set((state) => {
      const groupsInCat = state.groups.filter((g) => g.category === category);
      return {
        groups: [
          ...state.groups,
          {
            id: generateId(),
            name,
            category,
            sortOrder: groupsInCat.length,
            color: null,
            imageAssetId: null,
            posImagePath: null,
          },
        ],
        isDirty: true,
      };
    }),

  renameGroup: (groupId, name) =>
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId ? { ...g, name } : g,
      ),
      isDirty: true,
    })),

  updateGroup: (groupId, changes) =>
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId ? { ...g, ...changes } : g,
      ),
      isDirty: true,
    })),

  deleteGroup: (groupId) =>
    set((state) => ({
      groups: state.groups.filter((g) => g.id !== groupId),
      items: state.items.filter((i) => i.groupId !== groupId),
      isDirty: true,
    })),

  moveGroup: (groupId, category) =>
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId ? { ...g, category } : g,
      ),
      isDirty: true,
    })),

  reorderGroups: (category, groupIds) =>
    set((state) => ({
      groups: state.groups.map((g) => {
        if (g.category !== category) return g;
        const idx = groupIds.indexOf(g.id);
        return idx >= 0 ? { ...g, sortOrder: idx } : g;
      }),
      isDirty: true,
    })),

  addItem: (groupId, name, defaultPrice) =>
    set((state) => {
      const itemsInGroup = state.items.filter((i) => i.groupId === groupId);
      return {
        items: [
          ...state.items,
          {
            id: generateId(),
            name,
            groupId,
            sortOrder: itemsInGroup.length,
            defaultPrice,
            dineInPrice: 0,
            barPrice: 0,
            pickUpPrice: 0,
            takeOutPrice: 0,
            deliveryPrice: 0,
            printAt: 1,
            tax1: false,
            tax2: false,
            tax3: false,
            isOpenPrice: false,
            isBarItem: false,
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
          },
        ],
        isDirty: true,
      };
    }),

  updateItem: (itemId, changes) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.id === itemId ? { ...i, ...changes } : i,
      ),
      isDirty: true,
    })),

  deleteItem: (itemId) =>
    set((state) => ({
      items: state.items.filter((i) => i.id !== itemId),
      isDirty: true,
    })),

  moveItem: (itemId, targetGroupId) =>
    set((state) => {
      const itemsInTarget = state.items.filter(
        (i) => i.groupId === targetGroupId,
      );
      return {
        items: state.items.map((i) =>
          i.id === itemId
            ? { ...i, groupId: targetGroupId, sortOrder: itemsInTarget.length }
            : i,
        ),
        isDirty: true,
      };
    }),

  reorderItems: (groupId, itemIds) =>
    set((state) => ({
      items: state.items.map((i) => {
        if (i.groupId !== groupId) return i;
        const idx = itemIds.indexOf(i.id);
        return idx >= 0 ? { ...i, sortOrder: idx } : i;
      }),
      isDirty: true,
    })),

  addTemplateToItems: (itemIds, templateId) =>
    set((state) => ({
      items: state.items.map((i) =>
        itemIds.includes(i.id) && !i.modifierTemplateIds.includes(templateId)
          ? { ...i, modifierTemplateIds: [...i.modifierTemplateIds, templateId] }
          : i,
      ),
      isDirty: true,
    })),

  removeTemplateFromItems: (itemIds, templateId) =>
    set((state) => ({
      items: state.items.map((i) =>
        itemIds.includes(i.id)
          ? {
              ...i,
              modifierTemplateIds: i.modifierTemplateIds.filter(
                (id) => id !== templateId,
              ),
            }
          : i,
      ),
      isDirty: true,
    })),

  loadRoomsFromPreset: (presetKey) =>
    set(() => {
      const preset = LAYOUT_PRESETS[presetKey];
      if (!preset) return {};
      return {
        rooms: preset.rooms.map((r) => ({
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
        })),
        isDirty: true,
      };
    }),

  addRoom: (name, color) =>
    set((state) => ({
      rooms: [
        ...state.rooms,
        {
          id: generateId(),
          name,
          color,
          gridSize: 1,
          tables: [],
        },
      ],
      isDirty: true,
    })),

  updateRoom: (roomId, changes) =>
    set((state) => ({
      rooms: state.rooms.map((r) =>
        r.id === roomId ? { ...r, ...changes } : r,
      ),
      isDirty: true,
    })),

  deleteRoom: (roomId) =>
    set((state) => ({
      rooms: state.rooms.filter((r) => r.id !== roomId),
      isDirty: true,
    })),

  addTable: (roomId, name, seats) =>
    set((state) => ({
      rooms: state.rooms.map((r) =>
        r.id === roomId
          ? {
              ...r,
              tables: [
                ...r.tables,
                {
                  id: generateId(),
                  name,
                  seats,
                  isBarStool: false,
                  rowIndex: 0,
                  columnIndex: 0,
                  color: null,
                  posImagePath: null,
                  imageAssetId: null,
                },
              ],
            }
          : r,
      ),
      isDirty: true,
    })),

  updateTable: (roomId, tableId, changes) =>
    set((state) => ({
      rooms: state.rooms.map((r) =>
        r.id === roomId
          ? {
              ...r,
              tables: r.tables.map((t) =>
                t.id === tableId ? { ...t, ...changes } : t,
              ),
            }
          : r,
      ),
      isDirty: true,
    })),

  deleteTable: (roomId, tableId) =>
    set((state) => ({
      rooms: state.rooms.map((r) =>
        r.id === roomId
          ? { ...r, tables: r.tables.filter((t) => t.id !== tableId) }
          : r,
      ),
      isDirty: true,
    })),

  updateBranding: (changes) =>
    set((state) => ({
      branding: { ...state.branding, ...changes },
      isDirty: true,
    })),

  addGeneratedImage: (image) =>
    set((state) => ({
      imageLibrary: [image, ...state.imageLibrary],
      isDirty: true,
    })),

  deleteGeneratedImage: (imageId) =>
    set((state) => ({
      imageLibrary: state.imageLibrary.filter((i) => i.id !== imageId),
      isDirty: true,
    })),

  clearImageLibrary: (type) =>
    set((state) => ({
      imageLibrary: type
        ? state.imageLibrary.filter((i) => i.type !== type)
        : [],
      isDirty: true,
    })),

  saveBrandAnalysis: (analysis) =>
    set((state) => ({
      brandAnalyses: [
        analysis,
        ...state.brandAnalyses.filter((a) => a.id !== analysis.id),
      ].slice(0, 20), // keep most recent 20
    })),

  deleteBrandAnalysis: (id) =>
    set((state) => ({
      brandAnalyses: state.brandAnalyses.filter((a) => a.id !== id),
    })),

  clearDesign: () =>
    set({
      groups: [],
      items: [],
      rooms: [],
      branding: { ...DEFAULT_BRANDING },
      imageLibrary: [],
      designOrigin: { type: "fresh" },
      isDirty: false,
    }),
});
