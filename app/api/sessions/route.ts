import { createServerClient } from "@/lib/supabase/server";

// GET /api/sessions — list recent sessions
export async function GET() {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("sessions")
      .select("id, name, restaurant_name, current_step, deploy_status, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(200);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ sessions: data ?? [] });
  } catch (error: unknown) {
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

// POST /api/sessions — create a new session
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      id: string;
      restaurant_name?: string;
    };

    if (!body.id) {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }

    const supabase = createServerClient();
    const { error } = await supabase.from("sessions").upsert(
      {
        id: body.id,
        user_email: "aaron@valuesystemspos.com",
        restaurant_name: body.restaurant_name || null,
        current_step: 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true, id: body.id });
  } catch (error: unknown) {
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
