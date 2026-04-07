"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { GroupPanel } from "./GroupPanel";
import type { CategoryName, GroupNode } from "@/lib/types";

interface CategoryPanelProps {
  category: CategoryName;
  groups: GroupNode[];
  itemCount: number;
  borderColor: string;
}

export function CategoryPanel({
  category,
  groups,
  itemCount,
  borderColor,
}: CategoryPanelProps) {
  const [newGroupName, setNewGroupName] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const addGroup = useStore((s) => s.addGroup);

  function handleAddGroup() {
    if (!newGroupName.trim()) return;
    addGroup(newGroupName.trim(), category);
    setNewGroupName("");
    setIsAdding(false);
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-slate-700 bg-slate-800/30",
        `border-t-2 ${borderColor}`,
      )}
    >
      <div className="flex items-center justify-between border-b border-slate-700/50 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">{category}</h3>
          <p className="text-xs text-slate-500">
            {groups.length} groups, {itemCount} items
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setIsAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <SortableContext
        items={groups.map((g) => g.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-1 p-2">
          {groups.map((group) => (
            <GroupPanel key={group.id} group={group} category={category} />
          ))}

          {isAdding && (
            <div className="flex gap-1.5 px-1 py-1">
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddGroup();
                  if (e.key === "Escape") {
                    setIsAdding(false);
                    setNewGroupName("");
                  }
                }}
                placeholder="Group name..."
                autoFocus
                className="h-7 flex-1 rounded border border-slate-600 bg-slate-800 px-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleAddGroup}
              >
                Add
              </Button>
            </div>
          )}

          {groups.length === 0 && !isAdding && (
            <p className="px-2 py-4 text-center text-xs text-slate-600">
              No groups yet
            </p>
          )}
        </div>
      </SortableContext>
    </div>
  );
}
