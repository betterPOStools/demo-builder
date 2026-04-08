"use client";

import { useEffect } from "react";
import { useStore } from "@/store";
import type { GeneratedImage } from "@/store/designSlice";

const LS_KEY = "demo-builder:imageLibrary";

/**
 * Syncs imageLibrary to/from localStorage so images persist across projects.
 * Call once in the project layout. Reading happens on mount; writing is
 * reactive via a store subscription.
 */
export function useImageLibrarySync() {
  useEffect(() => {
    // Hydrate from localStorage on mount
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const images = JSON.parse(raw) as GeneratedImage[];
        if (Array.isArray(images) && images.length > 0) {
          useStore.setState({ imageLibrary: images });
        }
      }
    } catch {
      // ignore parse errors
    }

    // Persist to localStorage on every change
    const unsub = useStore.subscribe((state, prev) => {
      if (state.imageLibrary !== prev.imageLibrary) {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(state.imageLibrary));
        } catch {
          // ignore quota errors
        }
      }
    });

    return unsub;
  }, []);
}
