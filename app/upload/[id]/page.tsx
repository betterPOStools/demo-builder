"use client";

import { use, useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, CheckCircle2, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UploadedFile {
  name: string;
  url: string;
  preview: string;
  status: "uploading" | "done" | "error";
}

function resizeImage(file: File, maxPx = 1800): Promise<Blob> {
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
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas error"))), "image/jpeg", 0.82);
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
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

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

      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : "";
      const entry: UploadedFile = {
        name: file.name,
        url: "",
        preview,
        status: "uploading",
      };
      setUploads((prev) => [...prev, entry]);
      const idx = uploads.length; // capture current length as index

      try {
        // Resize images before upload
        let blob: Blob = file;
        if (file.type.startsWith("image/")) {
          blob = await resizeImage(file);
        }

        const fd = new FormData();
        fd.append("file", blob, file.name.replace(/\.[^.]+$/, ".jpg"));

        const res = await fetch(`/api/upload/${sessionId}`, { method: "POST", body: fd });
        if (!res.ok) throw new Error("Upload failed");
        const data = await res.json();

        setUploads((prev) =>
          prev.map((u, i) =>
            u.name === file.name && u.status === "uploading"
              ? { ...u, url: data.url, status: "done" }
              : u,
          ),
        );
      } catch {
        setUploads((prev) =>
          prev.map((u) =>
            u.name === file.name && u.status === "uploading"
              ? { ...u, status: "error" }
              : u,
          ),
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

      {/* Upload buttons */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10">
        <p className="max-w-xs text-center text-sm text-slate-400">
          Take a photo of each menu page, or select from your camera roll.
        </p>

        {/* Camera */}
        <Button
          className="h-16 w-full max-w-xs gap-3 text-base"
          onClick={() => cameraRef.current?.click()}
        >
          <Camera className="h-6 w-6" />
          Take Photo
        </Button>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
        />

        {/* Gallery / PDF */}
        <Button
          variant="outline"
          className="h-14 w-full max-w-xs gap-3 text-base"
          onClick={() => galleryRef.current?.click()}
        >
          <ImagePlus className="h-5 w-5" />
          Choose from Library
        </Button>
        <input
          ref={galleryRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {/* Upload list */}
      {uploads.length > 0 && (
        <div className="border-t border-slate-800 px-5 py-4">
          {doneCount > 0 && (
            <p className="mb-3 text-center text-sm text-green-400">
              ✓ {doneCount} {doneCount === 1 ? "file" : "files"} sent to your laptop
            </p>
          )}
          <div className="space-y-2">
            {uploads.map((u, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg bg-slate-800/60 px-3 py-2">
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
                {u.status === "uploading" && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-400" />
                )}
                {u.status === "done" && (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
                )}
                {u.status === "error" && (
                  <span className="text-xs text-red-400">Failed</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
