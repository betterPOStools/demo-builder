"use client";

import { useMemo, useState } from "react";
import { ChevronRight, GripVertical, Trash2, Plus } from "lucide-react";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { ItemCard } from "./ItemCard";
import type { CategoryName, GroupNode } from "@/lib/types";

export function GroupPanel({
  group,
  category,
}: {
  group: GroupNode;
  category: CategoryName;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemPrice, setNewItemPrice] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const [editColor, setEditColor] = useState(group.color || "");
  const [editImage, setEditImage] = useState(group.posImagePath || "");

  const allItems = useStore((s) => s.items);
  const items = useMemo(
    () =>
      allItems
        .filter((i) => i.groupId === group.id)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [allItems, group.id],
  );
  const deleteGroup = useStore((s) => s.deleteGroup);
  const renameGroup = useStore((s) => s.renameGroup);
  const updateGroup = useStore((s) => s.updateGroup);
  const addItem = useStore((s) => s.addItem);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: group.id,
    data: { type: "group" as const, category },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  // Price range for collapsed summary
  const priceRange = useMemo(() => {
    const prices = items.map((i) => i.defaultPrice).filter((p) => p > 0);
    if (prices.length === 0) return null;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min === max) return `$${min.toFixed(2)}`;
    return `$${min.toFixed(2)}–$${max.toFixed(2)}`;
  }, [items]);

  function handleAddItem() {
    if (!newItemName.trim()) return;
    addItem(group.id, newItemName.trim(), parseFloat(newItemPrice) || 0);
    setNewItemName("");
    setNewItemPrice("");
    setIsAddingItem(false);
  }

  function openRename() {
    setRenameValue(group.name);
    setEditColor(group.color || "");
    setEditImage(group.posImagePath || "");
    setIsRenaming(true);
  }

  function handleRename() {
    const trimmed = renameValue.trim();
    if (trimmed) {
      const newColor = editColor.trim() || null;
      const newImage = editImage.trim() || null;
      if (trimmed !== group.name) {
        renameGroup(group.id, trimmed);
      }
      if (newColor !== group.color || newImage !== group.posImagePath) {
        updateGroup(group.id, { color: newColor, posImagePath: newImage });
      }
    }
    setIsRenaming(false);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-md border border-slate-700/50 bg-slate-800/50"
    >
      <div className="flex items-center gap-1 px-1 py-2">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab rounded p-0.5 text-slate-600 hover:text-slate-400 active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="shrink-0 rounded p-0.5 text-slate-500 hover:text-slate-300"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              isExpanded && "rotate-90",
            )}
          />
        </button>

        {/* Color dot */}
        {group.color && (
          <div
            className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/10"
            style={{ backgroundColor: group.color }}
          />
        )}

        {/* Image thumbnail */}
        {group.posImagePath && (
          <img
            src={group.posImagePath}
            alt=""
            className="h-5 w-5 shrink-0 rounded object-cover"
          />
        )}

        {isRenaming ? (
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex items-center gap-1">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename();
                  if (e.key === "Escape") {
                    setRenameValue(group.name);
                    setIsRenaming(false);
                  }
                }}
                autoFocus
                className="h-6 flex-1 rounded border border-blue-500 bg-slate-800 px-1.5 text-sm text-slate-200 focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={editColor || "#6b7280"}
                onChange={(e) => setEditColor(e.target.value)}
                className="h-5 w-5 cursor-pointer rounded border border-slate-600 bg-transparent"
              />
              <input
                value={editColor}
                onChange={(e) => setEditColor(e.target.value)}
                placeholder="Color hex"
                className="h-5 w-16 rounded border border-slate-600 bg-slate-900 px-1 text-[10px] text-slate-400 focus:border-blue-500 focus:outline-none"
              />
              {editColor && (
                <button
                  onClick={() => setEditColor("")}
                  className="text-[10px] text-slate-500 hover:text-red-400"
                >
                  ×
                </button>
              )}
              <input
                value={editImage}
                onChange={(e) => setEditImage(e.target.value)}
                placeholder="Image URL"
                className="h-5 flex-1 rounded border border-slate-600 bg-slate-900 px-1 text-[10px] text-slate-400 focus:border-blue-500 focus:outline-none"
              />
              <button
                onClick={handleRename}
                className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-blue-500"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <span
            className="flex-1 cursor-default truncate text-sm font-medium text-slate-200"
            onDoubleClick={openRename}
          >
            {group.name}
          </span>
        )}

        {/* Item count + collapsed summary */}
        {!isRenaming && (
          <div className="flex items-center gap-1.5">
            {!isExpanded && priceRange && (
              <span className="text-[10px] text-slate-500">{priceRange}</span>
            )}
            <span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">
              {items.length}
            </span>
          </div>
        )}

        <button
          onClick={() => deleteGroup(group.id)}
          className="rounded p-0.5 text-slate-600 hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {isExpanded && (
        <div className="border-t border-slate-700/50 px-2 py-1.5">
          <SortableContext
            items={items.map((i) => i.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-0.5">
              {items.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </div>
          </SortableContext>

          {isAddingItem ? (
            <div className="mt-1.5 flex gap-1.5 px-1">
              <input
                type="text"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddItem();
                  if (e.key === "Escape") setIsAddingItem(false);
                }}
                placeholder="Item name..."
                autoFocus
                className="h-7 flex-1 rounded border border-slate-600 bg-slate-800 px-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
              <input
                type="text"
                value={newItemPrice}
                onChange={(e) => setNewItemPrice(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddItem();
                }}
                placeholder="$0.00"
                className="h-7 w-16 rounded border border-slate-600 bg-slate-800 px-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleAddItem}
              >
                Add
              </Button>
            </div>
          ) : (
            <button
              onClick={() => setIsAddingItem(true)}
              className="mt-1.5 flex w-full items-center gap-1.5 rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-700/50 hover:text-slate-300"
            >
              <Plus className="h-3 w-3" />
              Add item
            </button>
          )}
        </div>
      )}
    </div>
  );
}
