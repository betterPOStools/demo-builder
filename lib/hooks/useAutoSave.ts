"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/store";

export function useAutoSave(projectId: string) {
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justHydratedRef = useRef(true);

  useEffect(() => {
    // Reset the skip flag when project changes
    justHydratedRef.current = true;

    const unsub = useStore.subscribe((state, prev) => {
      // Skip auto-save right after hydration / project switch
      if (justHydratedRef.current) {
        justHydratedRef.current = false;
        return;
      }

      // Don't save during a reset (hydratedSessionId changing)
      if (state.hydratedSessionId !== prev.hydratedSessionId) {
        return;
      }

      // Only save when design-relevant state changes
      if (
        state.groups === prev.groups &&
        state.items === prev.items &&
        state.rooms === prev.rooms &&
        state.modifierTemplates === prev.modifierTemplates &&
        state.extractedRows === prev.extractedRows &&
        state.extractedModifiers === prev.extractedModifiers &&
        state.restaurantName === prev.restaurantName &&
        state.currentStep === prev.currentStep &&
        state.branding === prev.branding &&
        state.imageLibrary === prev.imageLibrary
      ) {
        return;
      }

      // Debounce 2s
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        // Cancel any in-flight save
        if (abortRef.current) abortRef.current.abort();
        abortRef.current = new AbortController();

        const s = useStore.getState();
        const body = {
          restaurant_name: s.restaurantName || null,
          restaurant_type: s.restaurantType || null,
          extracted_rows: s.extractedRows.length > 0 ? s.extractedRows : null,
          modifier_suggestions:
            s.extractedModifiers.length > 0 ? s.extractedModifiers : null,
          design_state:
            s.groups.length > 0 || s.items.length > 0
              ? {
                  groups: s.groups,
                  items: s.items,
                  rooms: s.rooms,
                  branding: s.branding,
                  imageLibrary: s.imageLibrary,
                  designOrigin: s.designOrigin,
                }
              : null,
          modifier_templates:
            s.modifierTemplates.length > 0 ? s.modifierTemplates : null,
          current_step: s.currentStep,
        };

        fetch(`/api/sessions/${projectId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abortRef.current.signal,
        }).catch(() => {
          // Silently ignore abort errors
        });
      }, 2000);
    });

    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [projectId]);
}
