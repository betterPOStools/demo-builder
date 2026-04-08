"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QrCode, Smartphone, RefreshCw, X, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { useExtraction } from "@/lib/extraction/useExtraction";
import QRCode from "qrcode";

interface RemoteFile {
  name: string;
  url: string;
  created_at: string;
}

export function MobileUploadPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [remoteFiles, setRemoteFiles] = useState<RemoteFile[]>([]);
  const [processedUrls, setProcessedUrls] = useState<Set<string>>(new Set());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { processUrl } = useExtraction();
  const addFiles = useStore((s) => s.addFiles);

  // Use configured network URL if available (avoids QR pointing to localhost).
  // Falls back to window.location.origin (correct in Vercel prod).
  const networkBase =
    process.env.NEXT_PUBLIC_NETWORK_URL ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const uploadUrl = networkBase ? `${networkBase}/upload/${sessionId}` : "";

  // Generate QR code
  useEffect(() => {
    if (!open || !uploadUrl) return;
    QRCode.toDataURL(uploadUrl, { width: 200, margin: 1, color: { dark: "#fff", light: "#0f172a" } })
      .then(setQrDataUrl)
      .catch(() => {});
  }, [open, uploadUrl]);

  // Poll for uploaded files
  const pollUploads = useCallback(async () => {
    if (!open) return;
    try {
      const res = await fetch(`/api/upload/${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      const files: RemoteFile[] = data.files ?? [];
      setRemoteFiles(files);
    } catch {
      // ignore
    }
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    pollUploads();
    const interval = setInterval(pollUploads, 4000);
    return () => clearInterval(interval);
  }, [open, pollUploads]);

  async function processFile(file: RemoteFile) {
    setProcessedUrls((prev) => new Set([...prev, file.url]));
    await processUrl(file.url);
  }

  async function processAll() {
    const unprocessed = remoteFiles.filter((f) => !processedUrls.has(f.url));
    for (const f of unprocessed) {
      await processFile(f);
    }
  }

  const unprocessedCount = remoteFiles.filter((f) => !processedUrls.has(f.url)).length;

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-1.5 text-xs text-slate-400 hover:text-slate-200"
      >
        <Smartphone className="h-3.5 w-3.5" />
        Scan from phone
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <QrCode className="h-4 w-4 text-blue-400" />
          Scan to upload from phone
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen(false)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex gap-6">
        {/* QR code */}
        <div className="shrink-0">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="QR code" className="h-36 w-36 rounded-md" />
          ) : (
            <div className="flex h-36 w-36 items-center justify-center rounded-md bg-slate-900">
              <RefreshCw className="h-5 w-5 animate-spin text-slate-500" />
            </div>
          )}
          <p className="mt-1.5 text-center text-[10px] text-slate-500">Open camera, scan code</p>
        </div>

        {/* Upload list */}
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs text-slate-400">
              {remoteFiles.length === 0
                ? "Waiting for uploads…"
                : `${remoteFiles.length} file${remoteFiles.length !== 1 ? "s" : ""} received`}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-slate-500 hover:text-slate-300"
              onClick={pollUploads}
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>

          <div className="max-h-28 space-y-1 overflow-y-auto">
            {remoteFiles.map((f, i) => {
              const done = processedUrls.has(f.url);
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {done ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-400" />
                  ) : (
                    <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-slate-600" />
                  )}
                  <span className={`min-w-0 flex-1 truncate ${done ? "text-slate-500" : "text-slate-300"}`}>
                    {f.name.replace(/^\d+_/, "").replace(/\.[^.]+$/, "")}
                  </span>
                  {!done && (
                    <button
                      onClick={() => processFile(f)}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      Extract
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {unprocessedCount > 0 && (
            <Button
              size="sm"
              className="mt-3 w-full gap-2 text-xs"
              onClick={processAll}
            >
              Extract All ({unprocessedCount})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
