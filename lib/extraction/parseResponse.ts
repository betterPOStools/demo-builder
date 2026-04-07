// Ported from adv-menu-import/lib/menu/parseAiResponse.ts

import { z } from "zod";
import type { MenuRow, ExtractedGraphic } from "@/lib/types/menu";
import { normalizeRows, normalizeExtendedRows } from "./normalize";
import type { ExtendedMenuRow } from "./normalize";

const AiMenuItemSchema = z.object({
  "Menu Item Full Name": z.string().min(1),
  "Menu Item Group": z.string().optional().default(""),
  "Menu Item Category": z
    .enum(["Food", "Beverages", "Bar"])
    .optional()
    .default("Food"),
  "Default Price": z.union([z.number(), z.string()]).optional().default(0),
  "Dine In Price": z.union([z.number(), z.string()]).optional().default(""),
  "Bar Price": z.union([z.number(), z.string()]).optional().default(""),
  "Pick Up Price": z.union([z.number(), z.string()]).optional().default(""),
  "Take Out Price": z.union([z.number(), z.string()]).optional().default(""),
  "Delivery Price": z.union([z.number(), z.string()]).optional().default(""),
});

export interface ParsedAiResponse {
  rows: MenuRow[];
  graphics: ExtractedGraphic[];
  extendedRows?: ExtendedMenuRow[];
  restaurantType?: string;
  modifierTemplates?: unknown[];
}

export function parseAiResponse(
  rawText: string,
  extendedMode = false,
): ParsedAiResponse {
  // Try multiple strategies to extract JSON from the AI response
  let parsed: unknown;

  const strategies = [
    // 1. Raw text as-is
    () => JSON.parse(rawText.trim()),
    // 2. Strip markdown code fences at boundaries
    () =>
      JSON.parse(
        rawText
          .replace(/^```(?:json)?\n?/, "")
          .replace(/\n?```$/, "")
          .trim(),
      ),
    // 3. Extract first JSON code block from anywhere in the response
    () => {
      const m = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (!m) throw new Error("no code block");
      return JSON.parse(m[1].trim());
    },
    // 4. Find the first { or [ and extract the JSON from there
    () => {
      const startObj = rawText.indexOf("{");
      const startArr = rawText.indexOf("[");
      const start =
        startObj === -1
          ? startArr
          : startArr === -1
            ? startObj
            : Math.min(startObj, startArr);
      if (start === -1) throw new Error("no JSON found");
      const sub = rawText.slice(start);
      return JSON.parse(sub);
    },
    // 5. Same as above but trim trailing non-JSON text
    () => {
      const startObj = rawText.indexOf("{");
      const startArr = rawText.indexOf("[");
      const start =
        startObj === -1
          ? startArr
          : startArr === -1
            ? startObj
            : Math.min(startObj, startArr);
      if (start === -1) throw new Error("no JSON found");
      const isArr = rawText[start] === "[";
      const end = rawText.lastIndexOf(isArr ? "]" : "}");
      if (end <= start) throw new Error("no closing bracket");
      return JSON.parse(rawText.slice(start, end + 1));
    },
  ];

  let lastError: unknown;
  for (const strategy of strategies) {
    try {
      parsed = strategy();
      break;
    } catch (e) {
      lastError = e;
    }
  }

  if (parsed === undefined) {
    throw new Error(
      `AI returned invalid JSON: ${(lastError as Error)?.message || "unknown"}`,
    );
  }

  if (extendedMode) {
    const obj =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    const rawItems = Array.isArray(parsed)
      ? parsed
      : Array.isArray(obj.items)
        ? obj.items
        : [];
    const rawRestaurantType = (obj.restaurantType as string) || "other";
    const rawModifierTemplates = Array.isArray(obj.modifierTemplates)
      ? obj.modifierTemplates
      : [];

    const { posRows, extendedRows, restaurantType } = normalizeExtendedRows(
      rawItems as Record<string, unknown>[],
      rawRestaurantType,
    );

    return {
      rows: posRows,
      extendedRows,
      restaurantType,
      modifierTemplates: rawModifierTemplates,
      graphics: Array.isArray(obj.graphics)
        ? (obj.graphics as ExtractedGraphic[])
        : [],
    };
  }

  let rawItems: unknown[];
  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else if (parsed && typeof parsed === "object" && "items" in parsed) {
    const obj = parsed as Record<string, unknown>;
    rawItems = Array.isArray(obj.items) ? obj.items : [];
  } else if (parsed && typeof parsed === "object") {
    rawItems = [];
  } else {
    throw new Error("AI did not return expected JSON structure");
  }

  const validated = rawItems
    .map((item) => {
      const result = AiMenuItemSchema.safeParse(item);
      return result.success ? result.data : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const rows = normalizeRows(validated);

  let graphics: ExtractedGraphic[] = [];
  if (parsed && typeof parsed === "object" && "graphics" in parsed) {
    const obj = parsed as Record<string, unknown>;
    graphics = Array.isArray(obj.graphics)
      ? (obj.graphics as ExtractedGraphic[])
      : [];
  }

  return { rows, graphics };
}
