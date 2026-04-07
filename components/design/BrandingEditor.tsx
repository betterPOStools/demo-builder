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

export function BrandingEditor() {
  const branding = useStore((s) => s.branding);
  const updateBranding = useStore((s) => s.updateBranding);

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

          {/* Preview */}
          {(branding.background ||
            branding.buttons_background_color ||
            branding.buttons_font_color) && (
            <div className="space-y-2">
              <Label className="text-xs text-slate-500">Preview</Label>
              <div
                className="flex items-center gap-3 rounded-lg border border-slate-700 p-4"
                style={{
                  backgroundColor: branding.background || "#0f1117",
                }}
              >
                <div
                  className="rounded-md px-4 py-2 text-sm font-medium"
                  style={{
                    backgroundColor:
                      branding.buttons_background_color || "#3b82f6",
                    color: branding.buttons_font_color || "#ffffff",
                  }}
                >
                  Sample Button
                </div>
                <div
                  className="rounded-md px-4 py-2 text-sm font-medium"
                  style={{
                    backgroundColor:
                      branding.buttons_background_color || "#3b82f6",
                    color: branding.buttons_font_color || "#ffffff",
                  }}
                >
                  Menu Item
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
