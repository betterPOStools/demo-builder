"use client";

import { useState } from "react";
import { GripVertical, Trash2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore } from "@/store";
import type { ItemNode } from "@/lib/types";

export function ItemCard({ item }: { item: ItemNode }) {
  const deleteItem = useStore((s) => s.deleteItem);
  const updateItem = useStore((s) => s.updateItem);
  const modifierTemplates = useStore((s) => s.modifierTemplates);

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(item.name);
  const [editPrice, setEditPrice] = useState(String(item.defaultPrice || ""));

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    data: { type: "item" as const, groupId: item.groupId },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const templateCount = item.modifierTemplateIds.filter((id) =>
    modifierTemplates.some((t) => t.id === id),
  ).length;

  function commitEdit() {
    const trimmedName = editName.trim();
    const newPrice = parseFloat(editPrice) || 0;
    if (trimmedName && (trimmedName !== item.name || newPrice !== item.defaultPrice)) {
      updateItem(item.id, { name: trimmedName, defaultPrice: newPrice });
    }
    setIsEditing(false);
  }

  if (isEditing) {
    return (
      <div ref={setNodeRef} style={style} className="flex items-center gap-1.5 rounded px-1 py-1">
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setIsEditing(false);
          }}
          autoFocus
          className="h-6 flex-1 rounded border border-blue-500 bg-slate-800 px-1.5 text-xs text-slate-200 focus:outline-none"
        />
        <input
          value={editPrice}
          onChange={(e) => setEditPrice(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setIsEditing(false);
          }}
          className="h-6 w-16 rounded border border-blue-500 bg-slate-800 px-1.5 text-xs text-slate-200 focus:outline-none"
        />
        <button
          onClick={commitEdit}
          className="rounded px-1.5 py-0.5 text-xs text-blue-400 hover:bg-blue-500/10"
        >
          OK
        </button>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-1 rounded px-1 py-1 hover:bg-slate-700/30"
      onDoubleClick={() => {
        setEditName(item.name);
        setEditPrice(String(item.defaultPrice || ""));
        setIsEditing(true);
      }}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab rounded p-0.5 text-slate-700 hover:text-slate-500 active:cursor-grabbing group-hover:text-slate-500"
      >
        <GripVertical className="h-3 w-3" />
      </button>
      <span className="flex-1 truncate text-xs text-slate-300">
        {item.name}
      </span>
      {templateCount > 0 && (
        <span className="rounded bg-slate-700 px-1 py-0.5 text-[10px] text-slate-400">
          {templateCount}
        </span>
      )}
      <span className="text-xs text-slate-500">
        {item.defaultPrice > 0 ? `$${item.defaultPrice.toFixed(2)}` : ""}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          deleteItem(item.id);
        }}
        className="hidden rounded p-0.5 text-slate-600 hover:text-red-400 group-hover:block"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
