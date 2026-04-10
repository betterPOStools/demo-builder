"use client";

/**
 * useAutoPilot — one-click full pipeline:
 * extract → parse → library match → generate images → infer modifiers →
 * palette → branding → SQL → stage deploy → poll to completion
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useStore } from "@/store";
import { useExtraction } from "@/lib/extraction/useExtraction";
import { parseMenuRows } from "@/lib/menuImport";
import { serializeDesignConfig } from "@/lib/serializer";
import { svgToPng } from "@/lib/svgToPng";
import { compressPendingImages } from "@/lib/compressImages";
import { htmlToPng } from "@/lib/htmlToPng";
import { splitBrandingImage, COMBINED_W, COMBINED_H } from "@/lib/splitBrandingImage";
import type { ModifierTemplateNode, ModifierSectionNode, ModifierNode } from "@/lib/types";
import type { GeneratedImage } from "@/store/designSlice";

export interface AutoPilotState {
  isRunning: boolean;
  stepLabel: string;
  progress: number; // 0–100
}

export interface AutoPilotOptions {
  sessionId: string;
  styleHints?: string;
}

const ITEM_IMAGE_BATCH = 3;
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 60; // 5 min

export function useAutoPilot() {
  const [state, setState] = useState<AutoPilotState>({
    isRunning: false,
    stepLabel: "",
    progress: 0,
  });

  const { processFiles } = useExtraction();

  const setStep = (label: string, progress: number) =>
    setState((s) => ({ ...s, stepLabel: label, progress }));

  const run = useCallback(
    async ({ sessionId, styleHints }: AutoPilotOptions) => {
      setState({ isRunning: true, stepLabel: "Starting…", progress: 0 });

      try {
        // ── Step 1: Extract pending files ────────────────────────────────
        const pendingFiles = useStore
          .getState()
          .files.filter((f) => f.status === "pending");

        if (pendingFiles.length > 0) {
          setStep("Extracting menu items…", 5);
          await processFiles();
        }

        // ── Step 2: Parse rows → design store ───────────────────────────
        setStep("Parsing menu data…", 14);
        const rows = useStore.getState().extractedRows;
        if (rows.length === 0) {
          toast.error("No menu items extracted — add files or a URL first.");
          return;
        }
        const restaurantName = useStore.getState().restaurantName || "";
        const restaurantType = useStore.getState().restaurantType;
        const importedItems = parseMenuRows(rows);
        useStore.getState().importExtractedData(importedItems, restaurantName);
        // Let Zustand flush
        await new Promise((r) => setTimeout(r, 60));

        // ── Step 3: Library match ────────────────────────────────────────
        setStep("Matching images from library…", 22);
        const library = useStore.getState().imageLibrary;
        const items = useStore.getState().items;

        const libMatchedIds = new Set<string>();
        for (const item of items) {
          if (item.posImagePath) { libMatchedIds.add(item.id); continue; }
          const match = library.find(
            (img) =>
              img.type === "item" &&
              img.itemName?.toLowerCase() === item.name.toLowerCase(),
          );
          if (match) {
            useStore.getState().updateItem(item.id, { posImagePath: match.dataUri });
            libMatchedIds.add(item.id);
          }
        }

        // ── Step 4: Generate missing item images ─────────────────────────
        const needImages = useStore
          .getState()
          .items.filter((item) => !item.posImagePath);

        if (needImages.length > 0) {
          setStep(`Generating ${needImages.length} item image${needImages.length !== 1 ? "s" : ""}…`, 30);
          const groups = useStore.getState().groups;
          const groupMap = Object.fromEntries(groups.map((g) => [g.id, g.name]));

          for (let i = 0; i < needImages.length; i += ITEM_IMAGE_BATCH) {
            const batch = needImages.slice(i, i + ITEM_IMAGE_BATCH);
            const progress =
              30 + Math.round((i / needImages.length) * 22);
            setStep(
              `Generating images (${i + 1}–${Math.min(i + ITEM_IMAGE_BATCH, needImages.length)} of ${needImages.length})…`,
              progress,
            );

            await Promise.all(
              batch.map(async (item) => {
                try {
                  const res = await fetch("/api/generate-item-image", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      itemName: item.name,
                      groupName: groupMap[item.groupId] || undefined,
                      restaurantType: restaurantType || undefined,
                      styleHints,
                    }),
                  });
                  if (!res.ok) return;
                  const data = await res.json();
                  if (!data.svg) return;

                  const pngDataUri = await svgToPng(data.svg, 90, 90);
                  useStore.getState().updateItem(item.id, { posImagePath: pngDataUri });

                  const libEntry: GeneratedImage = {
                    id: crypto.randomUUID(),
                    type: "item",
                    dataUri: pngDataUri,
                    createdAt: new Date().toISOString(),
                    restaurantName,
                    itemName: item.name,
                  };
                  useStore.getState().addGeneratedImage(libEntry);
                } catch {
                  // Skip — image is optional
                }
              }),
            );
          }
        }

        // ── Step 5: Infer modifiers ──────────────────────────────────────
        setStep("Inferring modifier templates…", 55);
        try {
          const currentItems = useStore.getState().items;
          const currentGroups = useStore.getState().groups;
          const groupMap = Object.fromEntries(
            currentGroups.map((g) => [g.id, g.name]),
          );

          const modRes = await fetch("/api/infer-modifiers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: currentItems.map((item) => ({
                name: item.name,
                price: item.defaultPrice,
                group: groupMap[item.groupId] || "",
              })),
              restaurantName,
            }),
          });

          if (modRes.ok) {
            const modData = await modRes.json();
            if (Array.isArray(modData.templates) && modData.templates.length > 0) {
              useStore.getState().clearTemplates();

              const templates: (ModifierTemplateNode & { _appliesTo: string[] })[] =
                modData.templates.map(
                  (t: {
                    name: string;
                    applies_to?: string[];
                    sections?: {
                      name: string;
                      min_selections?: number;
                      max_selections?: number;
                      modifiers?: { name: string; price?: number; is_default?: boolean }[];
                    }[];
                  }) => ({
                    id: crypto.randomUUID(),
                    name: t.name,
                    source: "ai" as const,
                    restaurantType: restaurantType ?? null,
                    sections: (t.sections ?? []).map(
                      (s, si): ModifierSectionNode => ({
                        id: crypto.randomUUID(),
                        name: s.name,
                        sortOrder: si,
                        minSelections: s.min_selections ?? 0,
                        maxSelections: s.max_selections ?? 1,
                        gridColumns: 2,
                        modifiers: (s.modifiers ?? []).map(
                          (m, mi): ModifierNode => ({
                            id: crypto.randomUUID(),
                            name: m.name,
                            price: m.price ?? 0,
                            sortOrder: mi,
                            isDefault: m.is_default ?? false,
                            imageAssetId: null,
                            posImagePath: null,
                            isPizzaCrust: false,
                            isPizzaTopping: false,
                            isBarMixer: false,
                            isBarDrink: false,
                          }),
                        ),
                      }),
                    ),
                    _appliesTo: t.applies_to ?? [],
                  }),
                );

              useStore.getState().loadTemplates(templates);

              for (const template of templates) {
                const appliesTo = template._appliesTo;
                const matchingItemIds = useStore
                  .getState()
                  .items.filter((item) =>
                    appliesTo.some(
                      (name) => name.toLowerCase() === item.name.toLowerCase(),
                    ),
                  )
                  .map((item) => item.id);

                if (matchingItemIds.length > 0) {
                  useStore
                    .getState()
                    .addTemplateToItems(matchingItemIds, template.id);
                }
              }
            }
          }
        } catch {
          // Modifiers are optional — continue
        }

        // ── Step 6: Color palette ────────────────────────────────────────
        setStep("Generating color palette…", 66);
        try {
          const groups = useStore.getState().groups;
          const groupNames = [...new Set(groups.map((g) => g.name))].slice(0, 8);

          const paletteRes = await fetch("/api/generate-branding", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              restaurantName,
              restaurantType: restaurantType || undefined,
              groups: groupNames,
              type: "palette",
              styleHints,
            }),
          });

          if (paletteRes.ok) {
            const p = await paletteRes.json();
            if (p.background || p.buttons_background_color) {
              useStore.getState().updateBranding({
                background: p.background ?? null,
                buttons_background_color: p.buttons_background_color ?? null,
                buttons_font_color: p.buttons_font_color ?? null,
              });
            }
          }
        } catch {
          // Optional
        }

        // ── Step 7: Unified branding image ───────────────────────────────
        setStep("Generating branding visuals…", 74);
        try {
          const groups = useStore.getState().groups;
          const groupNames = [...new Set(groups.map((g) => g.name))].slice(0, 8);

          const brandRes = await fetch("/api/generate-branding", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              restaurantName,
              restaurantType: restaurantType || undefined,
              groups: groupNames,
              type: "unified",
              styleHints,
            }),
          });

          if (brandRes.ok) {
            const brandData = await brandRes.json();
            if (brandData.html) {
              const fullPng = await htmlToPng(brandData.html, COMBINED_W, COMBINED_H);
              const { sidebarPng, backgroundPng } = await splitBrandingImage(fullPng);
              useStore.getState().updateBranding({
                sidebar_picture: sidebarPng,
                background_picture: backgroundPng,
              });
            }
          }
        } catch {
          // Optional
        }

        // ── Step 8: Generate SQL ─────────────────────────────────────────
        setStep("Generating deployment SQL…", 83);
        const s = useStore.getState();
        const designState = {
          id: null,
          name: "Untitled",
          restaurantName: s.restaurantName || "",
          restaurantType: null,
          isDirty: false,
          origin: { type: "menu_import" as const },
          categories: [
            { name: "Food" as const, sortOrder: 0 },
            { name: "Beverages" as const, sortOrder: 1 },
            { name: "Bar" as const, sortOrder: 2 },
          ],
          groups: s.groups,
          items: s.items,
          brandAssets: [],
          rooms: s.rooms,
        };
        const brandingConfig = {
          background: s.branding.background,
          background_url: null,
          background_picture: s.branding.background_picture,
          buttons_background_color: s.branding.buttons_background_color,
          buttons_font_color: s.branding.buttons_font_color,
          sidebar_picture: s.branding.sidebar_picture,
          sidebar_picture_url: null,
        };
        const config = serializeDesignConfig(designState, s.modifierTemplates, brandingConfig);

        const sqlRes = await fetch("/api/generate-sql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });
        if (!sqlRes.ok) throw new Error("SQL generation failed");
        const sqlData = await sqlRes.json();
        s.setStagedDeploy(sqlData.sql, sqlData.stats, sqlData.pendingImageTransfers ?? []);

        // ── Step 9: Stage deploy ─────────────────────────────────────────
        setStep("Staging deploy…", 91);
        const conns = useStore.getState().savedConnections;
        const activeId = useStore.getState().activeConnectionId;
        const conn = conns.find((c) => c.id === activeId) ?? conns[0];
        const deployTarget = conn
          ? {
              host: conn.host,
              port: conn.port,
              database: conn.database_name,
              user: conn.username,
              password: conn.password_encrypted ?? "123456",
            }
          : undefined;

        const pendingImages = await compressPendingImages(
          sqlData.pendingImageTransfers ?? [],
        );
        const stageRes = await fetch("/api/deploy/stage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            sql: sqlData.sql,
            stats: sqlData.stats,
            pendingImages,
            deployTarget,
          }),
        });
        if (!stageRes.ok) throw new Error("Staging failed");
        useStore.getState().setDeployStatus("queued");

        // ── Step 10: Poll for completion ──────────────────────────────────
        setStep("Waiting for deploy agent…", 94);
        let attempts = 0;

        while (attempts < POLL_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          attempts++;

          try {
            const pollRes = await fetch(
              `/api/deploy/status?sessionId=${sessionId}`,
            );
            if (!pollRes.ok) continue;
            const pollData = await pollRes.json();

            if (pollData.status === "done") {
              useStore.getState().setDeployStatus("done");
              if (pollData.result) {
                useStore.getState().setDeployResult(pollData.result);
              }
              setStep("Deploy complete!", 100);
              toast.success("AutoPilot complete — menu deployed!");
              return;
            }

            if (pollData.status === "failed") {
              throw new Error(
                `Deploy failed: ${pollData.result?.error ?? "Unknown error"}`,
              );
            }

            setStep(
              `Waiting for deploy agent… (${attempts * 5}s)`,
              Math.min(99, 94 + attempts),
            );
          } catch (pollErr: unknown) {
            if ((pollErr as Error).message?.startsWith("Deploy failed")) throw pollErr;
            // network hiccup — keep polling
          }
        }

        // Timed out — still staged, agent may pick it up later
        toast.warning(
          "Deploy staged — agent is taking longer than expected. Check the Deploy page.",
        );
        setStep("Staged (agent not responding)", 98);
      } catch (error: unknown) {
        const msg = (error as Error).message || "AutoPilot failed";
        toast.error(`AutoPilot: ${msg}`);
        setStep(`Failed: ${msg}`, 0);
        useStore.getState().setDeployStatus("idle");
      } finally {
        setState((s) => ({ ...s, isRunning: false }));
      }
    },
    [processFiles],
  );

  return { ...state, run };
}
