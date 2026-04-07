"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Layers, Clock, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QuickStartDialog } from "@/components/QuickStartDialog";
import { generateId } from "@/lib/utils";

interface RecentSession {
  id: string;
  name: string | null;
  restaurant_name: string | null;
  current_step: number;
  updated_at: string;
}

const STEP_LABELS: Record<number, string> = {
  1: "Extract",
  2: "Design",
  3: "Deploy",
};

export default function DashboardPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function handleNewProject() {
    const id = generateId();
    router.push(`/project/${id}/extract`);
  }

  function handleResumeSession(session: RecentSession) {
    const step = session.current_step ?? 1;
    const stepPath =
      step === 3 ? "deploy" : step === 2 ? "design" : "extract";
    router.push(`/project/${session.id}/${stepPath}`);
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-[#0f1117] px-4 pt-24">
      <div className="mb-12 text-center">
        <div className="mb-4 flex items-center justify-center gap-3">
          <Layers className="h-10 w-10 text-blue-500" />
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Demo Builder
          </h1>
        </div>
        <p className="max-w-md text-slate-400">
          Extract menus from any source, design POS templates with drag-and-drop,
          and deploy directly to your restaurant database.
        </p>
      </div>

      <div className="mb-6 flex justify-center">
        <QuickStartDialog />
      </div>

      <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
        <Card
          className="cursor-pointer transition-colors hover:border-blue-500/50 hover:bg-slate-800"
          onClick={handleNewProject}
        >
          <CardHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600/20">
              <Plus className="h-5 w-5 text-blue-400" />
            </div>
            <CardTitle className="text-lg">New Project</CardTitle>
            <CardDescription>
              Start fresh — upload a menu, design a template, and deploy.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-700/50">
              <Clock className="h-5 w-5 text-slate-400" />
            </div>
            <CardTitle className="text-lg">Recent Projects</CardTitle>
            <CardDescription>Resume a previous session.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {loading ? (
              <>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </>
            ) : sessions.length === 0 ? (
              <p className="text-xs text-slate-500">No sessions yet.</p>
            ) : (
              sessions.slice(0, 5).map((s) => (
                <button
                  key={s.id}
                  onClick={() => handleResumeSession(s)}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-slate-800"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-200">
                      {s.restaurant_name || s.name || "Untitled"}
                    </div>
                    <div className="text-xs text-slate-500">
                      {STEP_LABELS[s.current_step] ?? "Extract"} &middot;{" "}
                      {timeAgo(s.updated_at)}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-600" />
                </button>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
