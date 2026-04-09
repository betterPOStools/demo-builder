"use client";

import { use, useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useStore } from "@/store";
import { useAutoSave } from "@/lib/hooks/useAutoSave";
import { useImageLibrarySync } from "@/lib/hooks/useImageLibrarySync";
import { useBrandAnalysisSync } from "@/lib/hooks/useBrandAnalysisSync";

export default function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [loading, setLoading] = useState(true);
  const hydratedSessionId = useStore((s) => s.hydratedSessionId);
  const hydrateFromSession = useStore((s) => s.hydrateFromSession);
  const resetForNewProject = useStore((s) => s.resetForNewProject);

  // Hydrate store from Supabase session on mount, or reset when project ID changes
  useEffect(() => {
    if (hydratedSessionId === id) {
      setLoading(false);
      return;
    }

    // Different project — reset store first
    resetForNewProject();
    setLoading(true);

    fetch(`/api/sessions/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.session) {
          hydrateFromSession(id, data.session);
        } else {
          // New project — just mark as hydrated with empty state
          hydrateFromSession(id, {});
        }
      })
      .catch(() => {
        hydrateFromSession(id, {});
      })
      .finally(() => setLoading(false));
  }, [id, hydratedSessionId, hydrateFromSession, resetForNewProject]);

  // Auto-save to Supabase
  useAutoSave(id);

  // Sync image library + brand analyses to/from localStorage
  useImageLibrarySync();
  useBrandAnalysisSync();

  if (loading) {
    return (
      <AppShell projectId={id}>
        <div className="flex h-64 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        </div>
      </AppShell>
    );
  }

  return <AppShell projectId={id}>{children}</AppShell>;
}
