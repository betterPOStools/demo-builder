"use client";

import { TopHeader } from "./TopHeader";
import { PhaseStepper } from "./PhaseStepper";

export function AppShell({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col bg-[#0f1117] text-slate-100">
      <TopHeader />
      <PhaseStepper projectId={projectId} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
      </main>
    </div>
  );
}
