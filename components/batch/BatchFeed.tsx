"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle, Clock, Loader2, FileText, Activity } from "lucide-react";

interface JobRow {
  id: string;
  name: string;
  status: "queued" | "processing" | "done" | "failed" | "needs_pdf";
  error: string | null;
  menu_url: string | null;
  updated_at: string;
}

interface FeedData {
  counts: Record<string, number>;
  jobs: JobRow[];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusIcon({ status }: { status: JobRow["status"] }) {
  if (status === "done")
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  if (status === "failed")
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />;
  if (status === "processing")
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-400" />;
  if (status === "needs_pdf")
    return <FileText className="h-3.5 w-3.5 shrink-0 text-amber-400" />;
  return <Clock className="h-3.5 w-3.5 shrink-0 text-slate-500" />;
}

function StatusLabel({ status }: { status: JobRow["status"] }) {
  const map: Record<JobRow["status"], { label: string; cls: string }> = {
    done:        { label: "done",       cls: "text-emerald-400" },
    failed:      { label: "failed",     cls: "text-red-400" },
    processing:  { label: "active",     cls: "text-blue-400" },
    needs_pdf:   { label: "needs pdf",  cls: "text-amber-400" },
    queued:      { label: "queued",     cls: "text-slate-500" },
  };
  const { label, cls } = map[status] ?? { label: status, cls: "text-slate-500" };
  return <span className={`text-[10px] uppercase tracking-wide ${cls}`}>{label}</span>;
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-slate-500">
        <span>{done.toLocaleString()} done</span>
        <span>{pct}% of {total.toLocaleString()}</span>
      </div>
    </div>
  );
}

function StatPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-md bg-slate-800/60 px-3 py-2">
      <span className={`text-sm font-semibold tabular-nums ${color}`}>
        {value.toLocaleString()}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}

export function BatchFeed() {
  const [data, setData] = useState<FeedData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [pulse, setPulse] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchFeed() {
    try {
      const res = await fetch("/api/batch/feed", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setData(json);
      setLastUpdated(new Date());
      setPulse(true);
      setTimeout(() => setPulse(false), 600);
    } catch {
      // silently ignore — stale data is fine
    }
  }

  useEffect(() => {
    fetchFeed();
    intervalRef.current = setInterval(fetchFeed, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const counts = data?.counts ?? {};
  const jobs = data?.jobs ?? [];

  const done       = counts.done       ?? 0;
  const failed     = counts.failed     ?? 0;
  const queued     = counts.queued     ?? 0;
  const processing = counts.processing ?? 0;
  const needs_pdf  = counts.needs_pdf  ?? 0;
  const total      = done + failed + queued + processing + needs_pdf;
  const terminal   = done + failed + needs_pdf;

  // Split into active/recent + queued for display
  const activeJobs = jobs.filter((j) => j.status === "processing");
  const recentJobs = jobs.filter((j) => j.status !== "queued");
  const displayJobs = [...activeJobs, ...recentJobs.filter((j) => j.status !== "processing")].slice(0, 40);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-200">Batch Queue</span>
        </div>
        <div className="flex items-center gap-2">
          {processing > 0 && (
            <span className="flex items-center gap-1 text-xs text-blue-400">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400"
                style={{ animation: "pulse 1.5s ease-in-out infinite" }}
              />
              live
            </span>
          )}
          {lastUpdated && (
            <span className="text-[10px] text-slate-600">
              {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="border-b border-slate-800 px-4 py-3 space-y-3">
        <ProgressBar done={terminal} total={total} />
        <div className="grid grid-cols-4 gap-1.5">
          <StatPill label="done"    value={done}       color="text-emerald-400" />
          <StatPill label="queued"  value={queued}     color="text-slate-400"   />
          <StatPill label="failed"  value={failed}     color="text-red-400"     />
          <StatPill label="pdf"     value={needs_pdf}  color="text-amber-400"   />
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto">
        {!data ? (
          <div className="flex items-center justify-center py-12 text-slate-600 text-sm">
            Loading…
          </div>
        ) : displayJobs.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-slate-600 text-sm">
            No activity yet
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {displayJobs.map((job) => (
              <div
                key={job.id}
                className={`flex items-start gap-2.5 px-4 py-2.5 transition-colors ${
                  job.status === "processing" ? "bg-blue-950/20" : "hover:bg-slate-800/30"
                }`}
              >
                <div className="mt-0.5">
                  <StatusIcon status={job.status} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium text-slate-300">
                      {job.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-600">
                      {timeAgo(job.updated_at)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <StatusLabel status={job.status} />
                    {job.status === "failed" && job.error && (
                      <span className="truncate text-[10px] text-slate-600" title={job.error}>
                        — {job.error.slice(0, 60)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      {queued > 0 && (
        <div className="border-t border-slate-800 px-4 py-2 text-center">
          <span className="text-[10px] text-slate-600">
            {queued.toLocaleString()} jobs waiting
          </span>
        </div>
      )}
    </div>
  );
}
