"use client";

import { use, useEffect, useId, useState } from "react";
import { Camera, ImagePlus, CheckCircle2, Loader2, Send, X } from "lucide-react";

interface StagedFile {
  key: string;
  name: string;
  preview: string; // object URL — instant, no canvas needed
  file: File;
  status: "staged" | "uploading" | "done" | "error";
}

// Vercel serverless body limit is 4.5 MB. Target well below that.
const MAX_UPLOAD_BYTES = 3.8 * 1024 * 1024;

function resizeImage(file: File, maxPx = 1400): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);

      function tryQuality(q: number) {
        canvas.toBlob(
          (b) => {
            if (!b) { reject(new Error("Canvas error")); return; }
            if (b.size <= MAX_UPLOAD_BYTES || q <= 0.4) resolve(b);
            else tryQuality(Math.max(0.4, q - 0.08));
          },
          "image/jpeg",
          q,
        );
      }
      tryQuality(0.82);
    };
    img.onerror = reject;
    img.src = url;
  });
}

export default function MobileUploadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: sessionId } = use(params);
  const [restaurantName, setRestaurantName] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [sending, setSending] = useState(false);
  const cameraId = useId();
  const galleryId = useId();

  useEffect(() => {
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((d) => setRestaurantName(d.session?.restaurant_name ?? null))
      .catch(() => {});
  }, [sessionId]);

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    // iOS camera sometimes returns empty type — accept anything that looks like an image by extension or type
    const valid = Array.from(files).filter((f) => {
      if (f.type.startsWith("image/") || f.type === "application/pdf") return true;
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      return ["jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "pdf"].includes(ext);
    });
    if (valid.length === 0) return;

    // Instant previews via object URLs — no canvas, no delay
    const entries: StagedFile[] = valid.map((file) => ({
      key: `${file.name}-${Date.now()}-${Math.random()}`,
      name: file.name,
      preview: file.type !== "application/pdf" ? URL.createObjectURL(file) : "",
      file,
      status: "staged",
    }));
    setStaged((prev) => [...prev, ...entries]);
  }

  function removeStaged(key: string) {
    setStaged((prev) => {
      const entry = prev.find((e) => e.key === key);
      if (entry?.preview) URL.revokeObjectURL(entry.preview);
      return prev.filter((e) => e.key !== key);
    });
  }

  async function sendAll() {
    const toSend = staged.filter((e) => e.status === "staged");
    if (toSend.length === 0) return;
    setSending(true);

    // Prevent screen from locking while uploading — kills in-flight fetch on mobile
    let wakeLock: WakeLockSentinel | null = null;
    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch { /* not supported or denied — continue anyway */ }

    for (const entry of toSend) {
      setStaged((prev) =>
        prev.map((e) => (e.key === entry.key ? { ...e, status: "uploading" } : e)),
      );

      try {
        let blob: Blob = entry.file;
        if (entry.file.type !== "application/pdf") blob = await resizeImage(entry.file);

        const fd = new FormData();
        fd.append("file", blob, entry.name.replace(/\.[^.]+$/, ".jpg"));

        const res = await fetch(`/api/upload/${sessionId}`, { method: "POST", body: fd });
        if (!res.ok) throw new Error("Upload failed");

        setStaged((prev) =>
          prev.map((e) => (e.key === entry.key ? { ...e, status: "done" } : e)),
        );
      } catch {
        setStaged((prev) =>
          prev.map((e) => (e.key === entry.key ? { ...e, status: "error" } : e)),
        );
      }
    }

    try { wakeLock?.release(); } catch { /* ignore */ }
    setSending(false);
  }

  const stagedCount = staged.filter((e) => e.status === "staged").length;
  const doneCount = staged.filter((e) => e.status === "done").length;

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-white">
      {/* Header */}
      <div className="border-b border-slate-800 px-5 py-4 text-center">
        <p className="text-xs uppercase tracking-widest text-slate-500">Menu Upload</p>
        <h1 className="mt-0.5 text-lg font-semibold">
          {restaurantName ?? "Menu Upload"}
        </h1>
      </div>

      {/* Photo grid — staged photos with instant thumbnails */}
      {staged.length > 0 && (
        <div className="border-b border-slate-800 px-4 py-4">
          <div className="grid grid-cols-3 gap-2">
            {staged.map((entry) => (
              <div key={entry.key} className="relative aspect-square overflow-hidden rounded-lg bg-slate-800">
                {entry.preview ? (
                  <img src={entry.preview} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-slate-500 text-xs">PDF</div>
                )}

                {/* Status overlay */}
                {entry.status === "staged" && !sending && (
                  <button
                    onClick={() => removeStaged(entry.key)}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
                {entry.status === "uploading" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Loader2 className="h-7 w-7 animate-spin text-white" />
                  </div>
                )}
                {entry.status === "done" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <CheckCircle2 className="h-7 w-7 text-green-400" />
                  </div>
                )}
                {entry.status === "error" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-red-900/50">
                    <span className="text-xs font-medium text-red-300">Failed</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main actions */}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8">
        {staged.length === 0 && (
          <p className="mb-1 max-w-xs text-center text-sm text-slate-400">
            Take photos of each menu page. Review them, then tap Send.
          </p>
        )}

        {/* Camera */}
        <label
          htmlFor={cameraId}
          className="flex h-14 w-full max-w-xs cursor-pointer items-center justify-center gap-3 rounded-md bg-blue-600 text-base font-medium text-white transition hover:bg-blue-500 active:bg-blue-700"
        >
          <Camera className="h-5 w-5" />
          Take Photo
        </label>
        <input
          id={cameraId}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />

        {/* Gallery / PDF */}
        <label
          htmlFor={galleryId}
          className="flex h-12 w-full max-w-xs cursor-pointer items-center justify-center gap-3 rounded-md border border-slate-600 bg-transparent text-sm font-medium text-slate-200 transition hover:border-slate-400 hover:text-white active:bg-slate-800"
        >
          <ImagePlus className="h-4 w-4" />
          Choose from Library
        </label>
        <input
          id={galleryId}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />

        {/* Send button — only shown when there are staged photos */}
        {stagedCount > 0 && (
          <button
            onClick={sendAll}
            disabled={sending}
            className="mt-2 flex h-14 w-full max-w-xs items-center justify-center gap-3 rounded-md bg-green-600 text-base font-semibold text-white transition hover:bg-green-500 active:bg-green-700 disabled:opacity-60"
          >
            <Send className="h-5 w-5" />
            Send {stagedCount} {stagedCount === 1 ? "Photo" : "Photos"}
          </button>
        )}

        {/* Status line while sending */}
        {sending && (
          <p className="text-sm text-blue-300">
            Uploading… please keep this page open
          </p>
        )}

        {/* All done */}
        {!sending && doneCount > 0 && stagedCount === 0 && (
          <p className="text-sm text-green-400">
            ✓ {doneCount} {doneCount === 1 ? "photo" : "photos"} sent — you can take more
          </p>
        )}
      </div>
    </div>
  );
}
