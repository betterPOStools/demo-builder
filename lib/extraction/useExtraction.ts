"use client";

import { useCallback } from "react";
import { useStore } from "@/store";
import { toast } from "sonner";

const MAX_CONCURRENT = 3;

export function useExtraction() {
  const updateFileStatus = useStore((s) => s.updateFileStatus);
  const setProcessing = useStore((s) => s.setProcessing);
  const appendRows = useStore((s) => s.appendRows);
  const setExtractionResults = useStore((s) => s.setExtractionResults);
  const addFiles = useStore((s) => s.addFiles);
  const setRestaurantName = useStore((s) => s.setRestaurantName);

  const processFiles = useCallback(async () => {
    const pending = useStore
      .getState()
      .files.filter((f) => f.status === "pending");
    if (pending.length === 0) return;

    setProcessing(true);
    const isFirstExtraction = useStore.getState().extractedRows.length === 0;
    const isBatch = pending.length > 1;
    const batchId = isBatch ? crypto.randomUUID() : undefined;

    let firstDone = false;

    let idx = 0;
    const processNext = async (): Promise<void> => {
      while (idx < pending.length) {
        const current = idx++;
        const item = pending[current];

        updateFileStatus(item.id, "processing");

        try {
          let res: Response;
          let data: Record<string, unknown>;

          if (item.type === "url") {
            // URL extraction
            res = await fetch("/api/extract-url", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: item.name,
                extendedMode: true,
              }),
            });
          } else {
            // File extraction
            const formData = new FormData();
            formData.append("file", item.file);
            formData.append("fileName", item.name);
            formData.append("mimeType", item.file.type || "");
            formData.append("extendedMode", "true");
            if (batchId) formData.append("batchId", batchId);

            res = await fetch("/api/extract", {
              method: "POST",
              body: formData,
            });
          }

          if (!res.ok) {
            const err = await res
              .json()
              .catch(() => ({ error: "Request failed" }));
            throw new Error(
              (err as { error?: string }).error || `HTTP ${res.status}`,
            );
          }

          data = await res.json();

          if (isFirstExtraction && !firstDone) {
            firstDone = true;
            setExtractionResults({
              rows: (data.rows as never[]) || [],
              modifierTemplates: data.modifierTemplates as never[],
              restaurantType: data.restaurantType as string | null,
              graphics: data.graphics as never[],
            });
            // Auto-set restaurant name from URL response
            const suggested =
              (data.suggestedName as string) ||
              (data.pageTitle as string);
            if (
              suggested &&
              !useStore.getState().restaurantName
            ) {
              setRestaurantName(suggested);
            }
          } else {
            const rows = data.rows as never[];
            if (rows?.length) {
              appendRows(rows);
            }
          }

          updateFileStatus(item.id, "done");
          toast.success(
            `Extracted ${(data.count as number) || 0} items from ${item.name}`,
          );
        } catch (error: unknown) {
          const msg = (error as Error).message || "Extraction failed";
          updateFileStatus(item.id, "error", msg);
          toast.error(`${item.name}: ${msg}`);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT, pending.length) },
      () => processNext(),
    );
    await Promise.all(workers);
    setProcessing(false);
  }, [
    updateFileStatus,
    setProcessing,
    appendRows,
    setExtractionResults,
    setRestaurantName,
  ]);

  // Add a URL to the file queue as a trackable item, then process
  const addUrl = useCallback(
    (url: string) => {
      // Create a placeholder File for the queue
      const placeholder = new File([], url);
      // We need to set the type to "url" — addFiles creates entries from File objects,
      // so we override via a direct store call
      const state = useStore.getState();
      const entry = {
        id: crypto.randomUUID(),
        file: placeholder,
        name: url,
        type: "url",
        size: 0,
        status: "pending" as const,
      };
      useStore.setState({ files: [...state.files, entry] });
    },
    [],
  );

  // Add URL and immediately start processing
  const processUrl = useCallback(
    async (url: string) => {
      addUrl(url);
      // Small delay to let state settle
      await new Promise((r) => setTimeout(r, 50));
      await processFiles();
    },
    [addUrl, processFiles],
  );

  return { processFiles, processUrl, addUrl };
}
