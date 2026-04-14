"use client";

import { useEffect, useRef, useState } from "react";

function useAnimatedCount(target: number, duration = 500): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    const startTime = performance.now();

    function tick(now: number) {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    }

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);

  return display;
}
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  FileText,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface JobRow {
  id: string;
  name: string;
  status: "queued" | "processing" | "done" | "failed" | "needs_pdf";
  error: string | null;
  updated_at: string;
}

interface FeedData {
  counts: Record<string, number>;
  jobs: JobRow[];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function StatusIcon({ status }: { status: JobRow["status"] }) {
  if (status === "done")
    return <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />;
  if (status === "failed")
    return <XCircle className="h-3 w-3 shrink-0 text-red-400" />;
  if (status === "processing")
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-400" />;
  if (status === "needs_pdf")
    return <FileText className="h-3 w-3 shrink-0 text-amber-400" />;
  return <Clock className="h-3 w-3 shrink-0 text-slate-600" />;
}

export function BatchFeed() {
  const [data, setData] = useState<FeedData | null>(null);
  const [open, setOpen] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchFeed() {
    try {
      const res = await fetch("/api/batch/feed", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch { /* ignore */ }
  }

  useEffect(() => {
    fetchFeed();
    intervalRef.current = setInterval(fetchFeed, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const counts    = data?.counts ?? {};
  const done      = counts.done       ?? 0;
  const failed    = counts.failed     ?? 0;
  const queued    = counts.queued     ?? 0;
  const processing= counts.processing ?? 0;
  const pdf       = counts.needs_pdf  ?? 0;
  const total     = done + failed + queued + processing + pdf;
  const terminal  = done + failed + pdf;
  const pct       = total > 0 ? Math.round((terminal / total) * 100) : 0;

  const aDone    = useAnimatedCount(done);
  const aFailed  = useAnimatedCount(failed);
  const aQueued  = useAnimatedCount(queued);
  const aPdf     = useAnimatedCount(pdf);
  const aPct     = useAnimatedCount(pct);
  const aTerminal= useAnimatedCount(terminal);
  const aTotal   = useAnimatedCount(total);

  // Feed: active first, then recent non-queued, skip plain queued
  const jobs = data?.jobs ?? [];
  const feedJobs = [
    ...jobs.filter((j) => j.status === "processing"),
    ...jobs.filter((j) => j.status !== "processing" && j.status !== "queued"),
  ].slice(0, 40);

  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
      {/* ── Header — always visible ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {/* Live dot */}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            processing > 0 ? "bg-blue-400 animate-pulse" : "bg-slate-600"
          }`}
        />

        {/* Label */}
        <span className="text-sm font-semibold text-slate-200">Batch</span>

        {/* Stat chips */}
        <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {done > 0 && (
            <span className="text-emerald-400">
              <span className="font-semibold tabular-nums">{aDone.toLocaleString()}</span>
              <span className="text-slate-500"> done</span>
            </span>
          )}
          {failed > 0 && (
            <span className="text-red-400">
              <span className="font-semibold tabular-nums">{aFailed.toLocaleString()}</span>
              <span className="text-slate-500"> failed</span>
            </span>
          )}
          {queued > 0 && (
            <span className="text-slate-400">
              <span className="font-semibold tabular-nums">{aQueued.toLocaleString()}</span>
              <span className="text-slate-500"> queued</span>
            </span>
          )}
          {pdf > 0 && (
            <span className="text-amber-400">
              <span className="font-semibold tabular-nums">{aPdf}</span>
              <span className="text-slate-500"> pdf</span>
            </span>
          )}
          {total > 0 && (
            <span className="text-slate-600 tabular-nums">{aPct}%</span>
          )}
        </div>

        {/* Chevron */}
        {open
          ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-600" />
          : <ChevronDown className="h-4 w-4 shrink-0 text-slate-600" />
        }
      </button>

      {/* ── Body — collapses ── */}
      {open && (
        <>
          {/* Progress bar */}
          <div className="px-4 pb-2">
            <div className="h-1 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-700"
                style={{ width: `${aPct}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-slate-600">
              <span>{aTerminal.toLocaleString()} of {aTotal.toLocaleString()} processed</span>
              {processing > 0 && (
                <span className="text-blue-400">{processing} active</span>
              )}
            </div>
          </div>

          {/* Feed — fixed height, scrollable */}
          <div className="h-[168px] overflow-y-auto border-t border-slate-800/60">
            {feedJobs.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-600">
                {data ? "No activity yet" : "Loading…"}
              </div>
            ) : (
              <div className="divide-y divide-slate-800/40">
                {feedJobs.map((job) => (
                  <div
                    key={job.id}
                    className={`flex items-center gap-2 px-4 py-2 ${
                      job.status === "processing" ? "bg-blue-950/20" : ""
                    }`}
                  >
                    <StatusIcon status={job.status} />
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
                      {job.name}
                    </span>
                    {job.status === "failed" && job.error && (
                      <span className="hidden max-w-[120px] truncate text-[10px] text-slate-600 sm:block">
                        {job.error}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-slate-600">
                      {timeAgo(job.updated_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
