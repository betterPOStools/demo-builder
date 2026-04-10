"use client";

import { useEffect } from "react";
import { useStore } from "@/store";
import type { GeneratedImage } from "@/store/designSlice";

// ─── IndexedDB helpers ────────────────────────────────────────────────────────
// localStorage has a ~5MB limit — way too small for data URI images.
// IndexedDB has no meaningful limit and handles large binary blobs cleanly.

const DB_NAME = "demo-builder";
const DB_VERSION = 1;
const OBJECT_STORE = "imageLibrary";
const IDB_KEY = "images";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(OBJECT_STORE)) {
        req.result.createObjectStore(OBJECT_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbRead(): Promise<GeneratedImage[] | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE, "readonly");
      const req = tx.objectStore(OBJECT_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as GeneratedImage[]) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbWrite(images: GeneratedImage[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE, "readwrite");
      tx.objectStore(OBJECT_STORE).put(images, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore write errors
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Syncs imageLibrary to/from IndexedDB so images persist across projects.
 * IndexedDB is used instead of localStorage because data URI images easily
 * exceed localStorage's ~5 MB limit.
 * Call once in the project layout.
 */
export function useImageLibrarySync() {
  useEffect(() => {
    // Hydrate from IndexedDB on mount
    idbRead().then((images) => {
      if (images && images.length > 0) {
        useStore.setState({ imageLibrary: images });
      }
    });

    // Persist to IndexedDB on every change
    const unsub = useStore.subscribe((state, prev) => {
      if (state.imageLibrary !== prev.imageLibrary) {
        void idbWrite(state.imageLibrary);
      }
    });

    return unsub;
  }, []);
}
