// Generate SQL from DesignConfigV2
// Pure computation — no AI, no external calls.

import { parseDesignConfig } from "@/lib/sql/designParser";
import { generateFullDeployment } from "@/lib/sql/deployer";
import type { DesignConfigV2 } from "@/lib/types/designConfig";

export async function POST(request: Request) {
  try {
    const config = (await request.json()) as DesignConfigV2;

    if (!config || config.version !== "2.0") {
      return Response.json(
        { error: "Invalid design config — expected version 2.0" },
        { status: 400 },
      );
    }

    // Parse config into deployer-compatible structures
    const parsed = parseDesignConfig(config);

    if (parsed.errors.length > 0) {
      console.warn("[generate-sql] parse warnings:", parsed.errors);
    }

    // Generate full deployment SQL
    const result = generateFullDeployment({
      items: parsed.items,
      groups: parsed.groups,
      categories: parsed.categories,
      templateAssignments: parsed.templateAssignments,
      modifierTemplates: parsed.modifierTemplates,
      groupMeta: parsed.groupMeta,
      branding: parsed.branding,
      rooms: parsed.rooms,
    });

    return Response.json({
      sql: result.sql,
      stats: result.stats,
      pendingImageTransfers: result.pendingImageTransfers,
      parseErrors: parsed.errors,
    });
  } catch (error: unknown) {
    const msg = (error as Error).message || "SQL generation failed";
    console.error("[generate-sql] error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
