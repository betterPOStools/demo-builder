"use client";

import { useEffect } from "react";
import { X, Download, ChevronLeft, ChevronRight } from "lucide-react";

export interface LightboxImage {
  src: string;
  name?: string;
}

interface LightboxProps {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
  onNavigate?: (index: number) => void;
}

export function Lightbox({ images, index, onClose, onNavigate }: LightboxProps) {
  const img = images[index];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && onNavigate && index > 0) onNavigate(index - 1);
      if (e.key === "ArrowRight" && onNavigate && index < images.length - 1) onNavigate(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose, onNavigate]);

  if (!img) return null;

  function handleDownload() {
    const a = document.createElement("a");
    a.href = img.src;
    a.download = img.name || "image.png";
    a.click();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      {/* Toolbar */}
      <div
        className="absolute right-4 top-4 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {img.name && (
          <span className="text-sm text-slate-400">{img.name}</span>
        )}
        <button
          onClick={handleDownload}
          className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:bg-slate-700 hover:text-white"
          title="Download"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          onClick={onClose}
          className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:bg-slate-700 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Prev */}
      {onNavigate && index > 0 && (
        <button
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-lg bg-slate-800/80 p-3 text-slate-300 hover:bg-slate-700"
          onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}

      {/* Image */}
      <img
        src={img.src}
        alt={img.name ?? ""}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />

      {/* Next */}
      {onNavigate && index < images.length - 1 && (
        <button
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-lg bg-slate-800/80 p-3 text-slate-300 hover:bg-slate-700"
          onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}

      {/* Counter */}
      {images.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-slate-400">
          {index + 1} / {images.length}
        </div>
      )}
    </div>
  );
}
