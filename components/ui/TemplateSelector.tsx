"use client";

import { useMemo } from "react";
import { Check, Library, Image as ImageIcon, Palette, Shapes } from "lucide-react";
import {
  GENERATION_TEMPLATES,
  getTemplatesForSurface,
  type GenerationSurface,
  type GenerationTemplate,
} from "@/lib/generation/templates";

export interface TemplateSelectorProps {
  surface: GenerationSurface;
  value: string;
  onChange: (templateId: string) => void;
  title?: string;
}

const KIND_ICON: Record<GenerationTemplate["kind"], typeof Library> = {
  library: Library,
  photoreal: ImageIcon,
  design: Shapes,
  illustrative: Palette,
};

const KIND_CLASS: Record<GenerationTemplate["kind"], string> = {
  library: "border-purple-500/50 bg-purple-950/30 text-purple-300",
  photoreal: "border-blue-500/50 bg-blue-950/30 text-blue-300",
  design: "border-amber-500/50 bg-amber-950/30 text-amber-300",
  illustrative: "border-rose-500/50 bg-rose-950/30 text-rose-300",
};

function TemplateCard({
  template,
  active,
  onSelect,
}: {
  template: GenerationTemplate;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = KIND_ICON[template.kind];
  const tint = KIND_CLASS[template.kind];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative flex w-48 shrink-0 flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition ${
        active
          ? `${tint} ring-1 ring-current`
          : "border-slate-700 bg-slate-800/40 text-slate-400 hover:border-slate-500 hover:text-slate-200"
      } ${!template.wired ? "opacity-60" : ""}`}
      disabled={!template.wired}
      title={
        template.wired
          ? template.description
          : `${template.description} — not yet wired`
      }
    >
      {active && (
        <span className="absolute right-1.5 top-1.5 rounded-full bg-current p-0.5">
          <Check className="h-2.5 w-2.5 text-slate-900" />
        </span>
      )}
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold">{template.label}</span>
      </div>
      <span className="text-[10px] leading-tight opacity-80 line-clamp-2">
        {template.description}
      </span>
      {!template.wired && (
        <span className="text-[9px] uppercase tracking-wide opacity-50">
          Coming soon
        </span>
      )}
    </button>
  );
}

export function TemplateSelector({
  surface,
  value,
  onChange,
  title = "Generation Template",
}: TemplateSelectorProps) {
  const templates = useMemo(() => getTemplatesForSurface(surface), [surface]);
  const current = GENERATION_TEMPLATES[value];

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-slate-400">{title}</span>
        {current && (
          <span className="text-[10px] text-slate-500">
            {current.label}
          </span>
        )}
      </div>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {templates.map((t) => (
          <TemplateCard
            key={t.id}
            template={t}
            active={t.id === value}
            onSelect={() => onChange(t.id)}
          />
        ))}
      </div>
    </div>
  );
}
