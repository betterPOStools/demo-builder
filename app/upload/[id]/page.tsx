"use client";

import { use, useEffect, useId, useState } from "react";
import { Camera, ImagePlus, CheckCircle2, Loader2, Upload } from "lucide-react";

interface UploadedFile {
  key: string;
  name: string;
  url: string;
  preview: string;
  status: "uploading" | "done" | "error";
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

      // Reduce quality until blob fits within Vercel's request body limit
      function tryQuality(q: number) {
        canvas.toBlob(
          (b) => {
            if (!b) { reject(new Error("Canvas error")); return; }
            if (b.size <= MAX_UPLOAD_BYTES || q <= 0.4) {
              resolve(b);
            } else {
              tryQuality(Math.max(0.4, q - 0.08));
            }
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
  const [uploads, setUploads] = useState<UploadedFile[]>([]);
  const cameraId = useId();
  const galleryId = useId();

  useEffect(() => {
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((d) => setRestaurantName(d.session?.restaurant_name ?? null))
      .catch(() => {});
  }, [sessionId]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/") && file.type !== "application/pdf") continue;

      const key = `${file.name}-${Date.now()}`;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : "";

      setUploads((prev) => [...prev, { key, name: file.name, url: "", preview, status: "uploading" }]);

      try {
        let blob: Blob = file;
        if (file.type.startsWith("image/")) blob = await resizeImage(file);

        const fd = new FormData();
        fd.append("file", blob, file.name.replace(/\.[^.]+$/, ".jpg"));

        const res = await fetch(`/api/upload/${sessionId}`, { method: "POST", body: fd });
        if (!res.ok) throw new Error("Upload failed");
        const data = await res.json();

        setUploads((prev) =>
          prev.map((u) => (u.key === key ? { ...u, url: data.url, status: "done" } : u)),
        );
      } catch {
        setUploads((prev) =>
          prev.map((u) => (u.key === key ? { ...u, status: "error" } : u)),
        );
      }
    }
  }

  const doneCount = uploads.filter((u) => u.status === "done").length;

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-white">
      {/* Header */}
      <div className="border-b border-slate-800 px-5 py-4 text-center">
        <p className="text-xs uppercase tracking-widest text-slate-500">Menu Upload</p>
        <h1 className="mt-0.5 text-lg font-semibold">
          {restaurantName ?? "Loading…"}
        </h1>
      </div>

      {/* Upload buttons — use <label> so iOS/Android file picker opens reliably */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10">
        <p className="max-w-xs text-center text-sm text-slate-400">
          Take a photo of each menu page, or select from your camera roll.
        </p>

        {/* Camera — label wraps hidden input, no JS click needed */}
        <label
          htmlFor={cameraId}
          className="flex h-16 w-full max-w-xs cursor-pointer items-center justify-center gap-3 rounded-md bg-blue-600 text-base font-medium text-white transition hover:bg-blue-500 active:bg-blue-700"
        >
          <Camera className="h-6 w-6" />
          Take Photo
        </label>
        <input
          id={cameraId}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
        />

        {/* Gallery / PDF */}
        <label
          htmlFor={galleryId}
          className="flex h-14 w-full max-w-xs cursor-pointer items-center justify-center gap-3 rounded-md border border-slate-600 bg-transparent text-base font-medium text-slate-200 transition hover:border-slate-400 hover:text-white active:bg-slate-800"
        >
          <ImagePlus className="h-5 w-5" />
          Choose from Library
        </label>
        <input
          id={galleryId}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
        />
      </div>

      {/* Upload list */}
      {uploads.length > 0 && (
        <div className="border-t border-slate-800 px-5 py-4">
          {doneCount > 0 && (
            <p className="mb-3 text-center text-sm text-green-400">
              ✓ {doneCount} {doneCount === 1 ? "file" : "files"} sent — you can take more
            </p>
          )}
          <div className="space-y-2">
            {uploads.map((u) => (
              <div key={u.key} className="flex items-center gap-3 rounded-lg bg-slate-800/60 px-3 py-2">
                {u.preview ? (
                  <img src={u.preview} alt="" className="h-10 w-10 rounded object-cover" />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded bg-slate-700">
                    <Upload className="h-5 w-5 text-slate-400" />
                  </div>
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-slate-300">
                  {u.name.replace(/\.[^.]+$/, "")}
                </span>
                {u.status === "uploading" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-400" />}
                {u.status === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />}
                {u.status === "error" && <span className="text-xs text-red-400">Failed</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
