"use client";

import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { ArrowRight, Upload, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileDropZone } from "@/components/extract/FileDropZone";
import { FileQueue } from "@/components/extract/FileQueue";
import { ResultsTable } from "@/components/extract/ResultsTable";
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
  const isProcessing = useStore((s) => s.isProcessing);
  const setCurrentStep = useStore((s) => s.setCurrentStep);

  useEffect(() => { setCurrentStep(1); }, [setCurrentStep]);

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
            <p className="mb-1 text-sm font-medium text-slate-400">
              No items extracted yet
            </p>
            <p className="text-xs text-slate-500">
              Drop a file above or paste a URL to get started.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
