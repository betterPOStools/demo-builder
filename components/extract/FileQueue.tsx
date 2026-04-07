"use client";

import { File, Globe, X, Loader2, Check, AlertCircle, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { useExtraction } from "@/lib/extraction/useExtraction";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const statusConfig = {
  pending: { icon: File, color: "text-slate-400", label: "Pending" },
  processing: { icon: Loader2, color: "text-blue-400", label: "Processing..." },
  done: { icon: Check, color: "text-green-400", label: "Done" },
  error: { icon: AlertCircle, color: "text-red-400", label: "Error" },
};

export function FileQueue() {
  const files = useStore((s) => s.files);
  const removeFile = useStore((s) => s.removeFile);
  const isProcessing = useStore((s) => s.isProcessing);
  const { processFiles } = useExtraction();

  const pendingCount = files.filter((f) => f.status === "pending").length;

  if (files.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/30">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2">
        <span className="text-sm font-medium text-slate-300">
          Files ({files.length})
        </span>
        {isProcessing ? (
          <div className="flex items-center gap-2 text-xs text-blue-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Processing...
          </div>
        ) : (
          pendingCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={processFiles}
            >
              <Play className="h-3 w-3" />
              Process {pendingCount === files.length ? "All" : `${pendingCount} Pending`}
            </Button>
          )
        )}
      </div>
      <div className="divide-y divide-slate-700/50">
        {files.map((file) => {
          const config = statusConfig[file.status];
          const Icon = config.icon;
          return (
            <div
              key={file.id}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0",
                  config.color,
                  file.status === "processing" && "animate-spin",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {file.type === "url" && (
                    <Globe className="h-3 w-3 shrink-0 text-blue-400" />
                  )}
                  <p className="truncate text-sm text-slate-200">{file.name}</p>
                  {file.type === "url" && (
                    <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
                      URL
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  {file.type === "url" ? "Web page" : formatSize(file.size)}
                  {file.error && (
                    <span className="ml-2 text-red-400">{file.error}</span>
                  )}
                </p>
              </div>
              <button
                onClick={() => removeFile(file.id)}
                className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
