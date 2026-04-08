import { create } from "zustand";
import { createExtractionSlice, type ExtractionSlice } from "./extractionSlice";
import { createDesignSlice, type DesignSlice } from "./designSlice";
import { createModifierSlice, type ModifierSlice } from "./modifierSlice";
import { createDeploySlice, type DeploySlice } from "./deploySlice";

export interface SessionSlice {
  currentStep: number;
  setCurrentStep: (step: number) => void;
  hydratedSessionId: string | null;
  hydrateFromSession: (sessionId: string, data: Record<string, unknown>) => void;
  resetForNewProject: () => void;
}

export type StoreState = ExtractionSlice &
  DesignSlice &
  ModifierSlice &
  DeploySlice &
  SessionSlice;

export const useStore = create<StoreState>()((...a) => ({
  ...createExtractionSlice(...a),
  ...createDesignSlice(...a),
  ...createModifierSlice(...a),
  ...createDeploySlice(...a),

  // Session
  currentStep: 1,
  setCurrentStep: (step) => a[0]({ currentStep: step }),
  hydratedSessionId: null,

  resetForNewProject: () => {
    const [set] = a;
    set({
      // Session
      hydratedSessionId: null,
      currentStep: 1,
      // Extraction
      extractedRows: [],
      extractedModifiers: [],
      extractedGraphics: [],
      restaurantName: "",
      restaurantType: null,
      files: [],
      isProcessing: false,
      // Design
      groups: [],
      items: [],
      rooms: [],
      branding: {
        background: null,
        background_picture: null,
        buttons_background_color: null,
        buttons_font_color: null,
        sidebar_picture: null,
      },
      imageLibrary: [],
      designOrigin: { type: "fresh" },
      isDirty: false,
      // Modifiers
      modifierTemplates: [],
      // Deploy
      deployStatus: "idle",
      deployResult: null,
      generatedSql: null,
      deployStats: null,
      pendingImages: [],
    } as Partial<StoreState>);
  },

  hydrateFromSession: (sessionId, data) => {
    const patch: Record<string, unknown> = { hydratedSessionId: sessionId };

    // Extraction data
    if (data.extracted_rows) patch.extractedRows = data.extracted_rows;
    if (data.modifier_suggestions) patch.extractedModifiers = data.modifier_suggestions;
    if (data.restaurant_name) patch.restaurantName = data.restaurant_name;
    if (data.restaurant_type) patch.restaurantType = data.restaurant_type;

    // Design state (groups, items, rooms)
    if (data.design_state) {
      const ds = data.design_state as Record<string, unknown>;
      if (ds.groups) patch.groups = ds.groups;
      if (ds.items) patch.items = ds.items;
      if (ds.rooms) patch.rooms = ds.rooms;
      if (ds.branding) patch.branding = ds.branding;
      if (ds.imageLibrary) patch.imageLibrary = ds.imageLibrary;
      if (ds.designOrigin) patch.designOrigin = ds.designOrigin;
    }

    // Modifier templates
    if (data.modifier_templates) patch.modifierTemplates = data.modifier_templates;

    // Current step
    if (data.current_step) patch.currentStep = data.current_step;

    a[0](patch as Partial<StoreState>);
  },
}));
