"use client";

import { useCallback, useState } from "react";
import { Upload, Link as LinkIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { useExtraction } from "@/lib/extraction/useExtraction";

const ACCEPTED_TYPES = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".html",
  ".mhtml",
  ".mht",
  ".htm",
  ".docx",
  ".pptx",
  ".txt",
  ".rtf",
  ".json",
  ".xlsx",
  ".csv",
];

export function FileDropZone() {
  const [isDragOver, setIsDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const addFiles = useStore((s) => s.addFiles);
  const isProcessing = useStore((s) => s.isProcessing);
  const { processUrl } = useExtraction();

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) addFiles(files);
      e.target.value = "";
    },
    [addFiles],
  );

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          "relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 transition-colors",
          isDragOver
            ? "border-blue-500 bg-blue-500/10"
            : "border-slate-700 bg-slate-800/30 hover:border-slate-600",
        )}
      >
        <Upload className="mb-3 h-8 w-8 text-slate-500" />
        <p className="mb-1 text-sm font-medium text-slate-300">
          Drop files here or click to browse
        </p>
        <p className="text-xs text-slate-500">
          PDF, images, HTML, DOCX, PPTX, XLSX, CSV
        </p>
        <input
          type="file"
          multiple
          accept={ACCEPTED_TYPES.join(",")}
          onChange={handleFileInput}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowUrlInput(!showUrlInput)}
          className="gap-1.5 text-xs text-slate-400"
        >
          <LinkIcon className="h-3.5 w-3.5" />
          {showUrlInput ? "Hide URL input" : "Extract from URL"}
        </Button>
      </div>

      {showUrlInput && (
        <div className="flex gap-2">
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://restaurant.com/menu"
            className="h-9 flex-1 rounded-md border border-slate-700 bg-slate-800 px-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
          />
          <Button
            size="sm"
            disabled={!urlInput.trim() || isProcessing}
            onClick={() => {
              const url = urlInput.trim();
              if (url) {
                processUrl(url);
                setUrlInput("");
              }
            }}
          >
            {isProcessing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Extract"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
