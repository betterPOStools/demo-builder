"use client";

import { useState, useCallback } from "react";
import { Lightbox, type LightboxImage } from "@/components/ui/Lightbox";
import {
  Palette,
  Sparkles,
  Loader2,
  Check,
  X,
  Trash2,
  Library,
  Wand2,
  ScanSearch,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useStore } from "@/store";
import type { SavedBrandAnalysis } from "@/store/designSlice";
import { isLightColor, generateId } from "@/lib/utils";
import { htmlToPng } from "@/lib/htmlToPng";
import { splitBrandingImage, splitUploadedImage, COMBINED_W, COMBINED_H } from "@/lib/splitBrandingImage";

const TRANSPARENT = "rgba(0,0,0,0)";

function ColorField({
  label,
  value,
  onChange,
  allowTransparent,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  allowTransparent?: boolean;
}) {
  const isTransparent = value === TRANSPARENT;
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={isTransparent ? "#000000" : (value || "#000000")}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-8 cursor-pointer rounded border border-slate-700"
        />
        <Input
          value={isTransparent ? "transparent" : (value || "")}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder="#000000"
          className="h-8 w-28 font-mono text-xs"
        />
        {allowTransparent && (
          <button
            onClick={() => onChange(isTransparent ? null : TRANSPARENT)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
              isTransparent
                ? "bg-slate-500 text-white"
                : "border border-slate-600 text-slate-400 hover:border-slate-400 hover:text-slate-200"
            }`}
          >
            ⬜ Clear
          </button>
        )}
        {value && !isTransparent && (
          <button
            onClick={() => onChange(null)}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function BrandTokenDisplay({ tokens }: { tokens: Record<string, unknown> }) {
  const palette = tokens.color_palette as Record<string, string> | undefined;
  const mood = (tokens.mood as string[] | undefined) ?? [];
  const visualStyle = (tokens.visual_style as string[] | undefined) ?? [];
  const imageryKeywords = (tokens.imagery_keywords as string[] | undefined) ?? [];
  const chips = [...mood, ...visualStyle];

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {palette && (
          <div className="flex gap-1.5 items-center">
            {Object.entries(palette).map(([k, v]) => (
              <div
                key={k}
                title={`${k}: ${v}`}
                className="h-5 w-5 rounded border border-slate-600"
                style={{ backgroundColor: v }}
              />
            ))}
            <span className="text-[10px] text-slate-500 ml-1">Brand colors</span>
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {chips.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-blue-950/60 border border-blue-800/50 px-2 py-0.5 text-[10px] text-blue-300"
            >
              {tag}
            </span>
          ))}
        </div>
        {imageryKeywords.length > 0 && (
          <p className="text-[10px] text-slate-500 italic">
            {imageryKeywords.slice(0, 3).join(" · ")}
          </p>
        )}
      </div>
      <p className="text-[10px] text-emerald-400">✓ Brand analysis active — generation will use these tokens</p>
    </div>
  );
}

const PREVIEW_SERVICES = [
  { label: "Dine In", fallback: "#16a34a" },
  { label: "Pick Up", fallback: "#2563eb" },
  { label: "Take Out", fallback: "#d97706" },
  { label: "Bar", fallback: "#dc2626" },
  { label: "Delivery", fallback: "#7c3aed" },
];

interface BrandingPreview {
  palette?: {
    background: string;
    buttons_background_color: string;
    buttons_font_color: string;
  };
  sidebarPng?: string;
  backgroundPng?: string;
}

async function resizeToThumbnail(base64: string, mediaType: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const maxW = 120, maxH = 80;
      const ratio = Math.min(maxW / img.width, maxH / img.height);
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => resolve("");
    img.src = `data:${mediaType};base64,${base64}`;
  });
}

export function BrandingEditor() {
  const branding = useStore((s) => s.branding);
  const updateBranding = useStore((s) => s.updateBranding);
  const restaurantName = useStore((s) => s.restaurantName);
  const restaurantType = useStore((s) => s.restaurantType);
  const groups = useStore((s) => s.groups);
  const imageLibrary = useStore((s) => s.imageLibrary);
  const addGeneratedImage = useStore((s) => s.addGeneratedImage);
  const deleteGeneratedImage = useStore((s) => s.deleteGeneratedImage);
  const brandAnalyses = useStore((s) => s.brandAnalyses);
  const saveBrandAnalysis = useStore((s) => s.saveBrandAnalysis);
  const deleteBrandAnalysis = useStore((s) => s.deleteBrandAnalysis);

  const [styleHints, setStyleHints] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState("");
  const [preview, setPreview] = useState<BrandingPreview | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState(0);

  // Brand Intelligence state
  const [brandUrl, setBrandUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [brandTokens, setBrandTokens] = useState<Record<string, unknown> | null>(null);
  const [brandError, setBrandError] = useState("");


  const bg = branding.background || "#0f172a";
  const btnBg = branding.buttons_background_color;
  const btnFg = branding.buttons_font_color || "#ffffff";

  const payload = {
    restaurantName,
    restaurantType,
    groups: groups.map((g) => g.name),
    styleHints: styleHints.trim() || undefined,
    brandTokens: brandTokens ?? undefined,
  };

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function analyzeBrand(imageFile?: File) {
    setBrandError("");
    setAnalyzing(true);
    try {
      let body: Record<string, unknown>;
      let base64ForThumb: string | null = null;
      let mediaTypeForThumb: string | null = null;

      if (imageFile) {
        const base64 = await fileToBase64(imageFile);
        base64ForThumb = base64;
        mediaTypeForThumb = imageFile.type;
        body = { imageBase64: base64, imageMediaType: imageFile.type, restaurantName };
      } else {
        body = { url: brandUrl.trim(), restaurantName };
      }

      const res = await fetch("/api/analyze-brand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Analysis failed");
      const data = await res.json();
      const tokens = data.tokens as Record<string, unknown>;
      setBrandTokens(tokens);

      // Save to persistent library
      const thumbnailDataUri = base64ForThumb && mediaTypeForThumb
        ? await resizeToThumbnail(base64ForThumb, mediaTypeForThumb)
        : null;
      const sourceLabel = imageFile
        ? (imageFile.name || "Photo")
        : (() => { try { return new URL(brandUrl.trim()).hostname.replace(/^www\./, ""); } catch { return brandUrl.trim(); } })();

      saveBrandAnalysis({
        id: generateId(),
        createdAt: new Date().toISOString(),
        brandName: (tokens.brand_name as string | undefined) || restaurantName || sourceLabel,
        sourceType: imageFile ? "image" : "url",
        sourceLabel,
        thumbnailDataUri,
        tokens,
      });
    } catch (err) {
      setBrandError((err as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function generateAll() {
    setGenerating(true);
    setGenProgress("Generating palette...");
    const result: BrandingPreview = {};

    try {
      // 1. Palette (fast, CSS-based)
      const paletteRes = await fetch("/api/generate-branding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, type: "palette" }),
      });
      if (paletteRes.ok) {
        const data = await paletteRes.json();
        if (data.palette) result.palette = data.palette;
      }

      // 2. Images via fal.ai in parallel
      setGenProgress("Generating images...");

      const imageryKeywords = (brandTokens?.imagery_keywords as string[] | undefined) ?? [];
      const textureWords = (brandTokens?.textureWords as string[] | undefined) ?? [];
      const lightingDesc = (brandTokens?.lightingDescription as string | undefined) ?? "";
      const keywords = [
        ...imageryKeywords.slice(0, 3),
        (brandTokens?.industry as string | undefined) ?? restaurantType ?? "",
      ].filter(Boolean);
      const backgroundPrompt = brandTokens
        ? [lightingDesc, ...imageryKeywords.slice(0, 2), ...textureWords.slice(0, 2)].filter(Boolean).join(". ")
        : [restaurantName, restaurantType, styleHints].filter(Boolean).join(", ") + ", atmospheric cinematic background";
      const hasQuoteText = /"[^"]+"/.test(styleHints);
      const sidebarPrompt = brandTokens
        ? [lightingDesc, ...textureWords.slice(0, 2), ...imageryKeywords.slice(0, 1)].filter(Boolean).join(". ")
        : [restaurantName, restaurantType, styleHints].filter(Boolean).join(", ") + ", atmospheric cinematic vertical";

      const quoteMatch = styleHints.match(/"([^"]+)"/);
      const quoteText = quoteMatch?.[1];

      const [bgData, sbData] = await Promise.all([
        fetch("/api/fetch-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords, backgroundPrompt, assetType: "background", hasQuoteText: false, brandTokens, width: 1024, height: 716 }),
        }).then((r) => r.json()),
        fetch("/api/fetch-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords, sidebarPrompt, assetType: "sidebar", hasQuoteText, quoteText, brandTokens, width: 360, height: 696 }),
        }).then((r) => r.json()),
      ]);

      // fetch-photo returns [fal] — take the fal result (index 0)
      const ts = new Date().toISOString();
      const bgUri = bgData.results?.[0]?.dataUri as string | undefined;
      const sbUri = sbData.results?.[0]?.dataUri as string | undefined;
      const seamlessId = (bgUri && sbUri) ? generateId() : undefined;

      if (bgUri) {
        result.backgroundPng = bgUri;
        addGeneratedImage({ id: generateId(), type: "background", dataUri: bgUri, createdAt: ts, restaurantName: restaurantName || undefined, seamlessId });
      }
      if (sbUri) {
        result.sidebarPng = sbUri;
        addGeneratedImage({ id: generateId(), type: "sidebar", dataUri: sbUri, createdAt: ts, restaurantName: restaurantName || undefined, seamlessId });
      }

      setPreview(result);
      setGenProgress("");
    } catch (err) {
      console.error("Branding generation failed:", err);
      setGenProgress("");
    } finally {
      setGenerating(false);
    }
  }

  async function generateSeamless() {
    setGenerating(true);
    setGenProgress("Generating seamless pair...");
    try {
      const imageryKeywords = (brandTokens?.imagery_keywords as string[] | undefined) ?? [];
      const textureWords = (brandTokens?.textureWords as string[] | undefined) ?? [];
      const lightingDesc = (brandTokens?.lightingDescription as string | undefined) ?? "";
      const keywords = [
        ...imageryKeywords.slice(0, 3),
        (brandTokens?.industry as string | undefined) ?? restaurantType ?? "",
      ].filter(Boolean);
      const backgroundPrompt = brandTokens
        ? [lightingDesc, ...imageryKeywords.slice(0, 2), ...textureWords.slice(0, 2)].filter(Boolean).join(". ")
        : [restaurantName, restaurantType, styleHints].filter(Boolean).join(", ") + ", atmospheric cinematic background";
      const hasQuoteText = /"[^"]+"/.test(styleHints);
      const sidebarPrompt = brandTokens
        ? [lightingDesc, ...textureWords.slice(0, 2), ...imageryKeywords.slice(0, 1)].filter(Boolean).join(". ")
        : [restaurantName, restaurantType, styleHints].filter(Boolean).join(", ") + ", atmospheric cinematic vertical";
      const quoteMatch = styleHints.match(/"([^"]+)"/);
      const quoteText = quoteMatch?.[1];

      const [bgData, sbData] = await Promise.all([
        fetch("/api/fetch-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords, backgroundPrompt, assetType: "background", hasQuoteText: false, brandTokens, width: 1024, height: 716 }),
        }).then((r) => r.json()),
        fetch("/api/fetch-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords, sidebarPrompt, assetType: "sidebar", hasQuoteText, quoteText, brandTokens, width: 360, height: 696 }),
        }).then((r) => r.json()),
      ]);

      const bgUri = bgData.results?.[0]?.dataUri as string | undefined;
      const sbUri = sbData.results?.[0]?.dataUri as string | undefined;

      if (!bgUri && !sbUri) throw new Error("No images returned from fal");

      const ts = new Date().toISOString();
      const seamlessId = generateId();
      if (sbUri) {
        addGeneratedImage({ id: generateId(), type: "sidebar", dataUri: sbUri, createdAt: ts, restaurantName: restaurantName || undefined, seamlessId });
      }
      if (bgUri) {
        addGeneratedImage({ id: generateId(), type: "background", dataUri: bgUri, createdAt: ts, restaurantName: restaurantName || undefined, seamlessId });
      }
      setPreview((prev) => ({
        ...prev,
        ...(sbUri ? { sidebarPng: sbUri } : {}),
        ...(bgUri ? { backgroundPng: bgUri } : {}),
      }));
    } catch (err) {
      console.error("Seamless generation failed:", err);
    } finally {
      setGenerating(false);
      setGenProgress("");
    }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setGenerating(true);
    setGenProgress("Processing image...");
    try {
      const { sidebarPng, backgroundPng } = await splitUploadedImage(file);
      const ts = new Date().toISOString();
      const seamlessId = generateId();
      addGeneratedImage({ id: generateId(), type: "sidebar", dataUri: sidebarPng, createdAt: ts, restaurantName: restaurantName || undefined, seamlessId });
      addGeneratedImage({ id: generateId(), type: "background", dataUri: backgroundPng, createdAt: ts, restaurantName: restaurantName || undefined, seamlessId });
      setPreview((prev) => ({ ...prev, sidebarPng, backgroundPng }));
    } catch (err) {
      console.error("Image split failed:", err);
    } finally {
      setGenerating(false);
      setGenProgress("");
    }
  }

  function acceptAll() {
    if (!preview) return;
    const patch: Record<string, string | null> = {};
    if (preview.palette) {
      patch.background = preview.palette.background;
      patch.buttons_background_color = preview.palette.buttons_background_color;
      patch.buttons_font_color = preview.palette.buttons_font_color;
    }
    if (preview.sidebarPng) patch.sidebar_picture = preview.sidebarPng;
    if (preview.backgroundPng) patch.background_picture = preview.backgroundPng;
    updateBranding(patch);
    setPreview(null);
  }

  function acceptPartial(key: "palette" | "sidebar" | "background") {
    if (!preview) return;
    if (key === "palette" && preview.palette) {
      updateBranding({
        background: preview.palette.background,
        buttons_background_color: preview.palette.buttons_background_color,
        buttons_font_color: preview.palette.buttons_font_color,
      });
    }
    if (key === "sidebar" && preview.sidebarPng) {
      updateBranding({ sidebar_picture: preview.sidebarPng });
    }
    if (key === "background" && preview.backgroundPng) {
      updateBranding({ background_picture: preview.backgroundPng });
    }
  }

  function useLibraryImage(dataUri: string, type: "sidebar" | "background") {
    if (type === "sidebar") {
      updateBranding({ sidebar_picture: dataUri });
    } else {
      updateBranding({ background_picture: dataUri });
    }
    setShowLibrary(false);
  }

  // Group library images: seamless pairs first, then standalone
  const seamlessPairs = (() => {
    const map = new Map<string, { sidebar?: (typeof imageLibrary)[0]; background?: (typeof imageLibrary)[0] }>();
    for (const img of imageLibrary) {
      if (img.seamlessId && (img.type === "sidebar" || img.type === "background")) {
        const pair = map.get(img.seamlessId) ?? {};
        if (img.type === "sidebar") pair.sidebar = img;
        else pair.background = img;
        map.set(img.seamlessId, pair);
      }
    }
    return [...map.entries()].map(([id, pair]) => ({ id, ...pair }));
  })();
  const pairedIds = new Set(imageLibrary.filter((i) => i.seamlessId).map((i) => i.id));
  const sidebarImages = imageLibrary.filter((i) => i.type === "sidebar" && !i.seamlessId);
  const backgroundImages = imageLibrary.filter((i) => i.type === "background" && !i.seamlessId);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="h-4 w-4 text-purple-400" />
            POS Branding
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Brand Intelligence */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-slate-400 flex items-center gap-1.5">
                <ScanSearch className="h-3.5 w-3.5 text-blue-400" />
                Brand Intelligence
              </Label>
              {brandTokens && (
                <button onClick={() => setBrandTokens(null)} className="text-[10px] text-slate-500 hover:text-red-400">
                  Clear
                </button>
              )}
            </div>

            {/* Saved analyses — always visible when entries exist */}
            {brandAnalyses.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1 -mx-0.5 px-0.5">
                {brandAnalyses.map((a) => {
                  const palette = a.tokens.color_palette as Record<string, string> | undefined;
                  const isActive = brandTokens === a.tokens;
                  return (
                    <div
                      key={a.id}
                      className={`group relative flex-shrink-0 cursor-pointer rounded border transition ${
                        isActive
                          ? "border-blue-500 ring-1 ring-blue-500/40"
                          : "border-slate-700 hover:border-slate-500"
                      }`}
                      style={{ width: 80 }}
                      onClick={() => setBrandTokens(a.tokens)}
                      title={a.brandName}
                    >
                      {a.thumbnailDataUri ? (
                        <img
                          src={a.thumbnailDataUri}
                          alt={a.brandName}
                          className="w-full rounded-t object-cover"
                          style={{ height: 52 }}
                        />
                      ) : (
                        <div className="flex gap-0.5 p-1.5 rounded-t" style={{ height: 52, backgroundColor: palette?.background || "#0d1b2a" }}>
                          {palette && Object.values(palette).slice(0, 3).map((c, i) => (
                            <div key={i} className="flex-1 rounded-sm" style={{ backgroundColor: c }} />
                          ))}
                        </div>
                      )}
                      <div className="px-1.5 py-1 bg-slate-900 rounded-b">
                        <p className="text-[9px] text-slate-300 truncate leading-tight">{a.brandName}</p>
                        <p className="text-[8px] text-slate-600 truncate">{a.sourceLabel}</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteBrandAnalysis(a.id); }}
                        className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-red-400 hover:text-red-300 group-hover:block"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {!brandTokens ? (
              <>
                <div className="flex gap-2">
                  <Input
                    value={brandUrl}
                    onChange={(e) => setBrandUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && brandUrl.trim() && analyzeBrand()}
                    placeholder="Website or image URL to analyze…"
                    className="h-8 text-xs flex-1"
                  />
                  <Button
                    size="sm"
                    onClick={() => analyzeBrand()}
                    disabled={analyzing || !brandUrl.trim()}
                    className="h-8 px-3 text-xs"
                  >
                    {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Analyze"}
                  </Button>
                </div>
                <label className={`flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300 ${analyzing ? "pointer-events-none opacity-40" : ""}`}>
                  <Wand2 className="h-3 w-3" />
                  or drop a brand/restaurant photo
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) analyzeBrand(f);
                    }}
                    disabled={analyzing}
                  />
                </label>
                {brandError && <p className="text-[10px] text-red-400">{brandError}</p>}
              </>
            ) : (
              <BrandTokenDisplay tokens={brandTokens} />
            )}
          </div>

          {/* AI Generate Section */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-2.5">
            <Label className="text-xs text-slate-400">AI Branding Generator</Label>
            <Input
              value={styleHints}
              onChange={(e) => setStyleHints(e.target.value)}
              placeholder='Style hints: rustic, tropical, neon... or "Name" to render title in sidebar'
              className="h-8 text-xs"
            />
            <Button
              onClick={generateAll}
              disabled={generating}
              className="w-full gap-2"
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {genProgress || "Generating..."}
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4" />
                  Generate Branding
                </>
              )}
            </Button>
            <p className="text-[10px] text-slate-600">
              Generates color palette + sidebar image + background image
            </p>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={generateSeamless}
                disabled={generating}
                className="flex-1 gap-1.5 text-xs"
                size="sm"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                Generate Seamless
              </Button>
              <label className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-slate-600 bg-transparent px-2 py-1 text-xs font-medium text-slate-300 transition hover:border-slate-400 hover:text-white ${generating ? "pointer-events-none opacity-40" : ""}`}>
                <Wand2 className="h-3.5 w-3.5" />
                Upload &amp; Split
                <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} disabled={generating} />
              </label>
            </div>
            <p className="text-[10px] text-slate-600">
              Seamless: one image split across sidebar + background. Upload: use your own photo.
            </p>
          </div>

          {/* Preview of generated branding */}
          {preview && (
            <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-amber-400">Generated Branding — Review</Label>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    onClick={acceptAll}
                    className="h-6 gap-1 bg-green-600 px-2 text-[10px] hover:bg-green-500"
                  >
                    <Check className="h-3 w-3" /> Apply All
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={generateAll}
                    disabled={generating}
                    className="h-6 px-2 text-[10px]"
                  >
                    {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : "Regenerate"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPreview(null)}
                    className="h-6 px-1.5 text-[10px] text-slate-500"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              {/* Palette preview */}
              {preview.palette && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-slate-400">Color Palette</Label>
                    <button
                      onClick={() => acceptPartial("palette")}
                      className="text-[10px] text-green-400 hover:text-green-300"
                    >
                      Apply colors
                    </button>
                  </div>
                  <div className="flex gap-2">
                    {[
                      { label: "BG", color: preview.palette.background },
                      { label: "Buttons", color: preview.palette.buttons_background_color },
                      { label: "Font", color: preview.palette.buttons_font_color },
                    ].map((c) => (
                      <div key={c.label} className="flex items-center gap-1.5">
                        <div
                          className="h-6 w-6 rounded border border-slate-600"
                          style={{ backgroundColor: c.color }}
                        />
                        <div className="text-[10px]">
                          <div className="text-slate-400">{c.label}</div>
                          <div className="font-mono text-slate-500">{c.color}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Image previews */}
              <div className="flex gap-3">
                {preview.sidebarPng && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-slate-400">Sidebar</Label>
                      <button
                        onClick={() => acceptPartial("sidebar")}
                        className="text-[10px] text-green-400 hover:text-green-300"
                      >
                        Apply
                      </button>
                    </div>
                    <div className="rounded bg-slate-900 p-1">
                      <img src={preview.sidebarPng} alt="" className="h-32 rounded border border-slate-700" />
                    </div>
                  </div>
                )}
                {preview.backgroundPng && (
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-slate-400">Background</Label>
                      <button
                        onClick={() => acceptPartial("background")}
                        className="text-[10px] text-green-400 hover:text-green-300"
                      >
                        Apply
                      </button>
                    </div>
                    <div className="rounded bg-slate-900 p-1">
                      <img src={preview.backgroundPng} alt="" className="max-h-32 w-full rounded border border-slate-700 object-cover" />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Manual Color Controls */}
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField
              label="Background Color"
              value={branding.background}
              onChange={(v) => updateBranding({ background: v })}
            />
            <ColorField
              label="Buttons Background"
              value={branding.buttons_background_color}
              onChange={(v) => updateBranding({ buttons_background_color: v })}
              allowTransparent
            />
            <ColorField
              label="Buttons Font Color"
              value={branding.buttons_font_color}
              onChange={(v) => updateBranding({ buttons_font_color: v })}
            />
          </div>

          {/* Current Images */}
          <div className="grid gap-3 sm:grid-cols-2">
            {/* Sidebar */}
            <div className="space-y-1">
              <Label className="text-xs">Sidebar Picture</Label>
              {branding.sidebar_picture ? (
                <div className="flex items-center gap-2">
                  <div
                    className="h-12 w-6 cursor-pointer overflow-hidden rounded border border-slate-700 hover:border-blue-500/50"
                    onClick={() => { setLightbox([{ src: branding.sidebar_picture!, name: "Sidebar" }]); setLightboxIdx(0); }}
                    title="Click to view full size"
                  >
                    <img src={branding.sidebar_picture} alt="" className="h-full w-full object-cover" />
                  </div>
                  <span className="flex-1 truncate text-[10px] text-slate-500">
                    {branding.sidebar_picture.startsWith("data:") ? "Generated" : "URL"}
                  </span>
                  <button onClick={() => updateBranding({ sidebar_picture: null })} className="text-[10px] text-slate-500 hover:text-red-400">
                    Clear
                  </button>
                </div>
              ) : (
                <p className="text-[10px] text-slate-600">None — use AI generator above</p>
              )}
            </div>

            {/* Background image */}
            <div className="space-y-1">
              <Label className="text-xs">Background Image</Label>
              {branding.background_picture ? (
                <div className="flex items-center gap-2">
                  <div
                    className="h-8 w-14 cursor-pointer overflow-hidden rounded border border-slate-700 hover:border-blue-500/50"
                    onClick={() => { setLightbox([{ src: branding.background_picture!, name: "Background" }]); setLightboxIdx(0); }}
                    title="Click to view full size"
                  >
                    <img src={branding.background_picture} alt="" className="h-full w-full object-cover" />
                  </div>
                  <span className="flex-1 truncate text-[10px] text-slate-500">
                    {branding.background_picture.startsWith("data:") ? "Generated" : "URL"}
                  </span>
                  <button onClick={() => updateBranding({ background_picture: null })} className="text-[10px] text-slate-500 hover:text-red-400">
                    Clear
                  </button>
                </div>
              ) : (
                <p className="text-[10px] text-slate-600">None — use AI generator above</p>
              )}
            </div>
          </div>

          {/* Image Library */}
          {imageLibrary.filter((i) => i.type !== "item").length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setShowLibrary(!showLibrary)}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                <Library className="h-3.5 w-3.5" />
                Image Library ({seamlessPairs.length} seamless · {sidebarImages.length + backgroundImages.length} standalone)
              </button>

              {showLibrary && (
                <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
                  {/* Seamless pairs */}
                  {seamlessPairs.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-[10px] text-slate-500">Seamless Pairs ({seamlessPairs.length})</Label>
                      <div className="flex flex-wrap gap-3">
                        {seamlessPairs.map((pair) => (
                          <div key={pair.id} className="group relative flex gap-0.5 rounded border border-amber-700/40 bg-amber-950/20 p-1 hover:border-amber-500/60">
                            {/* Sidebar thumbnail */}
                            {pair.sidebar && (
                              <div className="relative overflow-hidden rounded">
                                <img
                                  src={pair.sidebar.dataUri}
                                  alt="Sidebar"
                                  className="h-20 w-auto cursor-pointer"
                                  title="Click to use sidebar"
                                  onClick={() => useLibraryImage(pair.sidebar!.dataUri, "sidebar")}
                                />
                              </div>
                            )}
                            {/* Background thumbnail */}
                            {pair.background && (
                              <div className="relative overflow-hidden rounded">
                                <img
                                  src={pair.background.dataUri}
                                  alt="Background"
                                  className="h-20 w-auto cursor-pointer"
                                  title="Click to use background"
                                  onClick={() => useLibraryImage(pair.background!.dataUri, "background")}
                                />
                              </div>
                            )}
                            {/* Apply both */}
                            <button
                              onClick={() => {
                                if (pair.sidebar) useLibraryImage(pair.sidebar.dataUri, "sidebar");
                                if (pair.background) useLibraryImage(pair.background.dataUri, "background");
                              }}
                              className="absolute bottom-1 left-1/2 -translate-x-1/2 hidden rounded bg-amber-600/90 px-2 py-0.5 text-[9px] font-semibold text-white group-hover:block"
                            >
                              Use Both
                            </button>
                            {/* Delete pair */}
                            <button
                              onClick={() => {
                                if (pair.sidebar) deleteGeneratedImage(pair.sidebar.id);
                                if (pair.background) deleteGeneratedImage(pair.background.id);
                              }}
                              className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-red-400 hover:text-red-300 group-hover:block"
                            >
                              <Trash2 className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Standalone sidebars */}
                  {sidebarImages.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-[10px] text-slate-500">Sidebars ({sidebarImages.length})</Label>
                      <div className="flex flex-wrap gap-2">
                        {sidebarImages.map((img, i) => (
                          <div key={img.id} className="group relative overflow-hidden rounded border border-slate-700 hover:border-blue-500/50">
                            <img
                              src={img.dataUri}
                              alt=""
                              className="h-20 w-auto cursor-pointer"
                              onClick={() => useLibraryImage(img.dataUri, "sidebar")}
                              title="Click to use · double-click to view"
                              onDoubleClick={() => {
                                setLightbox(sidebarImages.map((s) => ({ src: s.dataUri, name: "Sidebar" })));
                                setLightboxIdx(i);
                              }}
                            />
                            <button
                              onClick={() => deleteGeneratedImage(img.id)}
                              className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-red-400 hover:text-red-300 group-hover:block"
                            >
                              <Trash2 className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Standalone backgrounds */}
                  {backgroundImages.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-[10px] text-slate-500">Backgrounds ({backgroundImages.length})</Label>
                      <div className="flex flex-wrap gap-2">
                        {backgroundImages.map((img, i) => (
                          <div key={img.id} className="group relative overflow-hidden rounded border border-slate-700 hover:border-purple-500/50">
                            <img
                              src={img.dataUri}
                              alt=""
                              className="h-16 w-auto cursor-pointer"
                              onClick={() => useLibraryImage(img.dataUri, "background")}
                              title="Click to use · double-click to view"
                              onDoubleClick={() => {
                                setLightbox(backgroundImages.map((b) => ({ src: b.dataUri, name: "Background" })));
                                setLightboxIdx(i);
                              }}
                            />
                            <button
                              onClick={() => deleteGeneratedImage(img.id)}
                              className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-red-400 hover:text-red-300 group-hover:block"
                            >
                              <Trash2 className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Mini POS Preview */}
          <div className="space-y-2">
            <Label className="text-xs text-slate-500">Live Preview</Label>
            <div className="overflow-hidden rounded-lg ring-1 ring-slate-700">
              <div className="flex items-center gap-1.5 bg-gray-950 px-2.5 py-1">
                <div className="h-2 w-2 rounded-full bg-red-500" />
                <div className="h-2 w-2 rounded-full bg-yellow-500" />
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span className="ml-1.5 text-[9px] text-slate-600">POS Main Screen</span>
              </div>
              {/* 35% scale: 1024×716 → ~358×251px. Sidebar: 360×696 → ~126×244px, 3px inset */}
              <div
                className="relative overflow-hidden"
                style={{
                  width: "100%",
                  aspectRatio: "1024 / 716",
                  backgroundColor: bg,
                  backgroundImage: branding.background_picture ? `url(${branding.background_picture})` : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                {/* Sidebar — 360/1024 wide, 696/716 tall, 3px from edges */}
                <div
                  className="absolute bg-[#0a0f1a]"
                  style={{ left: 3, top: 3, bottom: 3, width: "31%" }}
                >
                  {branding.sidebar_picture ? (
                    <img src={branding.sidebar_picture} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                {/* Button area — to the right of sidebar */}
                <div
                  className="absolute top-0 h-full flex flex-wrap content-center justify-center gap-1 p-2"
                  style={{ left: "38%", right: 0 }}
                >
                  {PREVIEW_SERVICES.map((s) => {
                    const btnColor = btnBg || s.fallback;
                    const fg = btnFg || (isLightColor(btnColor) ? "#1e293b" : "#ffffff");
                    return (
                      <div
                        key={s.label}
                        className="flex items-center justify-center rounded text-[6px] font-bold"
                        style={{ backgroundColor: btnColor, color: fg, width: "27%", height: "20%" }}
                      >
                        {s.label}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between bg-gray-950 px-2.5 py-0.5">
                <span className="text-[8px] text-slate-600">Branding Preview</span>
                <span className="text-[8px] text-slate-600">
                  {btnBg ? `Buttons: ${btnBg}` : "Default colors"}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {lightbox && (
        <Lightbox
          images={lightbox}
          index={lightboxIdx}
          onClose={() => setLightbox(null)}
          onNavigate={setLightboxIdx}
        />
      )}
    </div>
  );
}
