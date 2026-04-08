import type { StateCreator } from "zustand";
import type { MenuRow, ExtractedModifierTemplate, ExtractedGraphic } from "@/lib/types";

export interface FileQueueItem {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  status: "pending" | "processing" | "done" | "error";
  error?: string;
  thumbnailUrl?: string;
}

export interface ExtractionSlice {
  // File queue
  files: FileQueueItem[];
  addFiles: (files: File[]) => void;
  removeFile: (id: string) => void;
  reorderFiles: (fileIds: string[]) => void;
  updateFileStatus: (id: string, status: FileQueueItem["status"], error?: string) => void;
  clearFiles: () => void;

  // Processing
  isProcessing: boolean;
  setProcessing: (v: boolean) => void;

  // Results
  extractedRows: MenuRow[];
  extractedModifiers: ExtractedModifierTemplate[];
  extractedGraphics: ExtractedGraphic[];
  restaurantType: string | null;
  setExtractionResults: (results: {
    rows: MenuRow[];
    modifierTemplates?: ExtractedModifierTemplate[];
    restaurantType?: string | null;
    graphics?: ExtractedGraphic[];
  }) => void;
  appendRows: (rows: MenuRow[]) => void;
  updateRow: (index: number, col: string, value: string) => void;
  deleteRow: (index: number) => void;
  clearResults: () => void;

  // Restaurant name
  restaurantName: string;
  setRestaurantName: (name: string) => void;
}

export const createExtractionSlice: StateCreator<ExtractionSlice> = (set) => ({
  files: [],
  addFiles: (newFiles) =>
    set((state) => {
      // Sort new files alphanumerically by name (natural sort for page ordering)
      const sorted = [...newFiles].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      );
      const newItems: FileQueueItem[] = sorted.map((f) => {
        const isImage = f.type.startsWith("image/");
        return {
          id: crypto.randomUUID(),
          file: f,
          name: f.name,
          type: f.type || f.name.split(".").pop() || "unknown",
          size: f.size,
          status: "pending" as const,
          thumbnailUrl: isImage ? URL.createObjectURL(f) : undefined,
        };
      });
      return { files: [...state.files, ...newItems] };
    }),
  removeFile: (id) =>
    set((state) => {
      const file = state.files.find((f) => f.id === id);
      if (file?.thumbnailUrl) URL.revokeObjectURL(file.thumbnailUrl);
      return { files: state.files.filter((f) => f.id !== id) };
    }),
  reorderFiles: (fileIds) =>
    set((state) => {
      const map = new Map(state.files.map((f) => [f.id, f]));
      const reordered = fileIds.map((id) => map.get(id)).filter(Boolean) as FileQueueItem[];
      return { files: reordered };
    }),
  updateFileStatus: (id, status, error) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, status, error } : f,
      ),
    })),
  clearFiles: () =>
    set((state) => {
      state.files.forEach((f) => { if (f.thumbnailUrl) URL.revokeObjectURL(f.thumbnailUrl); });
      return { files: [] };
    }),

  isProcessing: false,
  setProcessing: (v) => set({ isProcessing: v }),

  extractedRows: [],
  extractedModifiers: [],
  extractedGraphics: [],
  restaurantType: null,
  setExtractionResults: ({ rows, modifierTemplates, restaurantType, graphics }) =>
    set({
      extractedRows: rows,
      extractedModifiers: modifierTemplates ?? [],
      restaurantType: restaurantType ?? null,
      extractedGraphics: graphics ?? [],
    }),
  appendRows: (rows) =>
    set((state) => ({ extractedRows: [...state.extractedRows, ...rows] })),
  updateRow: (index, col, value) =>
    set((state) => ({
      extractedRows: state.extractedRows.map((row, i) =>
        i === index ? { ...row, [col]: value } : row,
      ),
    })),
  deleteRow: (index) =>
    set((state) => ({
      extractedRows: state.extractedRows.filter((_, i) => i !== index),
    })),
  clearResults: () =>
    set({
      extractedRows: [],
      extractedModifiers: [],
      extractedGraphics: [],
      restaurantType: null,
    }),

  restaurantName: "",
  setRestaurantName: (name) => set({ restaurantName: name, isDirty: true } as Partial<ExtractionSlice>),
});
