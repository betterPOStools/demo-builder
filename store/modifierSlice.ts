import type { StateCreator } from "zustand";
import type {
  ModifierTemplateNode,
  ModifierSectionNode,
  ModifierNode,
} from "@/lib/types";
import { generateId } from "@/lib/utils";

export interface ModifierSlice {
  modifierTemplates: ModifierTemplateNode[];

  // Template CRUD
  addTemplate: (name: string) => string;
  deleteTemplate: (templateId: string) => void;
  renameTemplate: (templateId: string, name: string) => void;

  // Section CRUD
  addSection: (templateId: string, name: string) => void;
  updateSection: (
    templateId: string,
    sectionId: string,
    changes: Partial<ModifierSectionNode>,
  ) => void;
  deleteSection: (templateId: string, sectionId: string) => void;

  // Modifier CRUD
  addModifier: (
    templateId: string,
    sectionId: string,
    name: string,
    price: number,
  ) => void;
  updateModifier: (
    templateId: string,
    sectionId: string,
    modifierId: string,
    changes: Partial<ModifierNode>,
  ) => void;
  deleteModifier: (
    templateId: string,
    sectionId: string,
    modifierId: string,
  ) => void;

  // Bulk
  loadTemplates: (templates: ModifierTemplateNode[]) => void;
  clearTemplates: () => void;
}

export const createModifierSlice: StateCreator<ModifierSlice> = (set) => ({
  modifierTemplates: [],

  addTemplate: (name) => {
    const id = generateId();
    set((state) => ({
      modifierTemplates: [
        ...state.modifierTemplates,
        {
          id,
          name,
          sections: [],
          source: "manual" as const,
          restaurantType: null,
        },
      ],
    }));
    return id;
  },

  deleteTemplate: (templateId) =>
    set((state) => ({
      modifierTemplates: state.modifierTemplates.filter(
        (t) => t.id !== templateId,
      ),
    })),

  renameTemplate: (templateId, name) =>
    set((state) => ({
      modifierTemplates: state.modifierTemplates.map((t) =>
        t.id === templateId ? { ...t, name } : t,
      ),
    })),

  addSection: (templateId, name) =>
    set((state) => ({
      modifierTemplates: state.modifierTemplates.map((t) => {
        if (t.id !== templateId) return t;
        return {
          ...t,
          sections: [
            ...t.sections,
            {
              id: generateId(),
              name,
              sortOrder: t.sections.length,
              minSelections: 0,
              maxSelections: 1,
              gridColumns: 3,
              modifiers: [],
            },
          ],
        };
      }),
    })),

  updateSection: (templateId, sectionId, changes) =>
    set((state) => ({
      modifierTemplates: state.modifierTemplates.map((t) => {
        if (t.id !== templateId) return t;
        return {
          ...t,
          sections: t.sections.map((s) =>
            s.id === sectionId ? { ...s, ...changes } : s,
          ),
        };
      }),
    })),

  deleteSection: (templateId, sectionId) =>
    set((state) => ({
      modifierTemplates: state.modifierTemplates.map((t) => {
        if (t.id !== templateId) return t;
        return {
          ...t,
          sections: t.sections.filter((s) => s.id !== sectionId),
        };
      }),
    })),

  addModifier: (templateId, sectionId, name, price) =>
    set((state) => ({
      modifierTemplates: state.modifierTemplates.map((t) => {
        if (t.id !== templateId) return t;
        return {
          ...t,
          sections: t.sections.map((s) => {
            if (s.id !== sectionId) return s;
            return {
              ...s,
              modifiers: [
                ...s.modifiers,
                {
                  id: generateId(),
                  name,
                  price,
                  sortOrder: s.modifiers.length,
                  isDefault: false,
                  imageAssetId: null,
                  posImagePath: null,
                  isPizzaCrust: false,
                  isPizzaTopping: false,
                  isBarMixer: false,
                  isBarDrink: false,
                },
              ],
            };
          }),
        };
      }),
    })),

  updateModifier: (templateId, sectionId, modifierId, changes) =>
    set((state) => ({
      modifierTemplates: state.modifierTemplates.map((t) => {
        if (t.id !== templateId) return t;
        return {
          ...t,
          sections: t.sections.map((s) => {
            if (s.id !== sectionId) return s;
            return {
              ...s,
              modifiers: s.modifiers.map((m) =>
                m.id === modifierId ? { ...m, ...changes } : m,
              ),
            };
          }),
        };
      }),
    })),

  deleteModifier: (templateId, sectionId, modifierId) =>
    set((state) => ({
      modifierTemplates: state.modifierTemplates.map((t) => {
        if (t.id !== templateId) return t;
        return {
          ...t,
          sections: t.sections.map((s) => {
            if (s.id !== sectionId) return s;
            return {
              ...s,
              modifiers: s.modifiers.filter((m) => m.id !== modifierId),
            };
          }),
        };
      }),
    })),

  loadTemplates: (templates) => set({ modifierTemplates: templates }),
  clearTemplates: () => set({ modifierTemplates: [] }),
});
