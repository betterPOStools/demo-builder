"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Zap } from "lucide-react";
import { generateId } from "@/lib/utils";
import { useStore } from "@/store";
import { RESTAURANT_BUNDLES, cloneBundle } from "@/lib/presets";

export function QuickStartDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const importGroups = (groups: Parameters<typeof useStore.setState>[0]) =>
    useStore.setState(groups);

  async function handleSelect(bundleKey: string) {
    const bundle = RESTAURANT_BUNDLES.find((b) => b.key === bundleKey);
    if (!bundle) return;

    setLoading(bundleKey);
    const projectId = generateId();
    const cloned = cloneBundle(bundle);

    // Load into store — set sessionHydrated so layout skips the empty Supabase fetch
    useStore.setState({
      groups: cloned.groups,
      items: cloned.items,
      rooms: cloned.rooms,
      modifierTemplates: cloned.modifierTemplates,
      restaurantName: cloned.restaurantName,
      designOrigin: { type: "fresh" },
      isDirty: true,
      currentStep: 2,
      sessionHydrated: true,
    });

    // Create session in Supabase
    try {
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: projectId,
          restaurant_name: cloned.restaurantName,
        }),
      });
    } catch {
      // Non-blocking — auto-save will catch up
    }

    setOpen(false);
    router.push(`/project/${projectId}/design`);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Zap className="h-4 w-4" />
          Quick Start
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Quick Start — Choose a Restaurant Type</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {RESTAURANT_BUNDLES.map((b) => {
            const itemCount = b.groups.reduce(
              (sum, g) => sum + g.items.length,
              0,
            );
            return (
              <button
                key={b.key}
                onClick={() => handleSelect(b.key)}
                disabled={loading !== null}
                className="flex flex-col items-start rounded-lg border border-slate-700 p-4 text-left transition-colors hover:border-blue-500/50 hover:bg-slate-800 disabled:opacity-50"
              >
                <span className="mb-2 text-2xl">{b.icon}</span>
                <span className="font-medium text-slate-200">{b.name}</span>
                <span className="mt-1 text-xs text-slate-500">
                  {b.groups.length} groups, {itemCount} items
                </span>
                <span className="mt-1 text-xs text-slate-600">
                  {b.description}
                </span>
                {loading === b.key && (
                  <span className="mt-2 text-xs text-blue-400">Loading...</span>
                )}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
