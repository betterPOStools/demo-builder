"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import { ArrowRight, FileText, Sparkles, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FileDropZone } from "@/components/extract/FileDropZone";
import { FileQueue } from "@/components/extract/FileQueue";
import { ResultsTable } from "@/components/extract/ResultsTable";
import { MobileUploadPanel } from "@/components/extract/MobileUploadPanel";
import { SessionFileExplorer } from "@/components/extract/SessionFileExplorer";
import { useStore } from "@/store";
import { useAutoPilot } from "@/lib/hooks/useAutoPilot";

export default function ExtractPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const extractedRows = useStore((s) => s.extractedRows);
  const files = useStore((s) => s.files);
  const setCurrentStep = useStore((s) => s.setCurrentStep);

  const { isRunning, stepLabel, progress, run } = useAutoPilot();

  // Keywords dialog state
  const [showKeywordsDialog, setShowKeywordsDialog] = useState(false);
  const [keywords, setKeywords] = useState("");
  const keywordsInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setCurrentStep(1); }, [setCurrentStep]);

  // Auto-backup newly added files to Supabase Storage
  const backedUpIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newFiles = files.filter(
      (f) => f.type !== "url" && f.file && !backedUpIds.current.has(f.id),
    );
    for (const qf of newFiles) {
      backedUpIds.current.add(qf.id);
      const fd = new FormData();
      fd.append("file", qf.file, qf.name);
      fetch(`/api/upload/${id}`, { method: "POST", body: fd }).catch(() => {});
    }
  }, [files, id]);

  // Focus input when dialog opens
  useEffect(() => {
    if (showKeywordsDialog) {
      setTimeout(() => keywordsInputRef.current?.focus(), 50);
    }
  }, [showKeywordsDialog]);

  function handleContinueToDesign() {
    router.push(`/project/${id}/design`);
  }

  function handleAutoPilotClick() {
    setShowKeywordsDialog(true);
  }

  function handleKeywordsConfirm() {
    setShowKeywordsDialog(false);
    run({ sessionId: id, styleHints: keywords.trim() || undefined });
  }

  function handleKeywordsKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleKeywordsConfirm();
    if (e.key === "Escape") setShowKeywordsDialog(false);
  }

  const hasContent = extractedRows.length > 0 || files.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Extract Menu Items</h2>
          <p className="text-sm text-slate-400">
            Upload PDFs, images, or HTML files to extract menu data using AI.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* AutoPilot star button */}
          <Button
            variant="outline"
            onClick={handleAutoPilotClick}
            disabled={isRunning}
            className="gap-2 border-yellow-500/40 bg-yellow-500/10 text-yellow-400 hover:border-yellow-400/60 hover:bg-yellow-500/20 hover:text-yellow-300 disabled:opacity-50"
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            AutoPilot
          </Button>

          {extractedRows.length > 0 && (
            <Button onClick={handleContinueToDesign} className="gap-2">
              Continue to Design
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* AutoPilot progress bar */}
      {isRunning && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-yellow-300">{stepLabel}</span>
            <span className="text-xs text-yellow-500">{progress}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-yellow-400 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <FileDropZone />

      {/* Mobile upload QR + file explorer toolbar */}
      <div className="flex items-center gap-1">
        <MobileUploadPanel sessionId={id} />
        <span className="text-slate-700">·</span>
        <SessionFileExplorer sessionId={id} />
      </div>

      {files.length > 0 && <FileQueue />}

      {extractedRows.length > 0 && (
        <>
          <ResultsTable />
          <div className="flex justify-end">
            <Button onClick={handleContinueToDesign} className="gap-2">
              Continue to Design
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </>
      )}

      {!hasContent && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FileText className="mb-4 h-12 w-12 text-slate-600" />
            <p className="mb-1 text-sm font-medium text-slate-400">No items extracted yet</p>
            <p className="text-xs text-slate-500">
              Drop a file above or paste a URL to get started.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Keywords dialog */}
      {showKeywordsDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-yellow-400" />
                  <h3 className="font-semibold text-slate-100">AutoPilot</h3>
                </div>
                <p className="text-sm text-slate-400">
                  Style hints for branding generation (optional).
                </p>
              </div>
              <button
                onClick={() => setShowKeywordsDialog(false)}
                className="rounded p-1 text-slate-500 hover:text-slate-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <input
              ref={keywordsInputRef}
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              onKeyDown={handleKeywordsKeyDown}
              placeholder="e.g. rustic wood, warm amber, farm-to-table"
              className="mb-4 w-full rounded-md border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-yellow-500/60 focus:ring-1 focus:ring-yellow-500/30"
            />

            <p className="mb-4 text-xs text-slate-500">
              AutoPilot will extract items, generate images, infer modifiers, create branding, and deploy — all in one shot. No review step.
            </p>

            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="flex-1 text-slate-400 hover:text-slate-200"
                onClick={() => setShowKeywordsDialog(false)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 gap-2 bg-yellow-500 text-black hover:bg-yellow-400"
                onClick={handleKeywordsConfirm}
              >
                <Sparkles className="h-4 w-4" />
                Launch
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
