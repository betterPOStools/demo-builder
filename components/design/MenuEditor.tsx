"use client";

import { useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useState } from "react";
import { useStore } from "@/store";
import { CategoryPanel } from "./CategoryPanel";
import type { CategoryName } from "@/lib/types";

const CATEGORIES: CategoryName[] = ["Food", "Beverages", "Bar"];

const categoryColors: Record<CategoryName, string> = {
  Food: "border-emerald-500",
  Beverages: "border-blue-500",
  Bar: "border-amber-500",
};

export function MenuEditor() {
  const groups = useStore((s) => s.groups);
  const items = useStore((s) => s.items);
  const reorderGroups = useStore((s) => s.reorderGroups);
  const reorderItems = useStore((s) => s.reorderItems);
  const moveItem = useStore((s) => s.moveItem);

  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeData = active.data.current as {
        type: "group" | "item";
        category?: CategoryName;
        groupId?: string;
      } | undefined;
      const overData = over.data.current as {
        type: "group" | "item";
        category?: CategoryName;
        groupId?: string;
      } | undefined;

      if (!activeData || !overData) return;

      // Reorder groups within same category
      if (activeData.type === "group" && overData.type === "group") {
        const cat = activeData.category!;
        const catGroups = groups
          .filter((g) => g.category === cat)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        const ids = catGroups.map((g) => g.id);
        const oldIdx = ids.indexOf(active.id as string);
        const newIdx = ids.indexOf(over.id as string);
        if (oldIdx !== -1 && newIdx !== -1) {
          const reordered = [...ids];
          reordered.splice(oldIdx, 1);
          reordered.splice(newIdx, 0, active.id as string);
          reorderGroups(cat, reordered);
        }
      }

      // Reorder items within same group
      if (activeData.type === "item" && overData.type === "item") {
        const groupId = activeData.groupId!;
        const overGroupId = overData.groupId!;

        if (groupId === overGroupId) {
          // Same group — reorder
          const groupItems = items
            .filter((i) => i.groupId === groupId)
            .sort((a, b) => a.sortOrder - b.sortOrder);
          const ids = groupItems.map((i) => i.id);
          const oldIdx = ids.indexOf(active.id as string);
          const newIdx = ids.indexOf(over.id as string);
          if (oldIdx !== -1 && newIdx !== -1) {
            const reordered = [...ids];
            reordered.splice(oldIdx, 1);
            reordered.splice(newIdx, 0, active.id as string);
            reorderItems(groupId, reordered);
          }
        } else {
          // Different group — move item
          moveItem(active.id as string, overGroupId);
        }
      }
    },
    [groups, items, reorderGroups, reorderItems, moveItem],
  );

  const activeItem = activeId
    ? items.find((i) => i.id === activeId)
    : null;
  const activeGroup = activeId && !activeItem
    ? groups.find((g) => g.id === activeId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="grid gap-4 md:grid-cols-3">
        {CATEGORIES.map((cat) => {
          const catGroups = groups
            .filter((g) => g.category === cat)
            .sort((a, b) => a.sortOrder - b.sortOrder);
          const catItemCount = items.filter((i) =>
            catGroups.some((g) => g.id === i.groupId),
          ).length;

          return (
            <CategoryPanel
              key={cat}
              category={cat}
              groups={catGroups}
              itemCount={catItemCount}
              borderColor={categoryColors[cat]}
            />
          );
        })}
      </div>

      <DragOverlay>
        {activeItem && (
          <div className="rounded bg-slate-700 px-3 py-1.5 text-xs text-slate-200 shadow-lg">
            {activeItem.name}
            {activeItem.defaultPrice > 0 && (
              <span className="ml-2 text-slate-400">
                ${activeItem.defaultPrice.toFixed(2)}
              </span>
            )}
          </div>
        )}
        {activeGroup && (
          <div className="rounded bg-slate-700 px-3 py-2 text-sm font-medium text-slate-200 shadow-lg">
            {activeGroup.name}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
