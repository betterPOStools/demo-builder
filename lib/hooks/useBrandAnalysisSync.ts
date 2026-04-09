"use client";

import { useEffect } from "react";
import { useStore } from "@/store";
import type { SavedBrandAnalysis } from "@/store/designSlice";

const LS_KEY = "demo-builder:brandAnalyses";

/**
 * Syncs savedBrandAnalyses to/from localStorage so they persist across sessions.
 * Call once in the project layout alongside useImageLibrarySync.
 */
export function useBrandAnalysisSync() {
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const analyses = JSON.parse(raw) as SavedBrandAnalysis[];
        if (Array.isArray(analyses) && analyses.length > 0) {
          useStore.setState({ brandAnalyses: analyses });
        }
      }
    } catch {
      // ignore parse errors
    }

    const unsub = useStore.subscribe((state, prev) => {
      if (state.brandAnalyses !== prev.brandAnalyses) {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(state.brandAnalyses));
        } catch {
          // ignore quota errors
        }
      }
    });

    return unsub;
  }, []);
}
