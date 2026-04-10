"use client";

import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Rocket,
} from "lucide-react";
import { useStore } from "@/store";
import { cn } from "@/lib/utils";

const statusConfig = {
  idle: {
    icon: Clock,
    color: "text-slate-500",
    label: "Ready",
    description: "SQL generated. Stage the deploy when ready.",
  },
  queued: {
    icon: Rocket,
    color: "text-blue-400",
    label: "Queued",
    description: "Waiting for deploy agent to pick up...",
  },
  executing: {
    icon: Loader2,
    color: "text-amber-400",
    label: "Executing",
    description: "Deploy agent is running SQL against the POS database...",
  },
  done: {
    icon: CheckCircle2,
    color: "text-green-400",
    label: "Complete",
    description: "Deployment finished successfully.",
  },
  failed: {
    icon: XCircle,
    color: "text-red-400",
    label: "Failed",
    description: "Deployment encountered an error.",
  },
};

export function DeployStatusCard() {
  const deployStatus = useStore((s) => s.deployStatus);
  const deployResult = useStore((s) => s.deployResult);
  const deployStats = useStore((s) => s.deployStats);

  const config = statusConfig[deployStatus];
  const Icon = config.icon;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-4">
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            "mt-0.5 h-5 w-5 shrink-0",
            config.color,
            deployStatus === "executing" && "animate-spin",
          )}
        />
        <div className="flex-1">
          <h4 className="text-sm font-medium text-slate-200">
            {config.label}
          </h4>
          <p className="mt-0.5 text-xs text-slate-500">{config.description}</p>

          {deployStats && deployStatus !== "idle" && (
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div className="rounded bg-slate-800 px-2 py-1.5">
                <div className="text-sm font-medium text-slate-200">
                  {deployStats.categories}
                </div>
                <div className="text-[10px] text-slate-500">Categories</div>
              </div>
              <div className="rounded bg-slate-800 px-2 py-1.5">
                <div className="text-sm font-medium text-slate-200">
                  {deployStats.groups}
                </div>
                <div className="text-[10px] text-slate-500">Groups</div>
              </div>
              <div className="rounded bg-slate-800 px-2 py-1.5">
                <div className="text-sm font-medium text-slate-200">
                  {deployStats.menu_items}
                </div>
                <div className="text-[10px] text-slate-500">Items</div>
              </div>
            </div>
          )}

          {deployResult && deployStatus === "done" && (
            <div className="mt-3 space-y-1.5">
              <div className="rounded bg-green-500/10 px-3 py-2 text-xs text-green-400">
                {deployResult.rows_affected} rows affected.
                {deployResult.images_pushed > 0 &&
                  ` ${deployResult.images_pushed} images pushed.`}
                {deployResult.images_failed > 0 &&
                  ` ${deployResult.images_failed} images failed.`}
              </div>
              {deployResult.pos_restarted !== undefined && (
                <div
                  className={cn(
                    "rounded px-3 py-2 text-xs",
                    deployResult.pos_running
                      ? "bg-green-500/10 text-green-400"
                      : deployResult.pos_restarted
                        ? "bg-amber-500/10 text-amber-400"
                        : "bg-slate-500/10 text-slate-400",
                  )}
                >
                  {deployResult.pos_running
                    ? "POS restarted and running"
                    : deployResult.pos_restarted
                      ? "POS restarted — may need manual check"
                      : deployResult.error
                        ? `POS restart failed: ${deployResult.error}`
                        : "POS restart skipped (SSH not available)"}
                </div>
              )}
            </div>
          )}

          {deployResult && deployStatus === "failed" && (
            <div className="mt-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {deployResult.error || "Unknown error"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
