"use client";

import { use, useEffect, useState } from "react";
import { useStore } from "@/store";
import { POSPreview } from "@/components/design/POSPreview";

export default function FullscreenPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const hydratedSessionId = useStore((s) => s.hydratedSessionId);
  const hydrateFromSession = useStore((s) => s.hydrateFromSession);
  const resetForNewProject = useStore((s) => s.resetForNewProject);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hydratedSessionId === id) {
      setLoading(false);
      return;
    }
    resetForNewProject();
    setLoading(true);
    fetch(`/api/sessions/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.session) {
          hydrateFromSession(id, data.session);
        } else {
          setError(data.error || "Session not found");
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id, hydratedSessionId, hydrateFromSession, resetForNewProject]);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black text-slate-400">
        Loading preview…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-black">
      <POSPreview fullscreen />
    </div>
  );
}
