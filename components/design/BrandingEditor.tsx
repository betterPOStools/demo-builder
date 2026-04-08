"use client";

import { Palette } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useStore } from "@/store";
import { isLightColor } from "@/lib/utils";

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

export function BrandingEditor() {
  const branding = useStore((s) => s.branding);
  const updateBranding = useStore((s) => s.updateBranding);

  const bg = branding.background || "#0f172a";
  const btnBg = branding.buttons_background_color;
  const btnFg = branding.buttons_font_color || "#ffffff";

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
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField
              label="Background Color"
              value={branding.background}
              onChange={(v) => updateBranding({ background: v })}
            />
            <ColorField
              label="Buttons Background"
              value={branding.buttons_background_color}
              onChange={(v) =>
                updateBranding({ buttons_background_color: v })
              }
            />
            <ColorField
              label="Buttons Font Color"
              value={branding.buttons_font_color}
              onChange={(v) => updateBranding({ buttons_font_color: v })}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Sidebar Picture URL</Label>
            <Input
              value={branding.sidebar_picture || ""}
              onChange={(e) =>
                updateBranding({
                  sidebar_picture: e.target.value || null,
                })
              }
              placeholder="https://example.com/sidebar.png"
              className="h-8 text-xs"
            />
          </div>

          {/* Mini POS Preview */}
          <div className="space-y-2">
            <Label className="text-xs text-slate-500">Live Preview</Label>
            <div className="overflow-hidden rounded-lg ring-1 ring-slate-700">
              {/* Title bar */}
              <div className="flex items-center gap-1.5 bg-gray-950 px-2.5 py-1">
                <div className="h-2 w-2 rounded-full bg-red-500" />
                <div className="h-2 w-2 rounded-full bg-yellow-500" />
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span className="ml-1.5 text-[9px] text-slate-600">
                  POS Main Screen
                </span>
              </div>

              {/* Main screen */}
              <div
                className="relative flex h-48 items-center justify-center"
                style={{ backgroundColor: bg }}
              >
                {/* Sidebar */}
                {branding.sidebar_picture ? (
                  <div className="absolute left-0 top-0 h-full w-10 bg-[#0a0f1a]">
                    <img
                      src={branding.sidebar_picture}
                      alt=""
                      className="h-full w-full object-cover opacity-80"
                    />
                  </div>
                ) : (
                  <div className="absolute left-0 top-0 h-full w-10 bg-[#0a0f1a]/60" />
                )}

                {/* Service buttons */}
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

              {/* Status bar */}
              <div className="flex items-center justify-between bg-gray-950 px-2.5 py-0.5">
                <span className="text-[8px] text-slate-600">
                  Branding Preview
                </span>
                <span className="text-[8px] text-slate-600">
                  {btnBg ? `Buttons: ${btnBg}` : "Default colors"}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
