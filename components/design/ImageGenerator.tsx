"use client";

import { useState, useCallback } from "react";
import {
  ImageIcon,
  Sparkles,
  Loader2,
  Check,
  X,
  Trash2,
  Play,
  Library,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useStore } from "@/store";
import { generateId } from "@/lib/utils";
import { svgToPng } from "@/lib/svgToPng";
import type { GeneratedImage } from "@/store/designSlice";

interface ItemImageStatus {
  itemId: string;
  itemName: string;
  groupName: string;
  status: "pending" | "generating" | "done" | "error";
  dataUri?: string;
  error?: string;
}

export function ImageGenerator() {
  const items = useStore((s) => s.items);
  const groups = useStore((s) => s.groups);
  const restaurantType = useStore((s) => s.restaurantType);
  const imageLibrary = useStore((s) => s.imageLibrary);
  const addGeneratedImage = useStore((s) => s.addGeneratedImage);
  const deleteGeneratedImage = useStore((s) => s.deleteGeneratedImage);
  const clearImageLibrary = useStore((s) => s.clearImageLibrary);
  const updateItem = useStore((s) => s.updateItem);

  const [styleHints, setStyleHints] = useState("");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ItemImageStatus[]>([]);
  const [showLibrary, setShowLibrary] = useState(true);

  const groupMap = new Map(groups.map((g) => [g.id, g]));

  const itemImages = imageLibrary.filter((i) => i.type === "item");

  const generateItemImage = useCallback(
    async (
      itemName: string,
      groupName: string,
    ): Promise<{ dataUri: string } | { error: string }> => {
      try {
        const res = await fetch("/api/generate-item-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemName,
            groupName,
            restaurantType,
            styleHints: styleHints.trim() || undefined,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed" }));
          return { error: err.error || `HTTP ${res.status}` };
        }

        const data = await res.json();
        const png = await svgToPng(data.svg, 90, 90);
        return { dataUri: png };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
    [restaurantType, styleHints],
  );

  async function generateAll() {
    if (items.length === 0) return;
    setGenerating(true);

    // Build status list for items that don't already have images
    const batch: ItemImageStatus[] = items
      .filter((item) => !item.posImagePath && !item.imageAssetId)
      .map((item) => ({
        itemId: item.id,
        itemName: item.name,
        groupName: groupMap.get(item.groupId)?.name || "Unknown",
        status: "pending" as const,
      }));

    setProgress(batch);

    // Process 3 at a time to avoid overwhelming the API
    const concurrency = 3;
    let idx = 0;

    async function processNext() {
      while (idx < batch.length) {
        const current = idx++;
        const item = batch[current];

        setProgress((prev) =>
          prev.map((p, i) =>
            i === current ? { ...p, status: "generating" } : p,
          ),
        );

        const result = await generateItemImage(item.itemName, item.groupName);

        if ("dataUri" in result) {
          const genImage: GeneratedImage = {
            id: generateId(),
            type: "item",
            dataUri: result.dataUri,
            createdAt: new Date().toISOString(),
            itemName: item.itemName,
          };
          addGeneratedImage(genImage);

          setProgress((prev) =>
            prev.map((p, i) =>
              i === current
                ? { ...p, status: "done", dataUri: result.dataUri }
                : p,
            ),
          );
        } else {
          setProgress((prev) =>
            prev.map((p, i) =>
              i === current
                ? { ...p, status: "error", error: result.error }
                : p,
            ),
          );
        }
      }
    }

    // Launch concurrent workers
    const workers = Array.from({ length: Math.min(concurrency, batch.length) }, () =>
      processNext(),
    );
    await Promise.all(workers);
    setGenerating(false);
  }

  function assignImageToItem(itemId: string, dataUri: string) {
    // Store the data URI as a "virtual" posImagePath that the deployer
    // will handle as a pending image transfer
    updateItem(itemId, { posImagePath: dataUri });
  }

  function autoAssignAll() {
    // Match library images to items by name
    for (const item of items) {
      if (item.posImagePath) continue; // already has an image
      const match = itemImages.find(
        (img) =>
          img.itemName?.toLowerCase() === item.name.toLowerCase(),
      );
      if (match) {
        updateItem(item.id, { posImagePath: match.dataUri });
      }
    }
  }

  const itemsWithImages = items.filter((i) => i.posImagePath);
  const itemsWithoutImages = items.filter((i) => !i.posImagePath);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="h-4 w-4 text-blue-400" />
            Menu Item Images
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-slate-400">
            Generate AI icons for each menu item. Images are saved to the
            library and deployed to the POS.
          </div>

          {/* Stats */}
          <div className="flex gap-4 text-xs">
            <span className="text-slate-500">
              {items.length} items total
            </span>
            <span className="text-green-400">
              {itemsWithImages.length} with images
            </span>
            <span className="text-amber-400">
              {itemsWithoutImages.length} without images
            </span>
            <span className="text-purple-400">
              {itemImages.length} in library
            </span>
          </div>

          {/* Style hints + generate */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-2.5">
            <Label className="text-xs text-slate-400">
              AI Image Generator
            </Label>
            <Input
              value={styleHints}
              onChange={(e) => setStyleHints(e.target.value)}
              placeholder="Style hints: flat icons, colorful, minimal, neon..."
              className="h-8 text-xs"
            />
            <div className="flex gap-2">
              <Button
                onClick={generateAll}
                disabled={generating || itemsWithoutImages.length === 0}
                className="flex-1 gap-2"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Generate for {itemsWithoutImages.length} Items
                  </>
                )}
              </Button>
              {itemImages.length > 0 && itemsWithoutImages.length > 0 && (
                <Button
                  variant="outline"
                  onClick={autoAssignAll}
                  className="gap-1.5"
                  title="Auto-assign library images to matching items"
                >
                  <Play className="h-3.5 w-3.5" />
                  Auto-assign
                </Button>
              )}
            </div>
            <p className="text-[10px] text-slate-600">
              Generates 90x90px icons, 3 at a time. Uses Haiku for speed.
            </p>
          </div>

          {/* Generation progress */}
          {progress.length > 0 && (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/50 p-2">
              {progress.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs"
                >
                  {p.status === "generating" && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-400" />
                  )}
                  {p.status === "done" && (
                    <Check className="h-3 w-3 shrink-0 text-green-400" />
                  )}
                  {p.status === "error" && (
                    <X className="h-3 w-3 shrink-0 text-red-400" />
                  )}
                  {p.status === "pending" && (
                    <div className="h-3 w-3 shrink-0 rounded-full border border-slate-600" />
                  )}
                  <span className="truncate text-slate-300">
                    {p.itemName}
                  </span>
                  <span className="text-slate-600">{p.groupName}</span>
                  {p.status === "done" && p.dataUri && (
                    <img
                      src={p.dataUri}
                      alt=""
                      className="ml-auto h-6 w-6 rounded border border-slate-700"
                    />
                  )}
                  {p.status === "error" && (
                    <span className="ml-auto text-[10px] text-red-400">
                      {p.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Image Library */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <button
              className="flex items-center gap-2"
              onClick={() => setShowLibrary(!showLibrary)}
            >
              <Library className="h-4 w-4 text-purple-400" />
              Image Library ({itemImages.length})
            </button>
            {itemImages.length > 0 && (
              <button
                onClick={() => clearImageLibrary("item")}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-400"
              >
                <Trash2 className="h-3 w-3" />
                Clear all
              </button>
            )}
          </CardTitle>
        </CardHeader>
        {showLibrary && itemImages.length > 0 && (
          <CardContent>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-8 md:grid-cols-10">
              {itemImages.map((img) => {
                // Find matching item to show assignment state
                const assigned = items.find(
                  (item) => item.posImagePath === img.dataUri,
                );
                return (
                  <div
                    key={img.id}
                    className={`group relative overflow-hidden rounded-lg border ${
                      assigned
                        ? "border-green-500/50 ring-1 ring-green-500/30"
                        : "border-slate-700 hover:border-blue-500/50"
                    }`}
                  >
                    <img
                      src={img.dataUri}
                      alt={img.itemName || ""}
                      className="h-full w-full cursor-pointer"
                      title={`${img.itemName || "Unknown"}${assigned ? " (assigned)" : " — click to assign"}`}
                      onClick={() => {
                        // Find the matching item and assign
                        const match = items.find(
                          (item) =>
                            !item.posImagePath &&
                            item.name.toLowerCase() ===
                              img.itemName?.toLowerCase(),
                        );
                        if (match) {
                          assignImageToItem(match.id, img.dataUri);
                        }
                      }}
                    />
                    <div className="absolute bottom-0 left-0 right-0 hidden truncate bg-black/80 px-1 py-0.5 text-[8px] text-slate-300 group-hover:block">
                      {img.itemName || "?"}
                    </div>
                    <button
                      onClick={() => deleteGeneratedImage(img.id)}
                      className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-red-400 hover:text-red-300 group-hover:block"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
