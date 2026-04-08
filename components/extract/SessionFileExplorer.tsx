"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, X, Download, Trash2, RefreshCw, FileText, Loader2, Sparkles, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Lightbox, type LightboxImage } from "@/components/ui/Lightbox";
import { toast } from "sonner";
import { useStore } from "@/store";
import { useExtraction } from "@/lib/extraction/useExtraction";

interface StoredFile {
  name: string;
  url: string;
  created_at: string;
}

function isImage(name: string) {
  return /\.(png|jpe?g|webp|gif|bmp|tiff|heic|heif)$/i.test(name);
}

function cleanName(name: string) {
  return name.replace(/^\d+_/, "");
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface SessionFileExplorerProps {
  sessionId: string;
}

export function SessionFileExplorer({ sessionId }: SessionFileExplorerProps) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [extractingUrls, setExtractingUrls] = useState<Set<string>>(new Set());
  const [extractedUrls, setExtractedUrls] = useState<Set<string>>(new Set());

  const addFiles = useStore((s) => s.addFiles);
  const { processFiles } = useExtraction();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/upload/${sessionId}`);
      const data = await res.json();
      setFiles(data.files ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function handleDelete(filename: string) {
    const prev = files;
    setFiles((f) => f.filter((x) => x.name !== filename));
    const res = await fetch(`/api/upload/${sessionId}?path=${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setFiles(prev);
      toast.error("Delete failed");
    }
  }

  async function extractFile(file: StoredFile) {
    if (extractingUrls.has(file.url) || extractedUrls.has(file.url)) return;
    setExtractingUrls((prev) => new Set([...prev, file.url]));
    try {
      const blob = await fetch(file.url).then((r) => r.blob());
      const ext = file.name.split(".").pop() ?? "jpg";
      const imageFile = new File([blob], cleanName(file.name), {
        type: blob.type || `image/${ext}`,
      });
      addFiles([imageFile]);
      await new Promise((r) => setTimeout(r, 50));
      await processFiles();
      setExtractedUrls((prev) => new Set([...prev, file.url]));
    } catch {
      toast.error(`Failed to extract ${cleanName(file.name)}`);
    } finally {
      setExtractingUrls((prev) => {
        const next = new Set(prev);
        next.delete(file.url);
        return next;
      });
    }
  }

  async function extractAll() {
    const toExtract = files.filter(
      (f) => isImage(f.name) && !extractedUrls.has(f.url) && !extractingUrls.has(f.url),
    );
    for (const f of toExtract) {
      await extractFile(f);
    }
  }

  const imageFiles = files.filter((f) => isImage(f.name));
  const lightboxImages: LightboxImage[] = imageFiles.map((f) => ({
    src: f.url,
    name: cleanName(f.name),
  }));

  const unextractedImages = imageFiles.filter((f) => !extractedUrls.has(f.url));
  const anyExtracting = extractingUrls.size > 0;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-1.5 text-xs text-slate-400 hover:text-slate-200"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        Stored files
      </Button>

      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
          <div className="flex w-full max-w-2xl flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-5 w-5 text-blue-400" />
                <span className="font-semibold text-slate-200">Stored Files</span>
                <span className="text-sm text-slate-500">({files.length})</span>
              </div>
              <div className="flex items-center gap-2">
                {unextractedImages.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-xs text-blue-400 hover:text-blue-300"
                    onClick={extractAll}
                    disabled={anyExtracting}
                  >
                    {anyExtracting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    Extract All ({unextractedImages.length})
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-slate-500"
                  onClick={load}
                  title="Refresh"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-slate-500"
                  onClick={() => setOpen(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Body */}
            <div className="max-h-[60vh] overflow-y-auto p-4">
              {loading && files.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-slate-500 text-sm">
                  Loading…
                </div>
              ) : files.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center gap-2 text-slate-500">
                  <FolderOpen className="h-8 w-8 opacity-30" />
                  <span className="text-sm">No files stored yet.</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {files.map((f) => {
                    const img = isImage(f.name);
                    const imgIdx = imageFiles.findIndex((x) => x.name === f.name);
                    const isExtracting = extractingUrls.has(f.url);
                    const isDone = extractedUrls.has(f.url);
                    return (
                      <div
                        key={f.name}
                        className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-800/50 px-3 py-2"
                      >
                        {/* Thumbnail */}
                        <div
                          className={`h-12 w-12 shrink-0 overflow-hidden rounded border border-slate-700 bg-slate-900 ${img ? "cursor-pointer hover:border-blue-500/50" : ""}`}
                          onClick={() => img && setLightboxIdx(imgIdx)}
                        >
                          {img ? (
                            <img src={f.url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center">
                              <FileText className="h-5 w-5 text-slate-500" />
                            </div>
                          )}
                        </div>

                        {/* Info */}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-slate-200">{cleanName(f.name)}</p>
                          <p className="text-xs text-slate-500">{timeAgo(f.created_at)}</p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1">
                          {/* Extract button for images */}
                          {img && (
                            <button
                              onClick={() => extractFile(f)}
                              disabled={isExtracting || isDone}
                              className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition disabled:opacity-50 enabled:hover:bg-slate-700"
                              title={isDone ? "Already extracted" : "Extract menu items from this image"}
                            >
                              {isExtracting ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                                  <span className="text-blue-400">Extracting…</span>
                                </>
                              ) : isDone ? (
                                <>
                                  <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
                                  <span className="text-green-400">Done</span>
                                </>
                              ) : (
                                <>
                                  <Sparkles className="h-3.5 w-3.5 text-slate-400" />
                                  <span className="text-slate-400">Extract</span>
                                </>
                              )}
                            </button>
                          )}
                          <a
                            href={f.url}
                            download={cleanName(f.name)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded p-1.5 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                          <button
                            onClick={() => handleDelete(f.name)}
                            className="rounded p-1.5 text-slate-500 hover:bg-slate-700 hover:text-red-400"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {lightboxIdx !== null && (
        <Lightbox
          images={lightboxImages}
          index={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onNavigate={setLightboxIdx}
        />
      )}
    </>
  );
}
