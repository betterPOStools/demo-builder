"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { EditorTabs } from "@/components/design/EditorTabs";
import { useStore } from "@/store";
import { parseMenuRows } from "@/lib/menuImport";

export default function DesignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const extractedRows = useStore((s) => s.extractedRows);
  const extractedModifiers = useStore((s) => s.extractedModifiers);
  const restaurantName = useStore((s) => s.restaurantName);
  const items = useStore((s) => s.items);
  const groups = useStore((s) => s.groups);
  const importExtractedData = useStore((s) => s.importExtractedData);
  const loadTemplates = useStore((s) => s.loadTemplates);
  const setCurrentStep = useStore((s) => s.setCurrentStep);

  useEffect(() => { setCurrentStep(2); }, [setCurrentStep]);

  // Auto-import extraction results if design is empty but extraction has data
  useEffect(() => {
    if (items.length === 0 && extractedRows.length > 0) {
      const parsed = parseMenuRows(extractedRows);
      importExtractedData(parsed, restaurantName);
    }
  }, []); // Run once on mount

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Design Template</h2>
          <p className="text-sm text-slate-400">
            Organize menu items, configure modifiers, and preview your POS layout.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/project/${id}/extract`)}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Extract
          </Button>
          <Button
            onClick={() => router.push(`/project/${id}/deploy`)}
            className="gap-2"
            disabled={items.length === 0}
          >
            Continue to Deploy
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="mb-2 text-sm font-medium text-slate-400">
              No menu items yet
            </p>
            <p className="mb-4 text-xs text-slate-500">
              Go back to extract items from a menu, or add items manually.
            </p>
            <Button
              variant="outline"
              onClick={() => router.push(`/project/${id}/extract`)}
            >
              Go to Extract
            </Button>
          </CardContent>
        </Card>
      ) : (
        <EditorTabs />
      )}
    </div>
  );
}
