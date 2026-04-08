import { createServerClient } from "@/lib/supabase/server";

// GET /api/sessions/:id — load a session
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return Response.json({ session: null });
      }
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ session: data });
  } catch (error: unknown) {
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

// DELETE /api/sessions/:id — delete a session
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = createServerClient();
    const { error } = await supabase.from("sessions").delete().eq("id", id);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (error: unknown) {
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

// PUT /api/sessions/:id — save session state
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const supabase = createServerClient();
    const { error } = await supabase
      .from("sessions")
      .upsert(
        {
          id,
          user_email: body.user_email || "aaron@valuesystemspos.com",
          name: body.name || "Untitled",
          restaurant_name: body.restaurant_name || null,
          restaurant_type: body.restaurant_type || null,
          extracted_rows: body.extracted_rows || null,
          modifier_suggestions: body.modifier_suggestions || null,
          design_state: body.design_state || null,
          modifier_templates: body.modifier_templates || null,
          current_step: body.current_step ?? 1,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true });
  } catch (error: unknown) {
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
