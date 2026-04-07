"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileUp, Paintbrush, Rocket, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

const phases = [
  {
    key: "extract",
    label: "Extract",
    icon: FileUp,
    href: (id: string) => `/project/${id}/extract`,
    description: "Upload menus & extract items",
  },
  {
    key: "design",
    label: "Design",
    icon: Paintbrush,
    href: (id: string) => `/project/${id}/design`,
    description: "Build POS template",
  },
  {
    key: "deploy",
    label: "Deploy",
    icon: Rocket,
    href: (id: string) => `/project/${id}/deploy`,
    description: "Push to POS database",
  },
] as const;

type PhaseKey = (typeof phases)[number]["key"];

function getActivePhase(pathname: string): PhaseKey {
  if (pathname.includes("/deploy")) return "deploy";
  if (pathname.includes("/design")) return "design";
  return "extract";
}

export function PhaseStepper({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activePhase = getActivePhase(pathname);
  const extractedRows = useStore((s) => s.extractedRows);
  const items = useStore((s) => s.items);

  function phaseComplete(key: PhaseKey): boolean {
    if (key === "extract") return extractedRows.length > 0;
    if (key === "design") return items.length > 0;
    return false;
  }

  function phaseSummary(key: PhaseKey): string | null {
    if (key === "extract" && extractedRows.length > 0) {
      return `${extractedRows.length} items`;
    }
    if (key === "design" && items.length > 0) {
      const groups = new Set(items.map((i) => i.groupId)).size;
      return `${groups} groups, ${items.length} items`;
    }
    return null;
  }

  return (
    <div className="border-b border-slate-700 bg-slate-900/50">
      <div className="mx-auto flex max-w-5xl items-center justify-center px-4 py-3">
        {phases.map((phase, idx) => {
          const Icon = phase.icon;
          const isActive = activePhase === phase.key;
          const isComplete = phaseComplete(phase.key);
          const summary = phaseSummary(phase.key);
          const phaseIdx = phases.findIndex((p) => p.key === activePhase);
          const isPast = idx < phaseIdx;

          return (
            <div key={phase.key} className="flex items-center">
              {idx > 0 && (
                <div
                  className={cn(
                    "mx-3 h-px w-12 sm:w-20",
                    isPast || isActive ? "bg-blue-500" : "bg-slate-700",
                  )}
                />
              )}
              <Link
                href={phase.href(projectId)}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-4 py-2 transition-colors",
                  isActive
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200",
                )}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium transition-colors",
                    isActive
                      ? "bg-blue-600 text-white"
                      : isComplete
                        ? "bg-green-600/20 text-green-400"
                        : "bg-slate-700 text-slate-400",
                  )}
                >
                  {isComplete && !isActive ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Icon className="h-4 w-4" />
                  )}
                </div>
                <div className="hidden sm:block">
                  <div className="text-sm font-medium">{phase.label}</div>
                  {summary ? (
                    <div className="text-xs text-slate-500">{summary}</div>
                  ) : (
                    <div className="text-xs text-slate-600">{phase.description}</div>
                  )}
                </div>
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
