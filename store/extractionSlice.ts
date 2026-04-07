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
}

export interface ExtractionSlice {
  // File queue
  files: FileQueueItem[];
  addFiles: (files: File[]) => void;
  removeFile: (id: string) => void;
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
    set((state) => ({
      files: [
        ...state.files,
        ...newFiles.map((f) => ({
          id: crypto.randomUUID(),
          file: f,
          name: f.name,
          type: f.type || f.name.split(".").pop() || "unknown",
          size: f.size,
          status: "pending" as const,
        })),
      ],
    })),
  removeFile: (id) =>
    set((state) => ({ files: state.files.filter((f) => f.id !== id) })),
  updateFileStatus: (id, status, error) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, status, error } : f,
      ),
    })),
  clearFiles: () => set({ files: [] }),

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
