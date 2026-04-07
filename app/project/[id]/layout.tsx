"use client";

import { use, useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useStore } from "@/store";
import { useAutoSave } from "@/lib/hooks/useAutoSave";

export default function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [loading, setLoading] = useState(true);
  const sessionHydrated = useStore((s) => s.sessionHydrated);
  const hydrateFromSession = useStore((s) => s.hydrateFromSession);

  // Hydrate store from Supabase session on mount
  useEffect(() => {
    if (sessionHydrated) {
      setLoading(false);
      return;
    }

    fetch(`/api/sessions/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.session) {
          hydrateFromSession(data.session);
        }
      })
      .catch(() => {
        // Session not found — fresh project
      })
      .finally(() => setLoading(false));
  }, [id, sessionHydrated, hydrateFromSession]);

  // Auto-save to Supabase
  useAutoSave(id);

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
