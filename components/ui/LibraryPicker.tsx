"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Library, Trash2, Loader2, Upload } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  countLegacyIdbImages,
  listLibrary,
  removeFromLibrary,
  seedLibraryFromLegacyIdb,
} from "@/lib/library/client";
import type { ImageIntent, ImageLibraryEntry } from "@/lib/library/types";

const FILTER_PILLS: { key: "all" | ImageIntent; label: string }[] = [
  { key: "all", label: "All" },
  { key: "sidebar", label: "Sidebars" },
  { key: "background", label: "Backgrounds" },
  { key: "item", label: "Items" },
  { key: "logo-composite", label: "Logo" },
];

export interface LibraryPickerProps {
  intent: ImageIntent;
  onSelect: (entry: ImageLibraryEntry) => void;
  onSelectPair?: (sidebar: ImageLibraryEntry, background: ImageLibraryEntry) => void;
  title?: string;
  thumbnailClass?: string;
}

function FilterPills({
  active,
  counts,
  onChange,
}: {
  active: "all" | ImageIntent;
  counts: Record<string, number>;
  onChange: (key: "all" | ImageIntent) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {FILTER_PILLS.map((pill) => {
        const count = pill.key === "all"
          ? Object.values(counts).reduce((a, b) => a + b, 0)
          : counts[pill.key] ?? 0;
        const isActive = active === pill.key;
        return (
          <button
            key={pill.key}
            onClick={() => onChange(pill.key)}
            className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition ${
              isActive
                ? "bg-purple-600 text-white"
                : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
            }`}
          >
            {pill.label} {count > 0 && <span className="opacity-70">({count})</span>}
          </button>
        );
      })}
    </div>
  );
}

function GridThumb({
  entry,
  onSelect,
  onDelete,
  thumbnailClass,
}: {
  entry: ImageLibraryEntry;
  onSelect: () => void;
  onDelete: () => void;
  thumbnailClass: string;
}) {
  const label = entry.item_name || entry.original_intent;
  return (
    <div className="group relative overflow-hidden rounded border border-slate-700 hover:border-purple-500/50">
      <img
        src={entry.public_url}
        alt={label}
        className={`${thumbnailClass} cursor-pointer object-cover`}
        title={`${label} · click to use`}
        onClick={onSelect}
        loading="lazy"
      />
      <button
        onClick={onDelete}
        className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-red-400 hover:text-red-300 group-hover:block"
        title="Delete from library"
      >
        <Trash2 className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

function groupSeamlessPairs(entries: ImageLibraryEntry[]): {
  pairs: { sidebar: ImageLibraryEntry; background: ImageLibraryEntry }[];
  solo: ImageLibraryEntry[];
} {
  const byPair = new Map<string, ImageLibraryEntry[]>();
  const solo: ImageLibraryEntry[] = [];
  for (const entry of entries) {
    if (!entry.seamless_pair_id) {
      solo.push(entry);
      continue;
    }
    const bucket = byPair.get(entry.seamless_pair_id) ?? [];
    bucket.push(entry);
    byPair.set(entry.seamless_pair_id, bucket);
  }
  const pairs: { sidebar: ImageLibraryEntry; background: ImageLibraryEntry }[] = [];
  for (const bucket of byPair.values()) {
    const sidebar = bucket.find((e) => e.image_type === "sidebar");
    const background = bucket.find((e) => e.image_type === "background");
    if (sidebar && background) pairs.push({ sidebar, background });
    else solo.push(...bucket);
  }
  return { pairs, solo };
}

export function LibraryPicker({
  intent,
  onSelect,
  onSelectPair,
  title = "Image Library",
  thumbnailClass = "h-20 w-20",
}: LibraryPickerProps) {
  const [entries, setEntries] = useState<ImageLibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | ImageIntent>(intent as "all" | ImageIntent);
  const [open, setOpen] = useState(true);
  const [legacyCount, setLegacyCount] = useState<number>(0);
  const [seeding, setSeeding] = useState<{ done: number; total: number } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listLibrary({ limit: 500 });
      setEntries(rows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    void countLegacyIdbImages().then(setLegacyCount);
  }, [refresh]);

  const handleSeed = useCallback(async () => {
    const total = await countLegacyIdbImages();
    if (total === 0) return;
    setSeeding({ done: 0, total });
    const result = await seedLibraryFromLegacyIdb((done, t) =>
      setSeeding({ done, total: t }),
    );
    setSeeding(null);
    setLegacyCount(result.failed > 0 ? result.failed : 0);
    await refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) c[e.original_intent] = (c[e.original_intent] ?? 0) + 1;
    return c;
  }, [entries]);

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.original_intent === filter || e.image_type === filter);
  }, [entries, filter]);

  const { pairs, solo } = useMemo(() => groupSeamlessPairs(filtered), [filtered]);

  const handleDelete = useCallback(
    async (id: string) => {
      await removeFromLibrary(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    },
    [],
  );

  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
      >
        <Library className="h-3.5 w-3.5" />
        {title} ({entries.length})
      </button>

      {open && (
        <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
          <FilterPills active={filter} counts={counts} onChange={setFilter} />

          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading library...
            </div>
          )}

          {error && <div className="text-xs text-red-400">Failed to load: {error}</div>}

          {!loading && entries.length === 0 && !seeding && (
            <div className="text-xs text-slate-500">
              Library is empty. Generate an image and it will appear here, available on every page.
            </div>
          )}

          {!seeding && legacyCount > 0 && (
            <button
              onClick={handleSeed}
              className="flex items-center gap-1.5 rounded border border-purple-700/50 bg-purple-950/30 px-2.5 py-1.5 text-xs text-purple-300 hover:border-purple-500 hover:text-purple-200"
            >
              <Upload className="h-3 w-3" />
              Seed {legacyCount} image{legacyCount === 1 ? "" : "s"} from local IndexedDB
            </button>
          )}

          {seeding && (
            <div className="flex items-center gap-2 text-xs text-purple-300">
              <Loader2 className="h-3 w-3 animate-spin" />
              Seeding library... {seeding.done} / {seeding.total}
            </div>
          )}

          {pairs.length > 0 && onSelectPair && (
            <div className="space-y-1.5">
              <Label className="text-[10px] text-slate-500">Seamless Pairs ({pairs.length})</Label>
              <div className="flex flex-wrap gap-3">
                {pairs.map(({ sidebar, background }) => (
                  <div
                    key={sidebar.seamless_pair_id}
                    className="group relative flex gap-0.5 rounded border border-amber-700/40 bg-amber-950/20 p-1 hover:border-amber-500/60"
                  >
                    <img src={sidebar.public_url} alt="Sidebar" className="h-20 w-auto rounded" loading="lazy" />
                    <img src={background.public_url} alt="Background" className="h-20 w-auto rounded" loading="lazy" />
                    <button
                      onClick={() => onSelectPair(sidebar, background)}
                      className="absolute bottom-1 left-1/2 -translate-x-1/2 hidden rounded bg-amber-600/90 px-2 py-0.5 text-[9px] font-semibold text-white group-hover:block"
                    >
                      Use Both
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {solo.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {solo.map((entry) => (
                <GridThumb
                  key={entry.id}
                  entry={entry}
                  thumbnailClass={thumbnailClass}
                  onSelect={() => onSelect(entry)}
                  onDelete={() => handleDelete(entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
