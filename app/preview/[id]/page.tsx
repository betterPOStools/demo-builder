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
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-black">
      <div
        className="max-h-full max-w-full"
        style={{ aspectRatio: "1024 / 716", width: "100vw", height: "calc(100vw * 716 / 1024)", maxHeight: "100vh", maxWidth: "calc(100vh * 1024 / 716)" }}
      >
        <POSPreview />
      </div>
    </div>
  );
}
