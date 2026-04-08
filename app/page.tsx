"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Layers,
  ChevronRight,
  Trash2,
  Copy,
  Search,
  Pencil,
  Check,
  X,
  Clock,
  Rocket,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { QuickStartDialog } from "@/components/QuickStartDialog";
import { generateId } from "@/lib/utils";
import { toast } from "sonner";

interface Session {
  id: string;
  name: string | null;
  restaurant_name: string | null;
  current_step: number;
  deploy_status: string | null;
  updated_at: string;
  created_at: string;
}

const STEP_LABELS: Record<number, string> = { 1: "Extract", 2: "Design", 3: "Deploy" };
const STEP_COLORS: Record<number, string> = {
  1: "bg-slate-700 text-slate-300",
  2: "bg-blue-900/60 text-blue-300",
  3: "bg-purple-900/60 text-purple-300",
};

function DeployBadge({ status }: { status: string | null }) {
  if (!status || status === "idle") return null;
  if (status === "done")
    return (
      <span className="flex items-center gap-1 text-xs text-green-400">
        <Rocket className="h-3 w-3" /> Deployed
      </span>
    );
  if (status === "failed")
    return (
      <span className="flex items-center gap-1 text-xs text-red-400">
        <AlertCircle className="h-3 w-3" /> Failed
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-yellow-400">
      <Clock className="h-3 w-3" /> {status}
    </span>
  );
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

function SessionRow({
  session,
  onDelete,
  onDuplicate,
  onRename,
}: {
  session: Session;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.restaurant_name || session.name || "");
  const [confirming, setConfirming] = useState(false);

  const displayName = session.restaurant_name || session.name || "Untitled";
  const stepPath = session.current_step === 3 ? "deploy" : session.current_step === 2 ? "design" : "extract";

  function commitRename() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== displayName) {
      onRename(session.id, trimmed);
    }
    setEditing(false);
  }

  function handleDelete() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    onDelete(session.id);
  }

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3 transition-colors hover:border-slate-700 hover:bg-slate-800/50">
      {/* Name + step */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditing(false);
              }}
              className="h-7 w-48 text-sm"
            />
            <button onClick={commitRename} className="text-green-400 hover:text-green-300">
              <Check className="h-4 w-4" />
            </button>
            <button onClick={() => setEditing(false)} className="text-slate-500 hover:text-slate-400">
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className="cursor-pointer truncate font-medium text-slate-200 hover:text-white"
              onClick={() => router.push(`/project/${session.id}/${stepPath}`)}
            >
              {displayName}
            </span>
            <button
              onClick={() => { setEditValue(displayName); setEditing(true); }}
              className="hidden text-slate-600 hover:text-slate-400 group-hover:block"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
          <span>{timeAgo(session.updated_at)}</span>
          <DeployBadge status={session.deploy_status} />
        </div>
      </div>

      {/* Step badge */}
      <Badge
        className={`shrink-0 text-xs ${STEP_COLORS[session.current_step] ?? STEP_COLORS[1]}`}
        variant="secondary"
      >
        {STEP_LABELS[session.current_step] ?? "Extract"}
      </Badge>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-slate-400 hover:text-white"
          onClick={() => router.push(`/project/${session.id}/${stepPath}`)}
        >
          Open <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-slate-500 hover:text-blue-400"
          title="Duplicate"
          onClick={() => onDuplicate(session.id)}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 ${confirming ? "text-red-400 hover:text-red-300" : "text-slate-500 hover:text-red-400"}`}
          title={confirming ? "Click again to confirm" : "Delete"}
          onClick={handleDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default function LibraryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleNewProject() {
    router.push(`/project/${generateId()}/extract`);
  }

  async function handleDelete(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Failed to delete");
      load();
    } else {
      toast.success("Deleted");
    }
  }

  async function handleDuplicate(id: string) {
    const res = await fetch(`/api/sessions/${id}/duplicate`, { method: "POST" });
    if (!res.ok) {
      toast.error("Duplicate failed");
      return;
    }
    const data = await res.json();
    toast.success("Duplicated");
    load();
    router.push(`/project/${data.id}/extract`);
  }

  async function handleRename(id: string, name: string) {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, restaurant_name: name } : s)),
    );
    await fetch(`/api/sessions/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restaurant_name: name }),
    });
  }

  const filtered = sessions.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (s.restaurant_name ?? "").toLowerCase().includes(q) ||
      (s.name ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex min-h-screen flex-col bg-[#0f1117]">
      {/* Header */}
      <div className="border-b border-slate-800 px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Layers className="h-7 w-7 text-blue-500" />
            <h1 className="text-xl font-bold tracking-tight text-white">Demo Builder</h1>
          </div>
          <div className="flex items-center gap-2">
            <QuickStartDialog />
            <Button onClick={handleNewProject} className="gap-2">
              <Plus className="h-4 w-4" /> New Project
            </Button>
          </div>
        </div>
      </div>

      {/* Library */}
      <div className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Projects</h2>
            {!loading && (
              <p className="text-sm text-slate-500">
                {sessions.length} {sessions.length === 1 ? "project" : "projects"}
              </p>
            )}
          </div>
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
            <Input
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[62px] w-full rounded-lg" />
            ))
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Layers className="h-10 w-10 text-slate-700" />
              <p className="text-slate-500">
                {search ? "No projects match your search." : "No projects yet."}
              </p>
              {!search && (
                <Button onClick={handleNewProject} variant="outline" className="gap-2">
                  <Plus className="h-4 w-4" /> Start your first project
                </Button>
              )}
            </div>
          ) : (
            filtered.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onDelete={handleDelete}
                onDuplicate={handleDuplicate}
                onRename={handleRename}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
