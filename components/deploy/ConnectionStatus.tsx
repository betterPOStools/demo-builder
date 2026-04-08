"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, Wifi, WifiOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import type { SavedConnection } from "@/lib/types";

interface ConnectionHealth {
  ok: boolean;
  host: string;
  port: number;
  database: string;
  latency: number;
  error: string | null;
}

export function ConnectionStatus() {
  const savedConnections = useStore((s) => s.savedConnections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const [health, setHealth] = useState<ConnectionHealth | null>(null);
  const [checking, setChecking] = useState(false);

  const activeConn = savedConnections.find(
    (c: SavedConnection) => c.id === activeConnectionId,
  );

  const checkConnection = useCallback(async () => {
    if (!activeConnectionId) {
      setHealth(null);
      return;
    }

    setChecking(true);
    try {
      const res = await fetch("/api/connections/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId }),
      });
      const data = await res.json();
      setHealth(data);
    } catch {
      setHealth({ ok: false, host: "", port: 0, database: "", latency: 0, error: "Network error" });
    } finally {
      setChecking(false);
    }
  }, [activeConnectionId]);

  // Check on mount and when connection changes
  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // Re-check every 30s
  useEffect(() => {
    if (!activeConnectionId) return;
    const interval = setInterval(checkConnection, 30000);
    return () => clearInterval(interval);
  }, [activeConnectionId, checkConnection]);

  if (!activeConn) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-700/50 bg-slate-800/30 px-3 py-2">
        <WifiOff className="h-3.5 w-3.5 text-slate-600" />
        <span className="text-xs text-slate-500">No connection selected</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border px-3 py-2 transition-colors",
        health === null || checking
          ? "border-slate-700/50 bg-slate-800/30"
          : health.ok
            ? "border-green-500/30 bg-green-500/5"
            : "border-red-500/30 bg-red-500/5",
      )}
    >
      {/* Status indicator */}
      <div className="flex items-center gap-2">
        {checking ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
        ) : health?.ok ? (
          <Wifi className="h-3.5 w-3.5 text-green-400" />
        ) : (
          <WifiOff className="h-3.5 w-3.5 text-red-400" />
        )}
        <span
          className={cn(
            "text-xs font-medium",
            health?.ok ? "text-green-400" : health ? "text-red-400" : "text-slate-400",
          )}
        >
          {checking ? "Checking..." : health?.ok ? "Connected" : health ? "Unreachable" : "..."}
        </span>
      </div>

      {/* Connection details */}
      <div className="flex items-center gap-1.5 border-l border-slate-700 pl-3">
        <Database className="h-3 w-3 text-slate-500" />
        <span className="text-xs text-slate-300">{activeConn.name}</span>
        <span className="text-[10px] text-slate-500">
          {activeConn.host}:{activeConn.port}/{activeConn.database_name}
        </span>
      </div>

      {/* Latency */}
      {health?.ok && health.latency > 0 && (
        <span className="text-[10px] text-slate-600">{health.latency}ms</span>
      )}

      {/* Error */}
      {health && !health.ok && health.error && (
        <span className="text-[10px] text-red-400/70 truncate max-w-32">
          {health.error}
        </span>
      )}

      {/* Manual check button */}
      <button
        onClick={checkConnection}
        disabled={checking}
        className="ml-auto text-[10px] text-slate-500 hover:text-slate-300 disabled:opacity-50"
      >
        Test
      </button>
    </div>
  );
}
