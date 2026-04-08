import { createServerClient } from "@/lib/supabase/server";
import { generateId } from "@/lib/utils";

// POST /api/sessions/:id/duplicate — clone a session into a new ID
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = createServerClient();

    const { data: source, error: fetchErr } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !source) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const newId = generateId();
    const now = new Date().toISOString();

    const { error: insertErr } = await supabase.from("sessions").insert({
      ...source,
      id: newId,
      name: source.name ? `${source.name} (copy)` : null,
      restaurant_name: source.restaurant_name
        ? `${source.restaurant_name} (copy)`
        : null,
      deploy_status: "idle",
      deploy_result: null,
      generated_sql: null,
      pending_images: null,
      created_at: now,
      updated_at: now,
    });

    if (insertErr) {
      return Response.json({ error: insertErr.message }, { status: 500 });
    }

    return Response.json({ ok: true, id: newId });
  } catch (error: unknown) {
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
