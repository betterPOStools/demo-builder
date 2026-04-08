"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useRef } from "react";
import { ArrowRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FileDropZone } from "@/components/extract/FileDropZone";
import { FileQueue } from "@/components/extract/FileQueue";
import { ResultsTable } from "@/components/extract/ResultsTable";
import { MobileUploadPanel } from "@/components/extract/MobileUploadPanel";
import { SessionFileExplorer } from "@/components/extract/SessionFileExplorer";
import { useStore } from "@/store";

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

  function handleContinueToDesign() {
    router.push(`/project/${id}/design`);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Extract Menu Items</h2>
          <p className="text-sm text-slate-400">
            Upload PDFs, images, or HTML files to extract menu data using AI.
          </p>
        </div>
        {extractedRows.length > 0 && (
          <Button onClick={handleContinueToDesign} className="gap-2">
            Continue to Design
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>

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

      {extractedRows.length === 0 && files.length === 0 && (
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
    </div>
  );
}
