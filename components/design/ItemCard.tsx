"use client";

import { useState } from "react";
import { GripVertical, Trash2, Wine } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore } from "@/store";
import { isLightColor } from "@/lib/utils";
import type { ItemNode } from "@/lib/types";

export function ItemCard({ item }: { item: ItemNode }) {
  const deleteItem = useStore((s) => s.deleteItem);
  const updateItem = useStore((s) => s.updateItem);
  const modifierTemplates = useStore((s) => s.modifierTemplates);
  const groups = useStore((s) => s.groups);
  const branding = useStore((s) => s.branding);

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(item.name);
  const [editPrice, setEditPrice] = useState(String(item.defaultPrice || ""));
  const [editColor, setEditColor] = useState(item.color || "");
  const [editImage, setEditImage] = useState(item.posImagePath || "");

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

  // Resolve display color: item → group → branding → gray
  const group = groups.find((g) => g.id === item.groupId);
  const displayColor =
    item.color ||
    group?.color ||
    branding.buttons_background_color ||
    null;

  const assignedTemplates = modifierTemplates.filter((t) =>
    item.modifierTemplateIds.includes(t.id),
  );

  function commitEdit() {
    const trimmedName = editName.trim();
    const newPrice = parseFloat(editPrice) || 0;
    const newColor = editColor.trim() || null;
    const newImage = editImage.trim() || null;
    if (trimmedName) {
      updateItem(item.id, {
        name: trimmedName,
        defaultPrice: newPrice,
        color: newColor,
        posImagePath: newImage,
      });
    }
    setIsEditing(false);
  }

  function openEdit() {
    setEditName(item.name);
    setEditPrice(String(item.defaultPrice || ""));
    setEditColor(item.color || "");
    setEditImage(item.posImagePath || "");
    setIsEditing(true);
  }

  if (isEditing) {
    return (
      <div ref={setNodeRef} style={style} className="space-y-1.5 rounded-md border border-blue-500/30 bg-slate-800/80 px-2 py-2">
        <div className="flex items-center gap-1.5">
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setIsEditing(false);
            }}
            autoFocus
            placeholder="Item name"
            className="h-6 flex-1 rounded border border-slate-600 bg-slate-900 px-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
          />
          <input
            value={editPrice}
            onChange={(e) => setEditPrice(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setIsEditing(false);
            }}
            placeholder="$0.00"
            className="h-6 w-16 rounded border border-slate-600 bg-slate-900 px-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1">
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
              className="h-6 w-20 rounded border border-slate-600 bg-slate-900 px-1.5 text-[10px] text-slate-400 focus:border-blue-500 focus:outline-none"
            />
            {editColor && (
              <button
                onClick={() => setEditColor("")}
                className="text-[10px] text-slate-500 hover:text-red-400"
              >
                ×
              </button>
            )}
          </div>
          <input
            value={editImage}
            onChange={(e) => setEditImage(e.target.value)}
            placeholder="Image URL"
            className="h-6 flex-1 rounded border border-slate-600 bg-slate-900 px-1.5 text-[10px] text-slate-400 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex justify-end gap-1.5">
          <button
            onClick={() => setIsEditing(false)}
            className="rounded px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            onClick={commitEdit}
            className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-1 rounded px-1 py-1 hover:bg-slate-700/30"
      onDoubleClick={openEdit}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab rounded p-0.5 text-slate-700 hover:text-slate-500 active:cursor-grabbing group-hover:text-slate-500"
      >
        <GripVertical className="h-3 w-3" />
      </button>

      {/* Color dot */}
      {displayColor && (
        <div
          className="h-2 w-2 shrink-0 rounded-full ring-1 ring-white/10"
          style={{ backgroundColor: displayColor }}
          title={item.color ? `Item: ${item.color}` : `Group: ${displayColor}`}
        />
      )}

      {/* Image thumbnail */}
      {item.posImagePath && (
        <img
          src={item.posImagePath}
          alt=""
          className="h-5 w-5 shrink-0 rounded object-cover"
        />
      )}

      <span className="flex-1 truncate text-xs text-slate-300">
        {item.name}
      </span>

      {/* Bar item indicator */}
      {item.isBarItem && (
        <span title="Bar item">
          <Wine className="h-3 w-3 shrink-0 text-rose-400" />
        </span>
      )}

      {/* Modifier template badges */}
      {assignedTemplates.length > 0 && (
        <div className="flex items-center gap-0.5">
          {assignedTemplates.map((t) => (
            <span
              key={t.id}
              className="max-w-[60px] truncate rounded bg-slate-700 px-1 py-0.5 text-[9px] text-slate-400"
              title={t.name}
            >
              {t.name}
            </span>
          ))}
        </div>
      )}

      <span className="shrink-0 text-xs tabular-nums text-slate-500">
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
