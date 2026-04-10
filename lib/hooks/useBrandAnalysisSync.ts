"use client";

import { useEffect } from "react";
import { useStore } from "@/store";
import type { SavedBrandAnalysis } from "@/store/designSlice";

// Reuses the same IndexedDB database as useImageLibrarySync.
// Brand analyses include thumbnail data URIs so localStorage isn't reliable here either.

const DB_NAME = "demo-builder";
const DB_VERSION = 1;
const OBJECT_STORE = "imageLibrary"; // shared store, keyed by string
const IDB_KEY = "brandAnalyses";

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

async function idbRead(): Promise<SavedBrandAnalysis[] | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE, "readonly");
      const req = tx.objectStore(OBJECT_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as SavedBrandAnalysis[]) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbWrite(analyses: SavedBrandAnalysis[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE, "readwrite");
      tx.objectStore(OBJECT_STORE).put(analyses, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore write errors
  }
}

export function useBrandAnalysisSync() {
  useEffect(() => {
    idbRead().then((analyses) => {
      if (analyses && analyses.length > 0) {
        useStore.setState({ brandAnalyses: analyses });
      }
    });

    const unsub = useStore.subscribe((state, prev) => {
      if (state.brandAnalyses !== prev.brandAnalyses) {
        void idbWrite(state.brandAnalyses);
      }
    });

    return unsub;
  }, []);
}
