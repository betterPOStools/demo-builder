"use client";

import { useState } from "react";
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
import { isLightColor, generateId } from "@/lib/utils";
import { htmlToPng } from "@/lib/htmlToPng";

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-8 cursor-pointer rounded border border-slate-700"
        />
        <Input
          value={value || ""}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder="#000000"
          className="h-8 w-28 font-mono text-xs"
        />
        {value && (
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

export function BrandingEditor() {
  const branding = useStore((s) => s.branding);
  const updateBranding = useStore((s) => s.updateBranding);
  const restaurantName = useStore((s) => s.restaurantName);
  const restaurantType = useStore((s) => s.restaurantType);
  const groups = useStore((s) => s.groups);
  const imageLibrary = useStore((s) => s.imageLibrary);
  const addGeneratedImage = useStore((s) => s.addGeneratedImage);
  const deleteGeneratedImage = useStore((s) => s.deleteGeneratedImage);

  const [styleHints, setStyleHints] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState("");
  const [preview, setPreview] = useState<BrandingPreview | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState(0);

  const bg = branding.background || "#0f172a";
  const btnBg = branding.buttons_background_color;
  const btnFg = branding.buttons_font_color || "#ffffff";

  const payload = {
    restaurantName,
    restaurantType,
    groups: groups.map((g) => g.name),
    styleHints: styleHints.trim() || undefined,
  };

  async function generateAll() {
    setGenerating(true);
    setGenProgress("Generating palette...");
    const result: BrandingPreview = {};

    try {
      // 1. Palette (fast)
      const paletteRes = await fetch("/api/generate-branding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, type: "palette" }),
      });
      if (paletteRes.ok) {
        const data = await paletteRes.json();
        if (data.palette) result.palette = data.palette;
      }

      // 2. Images in parallel
      setGenProgress("Generating images...");
      const [sidebarRes, bgRes] = await Promise.allSettled([
        fetch("/api/generate-branding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, type: "sidebar" }),
        }).then(async (r) => {
          if (!r.ok) throw new Error("sidebar failed");
          const d = await r.json();
          const png = await htmlToPng(d.html, 360, 696);
          addGeneratedImage({
            id: generateId(),
            type: "sidebar",
            dataUri: png,
            createdAt: new Date().toISOString(),
            restaurantName: restaurantName || undefined,
          });
          return png;
        }),
        fetch("/api/generate-branding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, type: "background" }),
        }).then(async (r) => {
          if (!r.ok) throw new Error("background failed");
          const d = await r.json();
          const png = await htmlToPng(d.html, 1024, 716);
          addGeneratedImage({
            id: generateId(),
            type: "background",
            dataUri: png,
            createdAt: new Date().toISOString(),
            restaurantName: restaurantName || undefined,
          });
          return png;
        }),
      ]);

      if (sidebarRes.status === "fulfilled") result.sidebarPng = sidebarRes.value;
      if (bgRes.status === "fulfilled") result.backgroundPng = bgRes.value;

      setPreview(result);
      setGenProgress("");
    } catch (err) {
      console.error("Branding generation failed:", err);
      setGenProgress("");
    } finally {
      setGenerating(false);
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

  const sidebarImages = imageLibrary.filter((i) => i.type === "sidebar");
  const backgroundImages = imageLibrary.filter((i) => i.type === "background");

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
          {/* AI Generate Section */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-2.5">
            <Label className="text-xs text-slate-400">AI Branding Generator</Label>
            <Input
              value={styleHints}
              onChange={(e) => setStyleHints(e.target.value)}
              placeholder="Style hints: rustic, modern, neon, tropical, elegant, red & gold..."
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
          {imageLibrary.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setShowLibrary(!showLibrary)}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                <Library className="h-3.5 w-3.5" />
                Image Library ({imageLibrary.length})
              </button>

              {showLibrary && (
                <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
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
                              title="Click to use · right-click to view"
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
              <div
                className="relative flex h-48 items-center justify-center"
                style={{
                  backgroundColor: bg,
                  backgroundImage: branding.background_picture ? `url(${branding.background_picture})` : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                {branding.sidebar_picture ? (
                  <div className="absolute left-0 top-0 h-full w-10 bg-[#0a0f1a]">
                    <img src={branding.sidebar_picture} alt="" className="h-full w-full object-cover opacity-80" />
                  </div>
                ) : (
                  <div className="absolute left-0 top-0 h-full w-10 bg-[#0a0f1a]/60" />
                )}
                <div className="flex flex-wrap justify-center gap-2 pl-8">
                  {PREVIEW_SERVICES.map((s) => {
                    const bg = btnBg || s.fallback;
                    const fg = btnFg || (isLightColor(bg) ? "#1e293b" : "#ffffff");
                    return (
                      <div
                        key={s.label}
                        className="flex h-14 w-20 items-center justify-center rounded-lg text-[9px] font-bold shadow-md"
                        style={{ backgroundColor: bg, color: fg }}
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
