"use client";

import { useState, useMemo, useCallback } from "react";
import { useStore } from "@/store";
import { isLightColor } from "@/lib/utils";
import {
  BG_W,
  BG_H,
  SIDEBAR_W,
  SIDEBAR_H,
  SIDEBAR_X_OFFSET,
  SIDEBAR_Y_OFFSET,
} from "@/lib/splitBrandingImage";
import type { ItemNode, GroupNode, ModifierTemplateNode } from "@/lib/types";
import type { BrandingState } from "@/store/designSlice";

// ---------- POS layout constants (percentages of 1024×716 frame) ----------
// These match the real Pecan POS overlay model exactly so the preview shows
// the seamless background ↔ sidebar relationship the operator will see in prod.
const SIDEBAR_LEFT_PCT = (SIDEBAR_X_OFFSET / BG_W) * 100;
const SIDEBAR_TOP_PCT = (SIDEBAR_Y_OFFSET / BG_H) * 100;
const SIDEBAR_W_PCT = (SIDEBAR_W / BG_W) * 100;
const SIDEBAR_H_PCT = (SIDEBAR_H / BG_H) * 100;

// ---------- Types ----------

interface OrderLine {
  name: string;
  price: number;
  modifiers: { name: string; price: number }[];
}

// ---------- Color helpers ----------

function resolveColor(
  item: ItemNode | null,
  group: GroupNode | null,
  branding: BrandingState,
): string {
  return (
    item?.color || group?.color || branding.buttons_background_color || "#6b7280"
  );
}

function textColor(bg: string): string {
  return isLightColor(bg) ? "#1e293b" : "#ffffff";
}

// ---------- Service Buttons ----------

const SERVICE_TYPES = [
  { key: "dine_in", label: "Dine In", color: "#16a34a" },
  { key: "pick_up", label: "Pick Up", color: "#2563eb" },
  { key: "take_out", label: "Take Out", color: "#d97706" },
  { key: "bar", label: "Bar", color: "#dc2626" },
  { key: "delivery", label: "Delivery", color: "#7c3aed" },
];

// ---------- MainScreen ----------

function MainScreen({
  branding,
  onStart,
}: {
  branding: BrandingState;
  onStart: () => void;
}) {
  const bg = branding.background || "#0f172a";
  const btnBg = branding.buttons_background_color;
  const btnFg = branding.buttons_font_color;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        backgroundColor: bg,
        backgroundImage: branding.background_picture
          ? `url(${branding.background_picture})`
          : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Sidebar overlay — 360×696 at (10,10) of the 1024×716 canvas.
          Matches the real POS overlay model exactly so the seam between the
          sidebar crop and the background it came from is invisible. */}
      {branding.sidebar_picture && (
        <img
          src={branding.sidebar_picture}
          alt=""
          className="absolute block object-cover"
          style={{
            top: `${SIDEBAR_TOP_PCT}%`,
            left: `${SIDEBAR_LEFT_PCT}%`,
            width: `${SIDEBAR_W_PCT}%`,
            height: `${SIDEBAR_H_PCT}%`,
          }}
          draggable={false}
        />
      )}

      {/* Service buttons — positioned over the right area of the canvas,
          clear of the sidebar overlay footprint */}
      <div
        className="absolute flex flex-wrap items-center justify-center gap-[2.5%]"
        style={{
          top: "10%",
          left: `${SIDEBAR_LEFT_PCT + SIDEBAR_W_PCT + 3}%`,
          right: "4%",
          bottom: "10%",
        }}
      >
        {SERVICE_TYPES.map((s) => (
          <button
            key={s.key}
            onClick={onStart}
            className="flex items-center justify-center rounded-2xl font-bold shadow-xl ring-2 ring-white/20 transition-all hover:scale-105 hover:brightness-110"
            style={{
              backgroundColor: btnBg || s.color,
              color: btnFg || "#ffffff",
              width: "28%",
              aspectRatio: "1.3 / 1",
              fontSize: "clamp(10px, 1.6vw, 16px)",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- ModifierModal ----------

function ModifierModal({
  item,
  template,
  branding,
  onConfirm,
  onCancel,
}: {
  item: ItemNode;
  template: ModifierTemplateNode;
  branding: BrandingState;
  onConfirm: (selections: { name: string; price: number }[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<
    Record<string, Set<string>>
  >(() => {
    const init: Record<string, Set<string>> = {};
    for (const sec of template.sections) {
      const defaults = sec.modifiers
        .filter((m) => m.isDefault)
        .map((m) => m.id);
      init[sec.id] = new Set(defaults);
    }
    return init;
  });

  const btnBg = branding.buttons_background_color || "#3b82f6";
  const btnFg = branding.buttons_font_color || "#ffffff";

  function toggleModifier(sectionId: string, modId: string, maxSel: number) {
    setSelected((prev) => {
      const s = new Set(prev[sectionId]);
      if (s.has(modId)) {
        s.delete(modId);
      } else {
        if (maxSel === 1) {
          s.clear();
        }
        if (s.size < maxSel || maxSel === 0) {
          s.add(modId);
        }
      }
      return { ...prev, [sectionId]: s };
    });
  }

  function handleConfirm() {
    const mods: { name: string; price: number }[] = [];
    for (const sec of template.sections) {
      const sel = selected[sec.id] ?? new Set();
      for (const mod of sec.modifiers) {
        if (sel.has(mod.id)) {
          mods.push({ name: mod.name, price: mod.price });
        }
      }
    }
    onConfirm(mods);
  }

  const totalExtra = template.sections.reduce((sum, sec) => {
    const sel = selected[sec.id] ?? new Set();
    return (
      sum +
      sec.modifiers
        .filter((m) => sel.has(m.id))
        .reduce((s, m) => s + m.price, 0)
    );
  }, 0);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex max-h-[90%] w-full max-w-md flex-col overflow-hidden rounded-xl bg-[#1e293b] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between bg-[#111827] px-4 py-3">
          <div>
            <div className="text-sm font-bold text-white">{item.name}</div>
            <div className="text-xs text-slate-400">
              ${item.defaultPrice.toFixed(2)}
              {totalExtra > 0 && (
                <span className="text-emerald-400">
                  {" "}+ ${totalExtra.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Sections */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {template.sections.map((sec) => (
            <div key={sec.id}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">
                  {sec.name}
                </span>
                <span className="text-[10px] text-slate-500">
                  {sec.minSelections > 0 ? `Required` : "Optional"}
                  {sec.maxSelections > 0 &&
                    ` (max ${sec.maxSelections})`}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {sec.modifiers.map((mod) => {
                  const isSel = selected[sec.id]?.has(mod.id);
                  return (
                    <button
                      key={mod.id}
                      onClick={() =>
                        toggleModifier(
                          sec.id,
                          mod.id,
                          sec.maxSelections,
                        )
                      }
                      className="rounded-lg px-3 py-2 text-left text-xs transition-colors"
                      style={
                        isSel
                          ? { backgroundColor: btnBg, color: btnFg }
                          : {}
                      }
                    >
                      <div
                        className={
                          isSel
                            ? "font-semibold"
                            : "text-gray-300 hover:text-white"
                        }
                      >
                        {mod.name}
                      </div>
                      {mod.price > 0 && (
                        <div
                          className={
                            isSel ? "opacity-80" : "text-slate-500"
                          }
                        >
                          +${mod.price.toFixed(2)}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 bg-[#111827] px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="rounded-lg px-6 py-2 text-sm font-bold transition-colors"
            style={{ backgroundColor: btnBg, color: btnFg }}
          >
            Confirm ${(item.defaultPrice + totalExtra).toFixed(2)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- OrderScreen ----------

function OrderScreen({
  groups,
  items,
  modifierTemplates,
  branding,
}: {
  groups: GroupNode[];
  items: ItemNode[];
  modifierTemplates: ModifierTemplateNode[];
  branding: BrandingState;
}) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    groups[0]?.id ?? null,
  );
  const [orderLines, setOrderLines] = useState<OrderLine[]>([]);
  const [modifierTarget, setModifierTarget] = useState<ItemNode | null>(null);

  const btnBg = branding.buttons_background_color || "#6b7280";
  const btnFg = branding.buttons_font_color || "#ffffff";

  const templateMap = useMemo(() => {
    const m = new Map<string, ModifierTemplateNode>();
    for (const t of modifierTemplates) m.set(t.id, t);
    return m;
  }, [modifierTemplates]);

  const groupsByCategory = useMemo(() => {
    const cats = new Map<string, GroupNode[]>();
    for (const g of groups) {
      const list = cats.get(g.category) ?? [];
      list.push(g);
      cats.set(g.category, list);
    }
    return cats;
  }, [groups]);

  const visibleItems = useMemo(
    () =>
      items
        .filter((i) => i.groupId === selectedGroupId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [items, selectedGroupId],
  );

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;

  const handleItemClick = useCallback(
    (item: ItemNode) => {
      // Check if item has modifier templates
      if (item.modifierTemplateIds.length > 0) {
        const tmpl = templateMap.get(item.modifierTemplateIds[0]);
        if (tmpl) {
          setModifierTarget(item);
          return;
        }
      }
      setOrderLines((prev) => [
        ...prev,
        { name: item.name, price: item.defaultPrice, modifiers: [] },
      ]);
    },
    [templateMap],
  );

  const handleModConfirm = useCallback(
    (mods: { name: string; price: number }[]) => {
      if (!modifierTarget) return;
      setOrderLines((prev) => [
        ...prev,
        {
          name: modifierTarget.name,
          price: modifierTarget.defaultPrice,
          modifiers: mods,
        },
      ]);
      setModifierTarget(null);
    },
    [modifierTarget],
  );

  const subtotal = orderLines.reduce(
    (s, l) =>
      s + l.price + l.modifiers.reduce((ms, m) => ms + m.price, 0),
    0,
  );
  const tax = subtotal * 0.08;
  const total = subtotal + tax;

  return (
    <div className="relative flex h-full">
      {/* Left: Group sidebar */}
      <div className="flex w-[170px] flex-shrink-0 flex-col overflow-y-auto bg-[#0a0f1a]">
        {/* Category tabs */}
        {groupsByCategory.size > 1 && (
          <div className="flex border-b border-white/10">
            {Array.from(groupsByCategory.keys()).map((cat) => (
              <button
                key={cat}
                className="flex-1 px-2 py-1.5 text-[10px] font-medium text-slate-400 hover:text-white"
                onClick={() => {
                  const first = groupsByCategory.get(cat)?.[0];
                  if (first) setSelectedGroupId(first.id);
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-1 p-1">
          {groups.map((g) => {
            const isSelected = g.id === selectedGroupId;
            const gColor = g.color || btnBg;
            return (
              <button
                key={g.id}
                onClick={() => setSelectedGroupId(g.id)}
                className="flex flex-col items-center justify-center rounded-lg px-1 py-2 text-center transition-all"
                style={
                  isSelected
                    ? {
                        backgroundColor: gColor,
                        color: textColor(gColor),
                      }
                    : {
                        borderLeft: `3px solid ${gColor}`,
                        opacity: 0.8,
                      }
                }
              >
                <span
                  className="line-clamp-2 text-[10px] font-semibold leading-tight"
                  style={{
                    color: isSelected ? textColor(gColor) : "#e2e8f0",
                  }}
                >
                  {g.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Center: Item grid */}
      <div className="flex flex-1 flex-wrap content-start gap-2 overflow-y-auto bg-[#111827] p-3">
        {visibleItems.length === 0 && (
          <div className="flex h-full w-full items-center justify-center text-sm text-slate-600">
            {groups.length === 0
              ? "No groups — add items in the Menu tab"
              : "Select a group"}
          </div>
        )}
        {visibleItems.map((item) => {
          const color = resolveColor(item, selectedGroup, branding);
          const hasModifier = item.modifierTemplateIds.length > 0;
          return (
            <button
              key={item.id}
              onClick={() => handleItemClick(item)}
              className="relative flex h-[90px] w-[90px] flex-col items-center justify-center rounded-lg border-2 border-transparent px-1 py-2 transition-all hover:scale-105 hover:border-white/40 hover:brightness-110 active:scale-95"
              style={{
                backgroundColor: color,
                color: textColor(color),
              }}
            >
              {hasModifier && (
                <div className="absolute right-1 top-1 rounded bg-yellow-400 px-0.5 text-[7px] font-bold leading-tight text-black">
                  MOD
                </div>
              )}
              <span className="line-clamp-2 text-center text-[10px] font-semibold leading-tight">
                {item.name}
              </span>
              <span className="mt-1 text-[9px] opacity-75">
                ${item.defaultPrice.toFixed(2)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Right: Order panel */}
      <div className="flex w-56 flex-shrink-0 flex-col border-l border-white/10 bg-black/80">
        <div className="border-b border-white/10 px-3 py-2">
          <span className="text-xs font-semibold text-slate-300">
            Order
          </span>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {orderLines.length === 0 && (
            <div className="py-4 text-center text-[10px] text-slate-600">
              Tap items to add
            </div>
          )}
          {orderLines.map((line, i) => (
            <div key={i} className="text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="w-4 text-right text-xs text-slate-500">
                  1
                </span>
                <span className="flex-1 text-slate-200">{line.name}</span>
                <span className="text-slate-400">
                  ${line.price.toFixed(2)}
                </span>
              </div>
              {line.modifiers.map((m, mi) => (
                <div
                  key={mi}
                  className="ml-6 flex items-center justify-between text-[10px] text-slate-500"
                >
                  <span>{m.name}</span>
                  {m.price > 0 && <span>+${m.price.toFixed(2)}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="space-y-0.5 border-t border-white/10 px-3 py-2 text-[11px]">
          <div className="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span>${subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-slate-500">
            <span>Tax (8%)</span>
            <span>${tax.toFixed(2)}</span>
          </div>
          <div className="flex justify-between font-bold text-white">
            <span>Total</span>
            <span>${total.toFixed(2)}</span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-1.5 px-3 pb-3 pt-1">
          <button
            onClick={() => setOrderLines([])}
            className="rounded bg-gray-800 py-2 text-xs font-bold text-slate-300 hover:bg-gray-700"
          >
            Clear
          </button>
          <button
            className="rounded py-2 text-xs font-bold transition-colors"
            style={{ backgroundColor: "#16a34a", color: "#ffffff" }}
          >
            Pay
          </button>
        </div>
      </div>

      {/* Modifier Modal */}
      {modifierTarget && (
        <ModifierModal
          item={modifierTarget}
          template={
            templateMap.get(modifierTarget.modifierTemplateIds[0])!
          }
          branding={branding}
          onConfirm={handleModConfirm}
          onCancel={() => setModifierTarget(null)}
        />
      )}
    </div>
  );
}

// ---------- Main Component ----------

export function POSPreview() {
  const groups = useStore((s) => s.groups);
  const items = useStore((s) => s.items);
  const modifierTemplates = useStore((s) => s.modifierTemplates);
  const branding = useStore((s) => s.branding);

  const [screen, setScreen] = useState<"main" | "order">("main");

  if (groups.length === 0 && items.length === 0) {
    return (
      <div className="flex h-96 items-center justify-center rounded-xl border border-dashed border-slate-700">
        <p className="text-sm text-slate-500">
          Add menu items to see the POS preview
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setScreen("main")}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            screen === "main"
              ? "bg-slate-700 text-white"
              : "text-slate-400 hover:text-white"
          }`}
        >
          Main Screen
        </button>
        <button
          onClick={() => setScreen("order")}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            screen === "order"
              ? "bg-slate-700 text-white"
              : "text-slate-400 hover:text-white"
          }`}
        >
          Order Entry
        </button>
      </div>

      <div className="overflow-hidden rounded-xl shadow-2xl ring-1 ring-black/20">
        {/* Title bar */}
        <div className="flex items-center gap-1.5 bg-gray-950 px-3 py-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-red-500" />
          <div className="h-2.5 w-2.5 rounded-full bg-yellow-500" />
          <div className="h-2.5 w-2.5 rounded-full bg-green-500" />
          <span className="ml-2 text-[10px] text-slate-500">
            POS Preview
          </span>
        </div>

        {/* Screen — locked to real POS aspect ratio (1024×716) so the sidebar
            overlay and background render in the exact same proportions the
            operator will see in production. */}
        <div
          className="mx-auto w-full bg-[#0f172a]"
          style={{ aspectRatio: `${BG_W} / ${BG_H}`, maxWidth: `${BG_W}px` }}
        >
          {screen === "main" ? (
            <MainScreen
              branding={branding}
              onStart={() => setScreen("order")}
            />
          ) : (
            <OrderScreen
              groups={groups}
              items={items}
              modifierTemplates={modifierTemplates}
              branding={branding}
            />
          )}
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between bg-gray-950 px-3 py-1">
          <span className="text-[9px] text-slate-600">Demo Builder Preview</span>
          <span className="text-[9px] text-slate-600">
            {groups.length} groups, {items.length} items
          </span>
        </div>
      </div>
    </div>
  );
}
