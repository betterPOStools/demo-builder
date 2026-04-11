"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Wand2, Loader2, ChevronDown, ChevronUp, Upload, Link as LinkIcon, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface LogoSidebarGeneratorProps {
  brandTokens?: Record<string, unknown> | null;
  onUseSidebar: (dataUri: string) => void;
}

interface GenerationResult {
  dataUri: string;
  cleanLogoDataUri: string;
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function LogoSidebarGenerator({
  brandTokens,
  onUseSidebar,
}: LogoSidebarGeneratorProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"upload" | "url">("upload");

  const [uploadedDataUri, setUploadedDataUri] = useState<string | null>(null);
  const [uploadedMime, setUploadedMime] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState("");

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [applied, setApplied] = useState(false);

  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (phaseTimer.current) clearTimeout(phaseTimer.current);
    };
  }, []);

  const handleFile = useCallback(async (file: File) => {
    try {
      const dataUri = await fileToDataUri(file);
      setUploadedDataUri(dataUri);
      setUploadedMime(file.type || "image/png");
      setResult(null);
      setError("");
      setApplied(false);
    } catch (e) {
      setError(`Failed to read file: ${(e as Error).message}`);
    }
  }, []);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const onDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) void handleFile(file);
  };

  const canGenerateUpload = !!uploadedDataUri && !generating;
  const canGenerateUrl = logoUrl.trim().length > 0 && !generating;

  async function runGeneration(payload: {
    logoBase64?: string;
    logoMimeType?: string;
    logoUrl?: string;
  }) {
    setGenerating(true);
    setError("");
    setResult(null);
    setApplied(false);
    setProgress("Removing background...");

    if (phaseTimer.current) clearTimeout(phaseTimer.current);
    phaseTimer.current = setTimeout(() => {
      setProgress("Generating sidebar...");
    }, 4000);

    try {
      const res = await fetch("/api/generate-logo-sidebar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          brandTokens: brandTokens ?? undefined,
        }),
      });

      if (!res.ok) {
        const { error: msg } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(msg || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as GenerationResult;
      if (!data.dataUri) throw new Error("No image returned");
      setResult(data);
      setProgress("");
    } catch (e) {
      setError((e as Error).message || "Generation failed");
      setProgress("");
    } finally {
      if (phaseTimer.current) {
        clearTimeout(phaseTimer.current);
        phaseTimer.current = null;
      }
      setGenerating(false);
    }
  }

  const generateFromUpload = () => {
    if (!uploadedDataUri) return;
    void runGeneration({ logoBase64: uploadedDataUri, logoMimeType: uploadedMime ?? undefined });
  };

  const generateFromUrl = () => {
    const url = logoUrl.trim();
    if (!url) return;
    void runGeneration({ logoUrl: url });
  };

  const useAsSidebar = () => {
    if (!result) return;
    onUseSidebar(result.dataUri);
    setApplied(true);
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <Label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400">
          <Wand2 className="h-3.5 w-3.5 text-fuchsia-400" />
          Logo Sidebar
        </Label>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-slate-500" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
        )}
      </button>

      {open && (
        <div className="space-y-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "upload" | "url")}>
            <TabsList className="h-7 w-full">
              <TabsTrigger value="upload" className="h-5 flex-1 gap-1 text-[10px]">
                <Upload className="h-3 w-3" /> Upload
              </TabsTrigger>
              <TabsTrigger value="url" className="h-5 flex-1 gap-1 text-[10px]">
                <LinkIcon className="h-3 w-3" /> URL
              </TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="mt-2 space-y-2">
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-600 bg-slate-900/40 px-2 py-2 transition hover:border-slate-400"
              >
                {uploadedDataUri ? (
                  <img
                    src={uploadedDataUri}
                    alt=""
                    className="h-[60px] w-[60px] flex-shrink-0 rounded border border-slate-700 bg-slate-950 object-contain"
                  />
                ) : (
                  <div className="flex h-[60px] w-[60px] flex-shrink-0 items-center justify-center rounded border border-slate-700 bg-slate-950">
                    <Upload className="h-5 w-5 text-slate-600" />
                  </div>
                )}
                <div className="min-w-0 flex-1 text-[10px] text-slate-400">
                  {uploadedDataUri ? (
                    <>
                      <div className="text-slate-300">Logo loaded</div>
                      <div className="text-slate-500">Click to replace or drop new file</div>
                    </>
                  ) : (
                    <>
                      <div className="text-slate-300">Click or drop logo</div>
                      <div className="text-slate-500">PNG, JPG, or SVG raster</div>
                    </>
                  )}
                </div>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onFileInputChange}
                  disabled={generating}
                />
              </label>

              <Button
                size="sm"
                onClick={generateFromUpload}
                disabled={!canGenerateUpload}
                className="w-full gap-1.5 text-xs"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {progress || "Working..."}
                  </>
                ) : (
                  <>
                    <Wand2 className="h-3.5 w-3.5" /> Generate Sidebar
                  </>
                )}
              </Button>
            </TabsContent>

            <TabsContent value="url" className="mt-2 space-y-2">
              <Input
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://restaurant.com/logo.png"
                className="h-8 text-xs"
                disabled={generating}
              />
              <Button
                size="sm"
                onClick={generateFromUrl}
                disabled={!canGenerateUrl}
                className="w-full gap-1.5 text-xs"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {progress || "Working..."}
                  </>
                ) : (
                  <>
                    <Wand2 className="h-3.5 w-3.5" /> Fetch &amp; Use
                  </>
                )}
              </Button>
            </TabsContent>
          </Tabs>

          {error && (
            <p className="rounded border border-red-800/50 bg-red-950/30 px-2 py-1 text-[10px] text-red-300">
              {error}
            </p>
          )}

          {result && (
            <div className="space-y-2 rounded-md border border-fuchsia-500/30 bg-fuchsia-500/5 p-2">
              <Label className="text-[10px] text-fuchsia-300">Result</Label>
              <div className="flex items-start gap-2">
                <img
                  src={result.dataUri}
                  alt="Generated sidebar"
                  className="rounded border border-slate-700"
                  style={{ width: 120, height: 231, objectFit: "cover" }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex flex-col items-center gap-0.5">
                    <img
                      src={result.cleanLogoDataUri}
                      alt="Cleaned logo"
                      className="h-[60px] w-[60px] rounded border border-slate-700 bg-[conic-gradient(at_50%_50%,#1e293b_25%,#0f172a_0_50%,#1e293b_0_75%,#0f172a_0)] bg-[length:12px_12px] object-contain p-1"
                    />
                    <span className="text-[9px] text-slate-500">Background removed</span>
                  </div>
                  <Button
                    size="sm"
                    onClick={useAsSidebar}
                    className={`w-full gap-1 text-[10px] ${applied ? "bg-green-600 hover:bg-green-500" : ""}`}
                  >
                    {applied ? (
                      <>
                        <Check className="h-3 w-3" /> Applied
                      </>
                    ) : (
                      "Use as Sidebar"
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
