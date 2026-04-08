"use client";

import { useState } from "react";
import {
  Plus,
  Trash2,
  ChevronRight,
  GripVertical,
  Pencil,
  Check,
  X,
  Sparkles,
  BookTemplate,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useStore } from "@/store";
import { cn, generateId } from "@/lib/utils";
import { MODIFIER_PRESETS, PRESET_LIST } from "@/lib/modifierPresets";

export function ModifierDesigner() {
  const templates = useStore((s) => s.modifierTemplates);
  const addTemplate = useStore((s) => s.addTemplate);
  const loadTemplates = useStore((s) => s.loadTemplates);
  const items = useStore((s) => s.items);
  const groups = useStore((s) => s.groups);
  const restaurantName = useStore((s) => s.restaurantName);

  const [isInferring, setIsInferring] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  function addPreset(presetKey: string) {
    const preset = MODIFIER_PRESETS[presetKey];
    if (!preset) return;
    const newTemplate = {
      id: generateId(),
      name: preset.name,
      source: "preset" as const,
      restaurantType: null,
      sections: preset.sections.map((sec) => ({
        id: generateId(),
        name: sec.name,
        sortOrder: 0,
        minSelections: sec.minSelections,
        maxSelections: sec.maxSelections,
        gridColumns: 3,
        modifiers: sec.modifiers.map((mod, i) => ({
          id: generateId(),
          name: mod.name,
          price: mod.price,
          sortOrder: i,
          isDefault: mod.isDefault ?? false,
          imageAssetId: null,
          posImagePath: null,
          isPizzaCrust: false,
          isPizzaTopping: false,
          isBarMixer: false,
          isBarDrink: false,
        })),
      })),
    };
    loadTemplates([...templates, newTemplate]);
    setShowPresets(false);
  }

  async function inferModifiers() {
    if (!items.length) return;
    setIsInferring(true);
    try {
      const payload = items.map((item) => {
        const group = groups.find((g) => g.id === item.groupId);
        return {
          name: item.name,
          price: item.defaultPrice,
          group: group?.name || "Unknown",
        };
      });
      const res = await fetch("/api/infer-modifiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: payload, restaurantName }),
      });
      if (!res.ok) throw new Error("Failed to infer modifiers");
      const data = await res.json();
      if (data.templates?.length) {
        const newTemplates = data.templates.map(
          (t: { name: string; sections: { name: string; min_selections: number; max_selections: number; modifiers: { name: string; price: number; is_default?: boolean }[] }[] }) => ({
            id: generateId(),
            name: t.name,
            source: "ai" as const,
            restaurantType: null,
            sections: t.sections.map((sec: { name: string; min_selections: number; max_selections: number; modifiers: { name: string; price: number; is_default?: boolean }[] }) => ({
              id: generateId(),
              name: sec.name,
              sortOrder: 0,
              minSelections: sec.min_selections,
              maxSelections: sec.max_selections,
              gridColumns: 3,
              modifiers: sec.modifiers.map((mod: { name: string; price: number; is_default?: boolean }, i: number) => ({
                id: generateId(),
                name: mod.name,
                price: mod.price,
                sortOrder: i,
                isDefault: mod.is_default ?? false,
                imageAssetId: null,
                posImagePath: null,
                isPizzaCrust: false,
                isPizzaTopping: false,
                isBarMixer: false,
                isBarDrink: false,
              })),
            })),
          }),
        );
        loadTemplates([...templates, ...newTemplates]);
      }
    } catch (err) {
      console.error("Modifier inference failed:", err);
    } finally {
      setIsInferring(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-400">
          {templates.length} modifier template
          {templates.length !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowPresets(!showPresets)}
            className="gap-1.5 text-xs"
          >
            <BookTemplate className="h-3.5 w-3.5" />
            Presets
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={inferModifiers}
            disabled={isInferring || !items.length}
            className="gap-1.5 text-xs"
          >
            {isInferring ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            )}
            AI Suggest
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => addTemplate("New Template")}
            className="gap-1.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>

      {/* Preset selector */}
      {showPresets && (
        <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-slate-700 bg-slate-800/50 p-2">
          {PRESET_LIST.map((p) => (
            <button
              key={p.key}
              onClick={() => addPreset(p.key)}
              className="rounded-md border border-slate-700/50 bg-slate-800 px-2.5 py-2 text-left hover:border-blue-500/50 hover:bg-slate-700/50"
            >
              <div className="text-xs font-medium text-slate-200">
                {p.name}
              </div>
              <div className="text-[10px] text-slate-500">
                {p.description}
              </div>
            </button>
          ))}
        </div>
      )}

      {templates.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-10">
            <p className="mb-1 text-sm text-slate-400">
              No modifier templates
            </p>
            <p className="text-xs text-slate-500">
              Add presets, use AI to suggest, or create templates manually.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {templates.map((template) => (
            <TemplateCard key={template.id} templateId={template.id} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Template Card ---

function TemplateCard({ templateId }: { templateId: string }) {
  const template = useStore((s) =>
    s.modifierTemplates.find((t) => t.id === templateId),
  );
  const renameTemplate = useStore((s) => s.renameTemplate);
  const deleteTemplate = useStore((s) => s.deleteTemplate);
  const addSection = useStore((s) => s.addSection);

  const [isExpanded, setIsExpanded] = useState(true);
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameValue, setNameValue] = useState("");

  if (!template) return null;

  const totalModifiers = template.sections.reduce(
    (sum, s) => sum + s.modifiers.length,
    0,
  );

  function startRename() {
    setNameValue(template!.name);
    setIsRenaming(true);
  }

  function commitRename() {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== template!.name) {
      renameTemplate(templateId, trimmed);
    }
    setIsRenaming(false);
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/30">
      {/* Template header */}
      <div className="flex items-center gap-2 border-b border-slate-700/50 px-3 py-2.5">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="shrink-0 text-slate-500 hover:text-slate-300"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 transition-transform",
              isExpanded && "rotate-90",
            )}
          />
        </button>

        {isRenaming ? (
          <div className="flex flex-1 items-center gap-1">
            <input
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setIsRenaming(false);
              }}
              autoFocus
              className="h-6 flex-1 rounded border border-blue-500 bg-slate-800 px-2 text-sm text-slate-200 focus:outline-none"
            />
            <button onClick={commitRename} className="text-green-400 hover:text-green-300">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setIsRenaming(false)} className="text-slate-500 hover:text-slate-300">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <span
            className="flex-1 cursor-default text-sm font-medium text-slate-200"
            onDoubleClick={startRename}
          >
            {template.name}
          </span>
        )}

        <span className="text-xs text-slate-500">
          {template.sections.length}s / {totalModifiers}m
        </span>

        {!isRenaming && (
          <button
            onClick={startRename}
            className="rounded p-0.5 text-slate-600 hover:text-slate-300"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={() => deleteTemplate(templateId)}
          className="rounded p-0.5 text-slate-600 hover:text-red-400"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* Sections */}
      {isExpanded && (
        <div className="p-2 space-y-2">
          {template.sections.map((section) => (
            <SectionPanel
              key={section.id}
              templateId={templateId}
              sectionId={section.id}
            />
          ))}

          <button
            onClick={() => addSection(templateId, "New Section")}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-700/50 hover:text-slate-300"
          >
            <Plus className="h-3 w-3" />
            Add Section
          </button>
        </div>
      )}
    </div>
  );
}

// --- Section Panel ---

function SectionPanel({
  templateId,
  sectionId,
}: {
  templateId: string;
  sectionId: string;
}) {
  const section = useStore((s) => {
    const t = s.modifierTemplates.find((t) => t.id === templateId);
    return t?.sections.find((sec) => sec.id === sectionId);
  });
  const updateSection = useStore((s) => s.updateSection);
  const deleteSection = useStore((s) => s.deleteSection);
  const addModifier = useStore((s) => s.addModifier);

  const [isRenaming, setIsRenaming] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [isAddingMod, setIsAddingMod] = useState(false);
  const [newModName, setNewModName] = useState("");
  const [newModPrice, setNewModPrice] = useState("");

  if (!section) return null;

  function commitRename() {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== section!.name) {
      updateSection(templateId, sectionId, { name: trimmed });
    }
    setIsRenaming(false);
  }

  function handleAddModifier() {
    if (!newModName.trim()) return;
    addModifier(
      templateId,
      sectionId,
      newModName.trim(),
      parseFloat(newModPrice) || 0,
    );
    setNewModName("");
    setNewModPrice("");
    setIsAddingMod(false);
  }

  return (
    <div className="rounded border border-slate-700/50 bg-slate-800/70">
      {/* Section header */}
      <div className="flex items-center gap-2 px-2.5 py-2">
        {isRenaming ? (
          <input
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setIsRenaming(false);
            }}
            onBlur={commitRename}
            autoFocus
            className="h-5 flex-1 rounded border border-blue-500 bg-slate-800 px-1.5 text-xs text-slate-200 focus:outline-none"
          />
        ) : (
          <span
            className="flex-1 cursor-default text-xs font-medium text-slate-300"
            onDoubleClick={() => {
              setNameValue(section.name);
              setIsRenaming(true);
            }}
          >
            {section.name}
          </span>
        )}

        {/* Min/Max selections */}
        <div className="flex items-center gap-1 text-[10px] text-slate-500">
          <span>min:</span>
          <input
            type="number"
            min={0}
            value={section.minSelections}
            onChange={(e) =>
              updateSection(templateId, sectionId, {
                minSelections: parseInt(e.target.value) || 0,
              })
            }
            className="h-5 w-8 rounded border border-slate-700 bg-slate-800 px-1 text-center text-[10px] text-slate-300 focus:border-blue-500 focus:outline-none"
          />
          <span>max:</span>
          <input
            type="number"
            min={0}
            value={section.maxSelections}
            onChange={(e) =>
              updateSection(templateId, sectionId, {
                maxSelections: parseInt(e.target.value) || 0,
              })
            }
            className="h-5 w-8 rounded border border-slate-700 bg-slate-800 px-1 text-center text-[10px] text-slate-300 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <button
          onClick={() => deleteSection(templateId, sectionId)}
          className="rounded p-0.5 text-slate-600 hover:text-red-400"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* Modifiers */}
      <div className="border-t border-slate-700/30 px-2 py-1">
        {section.modifiers.map((mod) => (
          <ModifierRow
            key={mod.id}
            templateId={templateId}
            sectionId={sectionId}
            modifierId={mod.id}
          />
        ))}

        {isAddingMod ? (
          <div className="flex gap-1 py-1">
            <input
              value={newModName}
              onChange={(e) => setNewModName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddModifier();
                if (e.key === "Escape") setIsAddingMod(false);
              }}
              placeholder="Modifier name..."
              autoFocus
              className="h-6 flex-1 rounded border border-slate-600 bg-slate-800 px-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
            />
            <input
              value={newModPrice}
              onChange={(e) => setNewModPrice(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddModifier();
              }}
              placeholder="$0"
              className="h-6 w-12 rounded border border-slate-600 bg-slate-800 px-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
            />
            <Button
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={handleAddModifier}
            >
              Add
            </Button>
          </div>
        ) : (
          <button
            onClick={() => setIsAddingMod(true)}
            className="flex w-full items-center gap-1 rounded px-1 py-1 text-[11px] text-slate-600 hover:bg-slate-700/50 hover:text-slate-400"
          >
            <Plus className="h-2.5 w-2.5" />
            Add modifier
          </button>
        )}
      </div>
    </div>
  );
}

// --- Modifier Row ---

function ModifierRow({
  templateId,
  sectionId,
  modifierId,
}: {
  templateId: string;
  sectionId: string;
  modifierId: string;
}) {
  const modifier = useStore((s) => {
    const t = s.modifierTemplates.find((t) => t.id === templateId);
    const sec = t?.sections.find((sec) => sec.id === sectionId);
    return sec?.modifiers.find((m) => m.id === modifierId);
  });
  const updateModifier = useStore((s) => s.updateModifier);
  const deleteModifier = useStore((s) => s.deleteModifier);

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPrice, setEditPrice] = useState("");

  if (!modifier) return null;

  function commitEdit() {
    const trimmed = editName.trim();
    const price = parseFloat(editPrice) || 0;
    if (trimmed) {
      updateModifier(templateId, sectionId, modifierId, {
        name: trimmed,
        price,
      });
    }
    setIsEditing(false);
  }

  if (isEditing) {
    return (
      <div className="flex items-center gap-1 py-0.5">
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setIsEditing(false);
          }}
          autoFocus
          className="h-5 flex-1 rounded border border-blue-500 bg-slate-800 px-1.5 text-[11px] text-slate-200 focus:outline-none"
        />
        <input
          value={editPrice}
          onChange={(e) => setEditPrice(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setIsEditing(false);
          }}
          className="h-5 w-12 rounded border border-blue-500 bg-slate-800 px-1 text-[11px] text-slate-200 focus:outline-none"
        />
        <button
          onClick={commitEdit}
          className="text-green-400 hover:text-green-300"
        >
          <Check className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-slate-700/30"
      onDoubleClick={() => {
        setEditName(modifier.name);
        setEditPrice(String(modifier.price || ""));
        setIsEditing(true);
      }}
    >
      <span className="flex-1 truncate text-[11px] text-slate-400">
        {modifier.name}
      </span>
      {modifier.isDefault && (
        <span className="rounded bg-blue-500/20 px-1 text-[9px] text-blue-400">
          default
        </span>
      )}
      <span className="text-[11px] text-slate-600">
        {modifier.price > 0 ? `+$${modifier.price.toFixed(2)}` : ""}
      </span>
      <button
        onClick={() =>
          updateModifier(templateId, sectionId, modifierId, {
            isDefault: !modifier.isDefault,
          })
        }
        className={cn(
          "hidden rounded px-1 py-0.5 text-[9px] group-hover:block",
          modifier.isDefault
            ? "text-blue-400 hover:text-blue-300"
            : "text-slate-600 hover:text-slate-400",
        )}
      >
        {modifier.isDefault ? "unset" : "set default"}
      </button>
      <button
        onClick={() => deleteModifier(templateId, sectionId, modifierId)}
        className="hidden rounded p-0.5 text-slate-700 hover:text-red-400 group-hover:block"
      >
        <Trash2 className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
