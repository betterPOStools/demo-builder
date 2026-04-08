"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Database,
  Rocket,
  Loader2,
  Zap,
  Plus,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/store";
import { serializeDesignConfig } from "@/lib/serializer";
import { SqlPreview } from "@/components/deploy/SqlPreview";
import { DeployStatusCard } from "@/components/deploy/DeployStatus";
import { ConnectionForm } from "@/components/deploy/ConnectionForm";
import { toast } from "sonner";
import type { SavedConnection } from "@/lib/types";

export default function DeployPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const items = useStore((s) => s.items);
  const groups = useStore((s) => s.groups);
  const rooms = useStore((s) => s.rooms);
  const modifierTemplates = useStore((s) => s.modifierTemplates);
  const restaurantName = useStore((s) => s.restaurantName);
  const branding = useStore((s) => s.branding);
  const generatedSql = useStore((s) => s.generatedSql);
  const deployStats = useStore((s) => s.deployStats);
  const deployStatus = useStore((s) => s.deployStatus);
  const setStagedDeploy = useStore((s) => s.setStagedDeploy);
  const setDeployStatus = useStore((s) => s.setDeployStatus);
  const setDeployResult = useStore((s) => s.setDeployResult);
  const savedConnections = useStore((s) => s.savedConnections);
  const setSavedConnections = useStore((s) => s.setSavedConnections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const setActiveConnection = useStore((s) => s.setActiveConnection);
  const setCurrentStep = useStore((s) => s.setCurrentStep);

  useEffect(() => {
    setCurrentStep(3);
  }, [setCurrentStep]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(false);

  // Load connections on mount
  useEffect(() => {
    fetch("/api/connections")
      .then((r) => r.json())
      .then((data) => {
        if (data.connections) {
          setSavedConnections(data.connections);
          if (data.connections.length > 0 && !activeConnectionId) {
            setActiveConnection(data.connections[0].id);
          }
        }
      })
      .catch(() => {});
  }, [setSavedConnections, setActiveConnection, activeConnectionId]);

  // Poll deploy status when queued or executing
  useEffect(() => {
    if (deployStatus !== "queued" && deployStatus !== "executing") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/deploy/status?sessionId=${id}`,
        );
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === "done" || data.status === "failed") {
          setDeployStatus(data.status);
          if (data.result) {
            setDeployResult(data.result);
          }
          if (data.status === "done") {
            toast.success("Deploy completed successfully");
          } else {
            toast.error("Deploy failed");
          }
        } else if (data.status === "executing" && deployStatus === "queued") {
          setDeployStatus("executing");
        }
      } catch {
        // Ignore polling errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [id, deployStatus, setDeployStatus, setDeployResult]);

  const handleGenerateSql = useCallback(async () => {
    setIsGenerating(true);
    try {
      const designState = {
        id: null,
        name: "Untitled",
        restaurantName: restaurantName || "",
        restaurantType: null,
        isDirty: false,
        origin: { type: "menu_import" as const },
        categories: [
          { name: "Food" as const, sortOrder: 0 },
          { name: "Beverages" as const, sortOrder: 1 },
          { name: "Bar" as const, sortOrder: 2 },
        ],
        groups,
        items,
        brandAssets: [],
        rooms,
      };

      const brandingConfig = {
        background: branding.background,
        background_url: null,
        buttons_background_color: branding.buttons_background_color,
        buttons_font_color: branding.buttons_font_color,
        sidebar_picture: branding.sidebar_picture,
        sidebar_picture_url: null,
      };

      const config = serializeDesignConfig(
        designState,
        modifierTemplates,
        brandingConfig,
      );

      const res = await fetch("/api/generate-sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ error: "Generation failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setStagedDeploy(data.sql, data.stats, data.pendingImageTransfers || []);
      toast.success(
        `SQL generated: ${data.stats.menuItems} items, ${data.stats.groups} groups`,
      );
    } catch (error: unknown) {
      const msg = (error as Error).message || "SQL generation failed";
      toast.error(msg);
    } finally {
      setIsGenerating(false);
    }
  }, [
    groups,
    items,
    rooms,
    modifierTemplates,
    restaurantName,
    branding,
    setStagedDeploy,
  ]);

  const handleStageDeploy = useCallback(async () => {
    if (!generatedSql) return;
    try {
      setDeployStatus("queued");

      // Build deploy target from selected connection
      const conn = savedConnections.find(
        (c: SavedConnection) => c.id === activeConnectionId,
      );
      const deployTarget = conn
        ? {
            host: conn.host,
            port: conn.port,
            database: conn.database_name,
            user: conn.username,
            password: conn.password_encrypted || "123456",
          }
        : undefined;

      const res = await fetch("/api/deploy/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: id,
          sql: generatedSql,
          stats: deployStats,
          pendingImages: useStore.getState().pendingImages,
          deployTarget,
        }),
      });

      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ error: "Staging failed" }));
        throw new Error(err.error);
      }

      toast.success("Deploy queued — agent will pick it up shortly");
    } catch (error: unknown) {
      const msg = (error as Error).message || "Staging failed";
      setDeployStatus("failed");
      toast.error(msg);
    }
  }, [
    id,
    generatedSql,
    deployStats,
    setDeployStatus,
    activeConnectionId,
    savedConnections,
  ]);

  function handleConnectionSaved() {
    setShowConnectionForm(false);
    fetch("/api/connections")
      .then((r) => r.json())
      .then((data) => {
        if (data.connections) {
          setSavedConnections(data.connections);
          if (data.connections.length > 0) {
            setActiveConnection(data.connections[0].id);
          }
        }
      })
      .catch(() => {});
  }

  const categoriesUsed = new Set(groups.map((g) => g.category)).size;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Deploy to POS</h2>
          <p className="text-sm text-slate-400">
            Generate SQL, review, and push to your POS database.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => router.push(`/project/${id}/design`)}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Design
        </Button>
      </div>

      {/* Connection Selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wifi className="h-4 w-4 text-green-400" />
            Deploy Target
          </CardTitle>
        </CardHeader>
        <CardContent>
          {savedConnections.length > 0 ? (
            <div className="flex items-center gap-3">
              <Select
                value={activeConnectionId ?? ""}
                onValueChange={setActiveConnection}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Select connection" />
                </SelectTrigger>
                <SelectContent>
                  {savedConnections.map((c: SavedConnection) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} ({c.host}:{c.port})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowConnectionForm(true)}
              >
                <Plus className="mr-1 h-3 w-3" /> Add
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-slate-500">
                No saved connections. The deploy agent will use its default
                target.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowConnectionForm(true)}
              >
                <Plus className="mr-1 h-3 w-3" /> Add Connection
              </Button>
            </div>
          )}

          {showConnectionForm && (
            <div className="mt-3">
              <ConnectionForm
                onSaved={handleConnectionSaved}
                onCancel={() => setShowConnectionForm(false)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Summary + Generate */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-blue-400" />
              Design Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Categories</span>
                <span>{categoriesUsed}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Groups</span>
                <span>{groups.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Menu Items</span>
                <span>{items.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Modifier Templates</span>
                <span>{modifierTemplates.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Rooms</span>
                <span>{rooms.length}</span>
              </div>
            </div>

            <Button
              className="mt-4 w-full gap-2"
              onClick={handleGenerateSql}
              disabled={isGenerating || items.length === 0}
            >
              {isGenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              {isGenerating
                ? "Generating..."
                : generatedSql
                  ? "Regenerate SQL"
                  : "Generate SQL"}
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <DeployStatusCard />

          {generatedSql && deployStatus === "idle" && (
            <Button
              className="w-full gap-2"
              variant="default"
              onClick={handleStageDeploy}
            >
              <Rocket className="h-4 w-4" />
              Stage Deploy
            </Button>
          )}
          {deployStatus !== "idle" && deployStatus !== "executing" && (
            <Button
              className="w-full gap-2"
              variant="outline"
              onClick={() => setDeployStatus("idle")}
            >
              Reset
            </Button>
          )}
        </div>
      </div>

      {/* SQL Preview */}
      {generatedSql && <SqlPreview sql={generatedSql} />}
    </div>
  );
}
