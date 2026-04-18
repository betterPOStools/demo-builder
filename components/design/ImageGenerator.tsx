"use client";

import { useState, useCallback } from "react";
import {
  ImageIcon,
  Sparkles,
  Loader2,
  Check,
  X,
  Play,
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
import { LibraryPicker } from "@/components/ui/LibraryPicker";
import { TemplateSelector } from "@/components/ui/TemplateSelector";
import { DEFAULT_TEMPLATE_BY_SURFACE } from "@/lib/generation/templates";
import { useStore } from "@/store";
import { generateId } from "@/lib/utils";
import { svgToPng } from "@/lib/svgToPng";
import { extractConceptTags, extractFoodCategory } from "@/lib/itemTags";
import { searchLibrary, addToLibrary } from "@/lib/library/client";
import type { GeneratedImage } from "@/store/designSlice";
import type { ImageLibraryEntry } from "@/lib/library/types";

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
  const restaurantName = useStore((s) => s.restaurantName);
  const imageLibrary = useStore((s) => s.imageLibrary);
  const addGeneratedImage = useStore((s) => s.addGeneratedImage);
  const updateItem = useStore((s) => s.updateItem);

  const [styleHints, setStyleHints] = useState("");
  const [recraftStyle, setRecraftStyle] = useState<"vector_illustration" | "digital_illustration">("digital_illustration");
  const [itemTemplate, setItemTemplate] = useState(DEFAULT_TEMPLATE_BY_SURFACE.item);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ItemImageStatus[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showItemPicker, setShowItemPicker] = useState(false);

  const handleLibrarySelect = useCallback(
    (entry: ImageLibraryEntry) => {
      const match = items.find(
        (item) =>
          !item.posImagePath &&
          entry.item_name &&
          item.name.toLowerCase() === entry.item_name.toLowerCase(),
      );
      if (match) updateItem(match.id, { posImagePath: entry.public_url });
    },
    [items, updateItem],
  );

  const groupMap = new Map(groups.map((g) => [g.id, g]));

  const itemImages = imageLibrary.filter((i) => i.type === "item");

  const generateItemImage = useCallback(
    async (
      itemName: string,
      groupName: string,
    ): Promise<{ dataUri: string; conceptTags: string[]; foodCategory: string; cuisineType: string } | { error: string }> => {
      if (itemTemplate === "pull-from-library") {
        try {
          const tags = extractConceptTags(itemName, groupName, restaurantType ?? undefined);
          const category = extractFoodCategory(groupName);
          const { entries, matched } = await searchLibrary({
            intent: "item",
            tags,
            item_name: itemName,
            food_category: category,
            restaurant_type: restaurantType ?? undefined,
            limit: 1,
          });
          if (matched && entries[0]) {
            const hit = entries[0];
            return {
              dataUri: hit.public_url,
              conceptTags: hit.concept_tags ?? [],
              foodCategory: hit.food_category ?? category,
              cuisineType: hit.cuisine_type ?? "general",
            };
          }
        } catch {
          // Silent fallback — library unavailable, proceed with AI generation.
        }
      }

      try {
        const res = await fetch("/api/generate-item-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemName,
            groupName,
            restaurantType,
            styleHints: styleHints.trim() || undefined,
            recraftStyle,
            templateId: itemTemplate,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed" }));
          return { error: err.error || `HTTP ${res.status}` };
        }

        const data = await res.json();
        const dataUri = data.dataUri
          ? (data.dataUri as string)
          : await svgToPng(data.svg as string, 90, 90);

        const conceptTags = (data.conceptTags as string[]) || [];
        const foodCategory = (data.foodCategory as string) || "entree";
        const cuisineType = (data.cuisineType as string) || "general";

        // Persist to shared library so future generations hit pull-from-library.
        // Fire-and-forget — a library save failure must not break the gen flow.
        void addToLibrary({
          image_type: "item",
          original_intent: "item",
          data_uri: dataUri,
          template_id: itemTemplate,
          item_name: itemName,
          concept_tags: conceptTags,
          cuisine_type: cuisineType,
          food_category: foodCategory,
          restaurant_type: restaurantType ?? undefined,
          generated_for: restaurantName || undefined,
        }).catch(() => {
          /* library unavailable — leave it, gen succeeded regardless */
        });

        return { dataUri, conceptTags, foodCategory, cuisineType };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
    [restaurantType, restaurantName, styleHints, recraftStyle, itemTemplate],
  );

  async function generateAll() {
    if (items.length === 0) return;
    setGenerating(true);

    // If items are selected, generate only those; otherwise all without images
    const toGenerate = selectedIds.size > 0
      ? items.filter((item) => selectedIds.has(item.id))
      : items.filter((item) => !item.posImagePath && !item.imageAssetId);

    const batch: ItemImageStatus[] = toGenerate.map((item) => ({
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
            conceptTags: result.conceptTags,
            foodCategory: result.foodCategory,
            cuisineType: result.cuisineType,
            generatedFor: restaurantName || undefined,
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

  function scoreMatch(
    item: (typeof items)[number],
    img: GeneratedImage,
  ): number {
    // Tier 1: exact name match
    if (img.itemName?.toLowerCase() === item.name.toLowerCase()) return 100;

    // Tier 2: concept tag overlap (≥2 shared tags required)
    const itemTags = extractConceptTags(
      item.name,
      groupMap.get(item.groupId)?.name,
      restaurantType ?? undefined,
    );
    const shared = itemTags.filter((t) => img.conceptTags?.includes(t)).length;
    if (shared >= 2) return shared * 10;

    // Tier 3: category + cuisine match
    const itemCategory = extractFoodCategory(groupMap.get(item.groupId)?.name);
    if (
      img.foodCategory === itemCategory &&
      img.cuisineType === (restaurantType?.toLowerCase() || "general")
    )
      return 1;

    return 0;
  }

  function autoAssignAll() {
    for (const item of items) {
      if (item.posImagePath) continue;
      let bestImg: GeneratedImage | null = null;
      let bestScore = 0;
      for (const img of itemImages) {
        const score = scoreMatch(item, img);
        if (score > bestScore) {
          bestScore = score;
          bestImg = img;
        }
      }
      if (bestImg && bestScore > 0) {
        updateItem(item.id, { posImagePath: bestImg.dataUri });
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
            <TemplateSelector
              surface="item"
              value={itemTemplate}
              onChange={setItemTemplate}
              title="Item icon template"
            />
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-slate-600">Style:</span>
              {(["vector_illustration", "digital_illustration"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRecraftStyle(s)}
                  className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition ${
                    recraftStyle === s
                      ? "bg-slate-500 text-white"
                      : "border border-slate-600 text-slate-500 hover:border-slate-400 hover:text-slate-300"
                  }`}
                >
                  {s === "vector_illustration" ? "Vector" : "Digital"}
                </button>
              ))}
            </div>
            <Input
              value={styleHints}
              onChange={(e) => setStyleHints(e.target.value)}
              placeholder="Style hints: flat icons, colorful, minimal, neon..."
              className="h-8 text-xs"
            />
            {/* Item picker */}
            <div>
              <button
                type="button"
                onClick={() => setShowItemPicker((v) => !v)}
                className="flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300"
              >
                <span>{showItemPicker ? "▾" : "▸"}</span>
                {selectedIds.size > 0
                  ? `${selectedIds.size} item${selectedIds.size !== 1 ? "s" : ""} selected`
                  : "Select specific items (optional)"}
              </button>
              {showItemPicker && (
                <div className="mt-1.5 space-y-1">
                  <div className="flex gap-2 mb-1">
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set(itemsWithoutImages.map((i) => i.id)))}
                      className="text-[9px] text-blue-400 hover:text-blue-300"
                    >
                      Select without images
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set(items.map((i) => i.id)))}
                      className="text-[9px] text-slate-500 hover:text-slate-300"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set())}
                      className="text-[9px] text-slate-600 hover:text-slate-400"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded border border-slate-700 bg-slate-900/60">
                    {groups.map((group) => {
                      const groupItems = items.filter((i) => i.groupId === group.id);
                      if (groupItems.length === 0) return null;
                      return (
                        <div key={group.id}>
                          <div className="sticky top-0 bg-slate-800/90 px-2 py-0.5 text-[9px] font-semibold text-slate-500 uppercase tracking-wide">
                            {group.name}
                          </div>
                          {groupItems.map((item) => (
                            <label
                              key={item.id}
                              className="flex cursor-pointer items-center gap-2 px-2 py-0.5 hover:bg-slate-800/60"
                            >
                              <input
                                type="checkbox"
                                checked={selectedIds.has(item.id)}
                                onChange={(e) => {
                                  setSelectedIds((prev) => {
                                    const next = new Set(prev);
                                    e.target.checked ? next.add(item.id) : next.delete(item.id);
                                    return next;
                                  });
                                }}
                                className="h-3 w-3 accent-blue-500"
                              />
                              <span className="flex-1 truncate text-[10px] text-slate-300">{item.name}</span>
                              {item.posImagePath && (
                                <img src={item.posImagePath} alt="" className="h-4 w-4 rounded object-cover opacity-60" />
                              )}
                            </label>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                onClick={generateAll}
                disabled={generating || (selectedIds.size === 0 && itemsWithoutImages.length === 0)}
                className="flex-1 gap-2"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : selectedIds.size > 0 ? (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Generate {selectedIds.size} Selected
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Generate {itemsWithoutImages.length} Without Images
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
              3 at a time via Recraft V3. Select specific items above or generate all at once.
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

      <Card>
        <CardContent className="pt-6">
          <LibraryPicker
            intent="item"
            onSelect={handleLibrarySelect}
            title="Shared Image Library"
            thumbnailClass="h-16 w-16"
          />
        </CardContent>
      </Card>
    </div>
  );
}
