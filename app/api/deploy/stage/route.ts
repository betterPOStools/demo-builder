// Stage a deployment: write generated SQL + pending images to Supabase
// The deploy agent on the laptop polls for queued sessions and executes them.

import { createServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId: string;
      sql: string;
      stats: Record<string, number>;
      pendingImages: { type: string; name: string; imageUrl: string; destPath: string }[];
      deployTarget?: {
        host: string;
        port: number;
        database: string;
        user: string;
        password: string;
        upload_server_url?: string;
      };
    };

    if (!body.sessionId || !body.sql) {
      return Response.json(
        { error: "Missing sessionId or sql" },
        { status: 400 },
      );
    }

    const supabase = createServerClient();

    // Upsert: create the session if it doesn't exist yet (app runs in-memory via Zustand)
    const { error } = await supabase
      .from("sessions")
      .upsert({
        id: body.sessionId,
        user_email: "aaron@valuesystemspos.com",
        generated_sql: body.sql,
        pending_images: body.pendingImages,
        deploy_target: body.deployTarget ?? null,
        deploy_status: "queued",
        deploy_result: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });

    if (error) {
      console.error("[deploy/stage] supabase error:", error.message);
      return Response.json(
        { error: `Failed to stage deploy: ${error.message}` },
        { status: 500 },
      );
    }

    return Response.json({
      ok: true,
      status: "queued",
      message: "Deploy staged. The agent will pick it up shortly.",
    });
  } catch (error: unknown) {
    const msg = (error as Error).message || "Staging failed";
    console.error("[deploy/stage] error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
