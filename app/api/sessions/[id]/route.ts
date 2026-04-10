import { turso, parseJson, toJson } from "@/lib/turso";

// GET /api/sessions/:id — load a session
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await turso.execute({
      sql: "SELECT * FROM sessions WHERE id = ? LIMIT 1",
      args: [id],
    });

    if (result.rows.length === 0) return Response.json({ session: null });

    const r = result.rows[0];
    const session = {
      id: r.id,
      name: r.name,
      restaurant_name: r.restaurant_name,
      restaurant_type: r.restaurant_type,
      current_step: r.current_step,
      extracted_rows: parseJson(r.extracted_rows, []),
      modifier_suggestions: parseJson(r.modifier_suggestions, []),
      design_state: parseJson(r.design_state, {}),
      modifier_templates: parseJson(r.modifier_templates, []),
      generated_sql: r.generated_sql,
      pending_images: parseJson(r.pending_images, []),
      deploy_target: parseJson(r.deploy_target, null),
      deploy_status: r.deploy_status,
      deploy_result: r.deploy_result,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };

    return Response.json({ session });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

// DELETE /api/sessions/:id
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await turso.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [id] });
    return Response.json({ ok: true });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
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
    const now = new Date().toISOString();

    await turso.execute({
      sql: `INSERT INTO sessions
              (id, name, restaurant_name, restaurant_type, current_step,
               extracted_rows, modifier_suggestions, design_state, modifier_templates,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,
              restaurant_name=excluded.restaurant_name,
              restaurant_type=excluded.restaurant_type,
              current_step=excluded.current_step,
              extracted_rows=excluded.extracted_rows,
              modifier_suggestions=excluded.modifier_suggestions,
              design_state=excluded.design_state,
              modifier_templates=excluded.modifier_templates,
              updated_at=excluded.updated_at`,
      args: [
        id,
        body.name || "Untitled",
        body.restaurant_name ?? null,
        body.restaurant_type ?? null,
        body.current_step ?? 1,
        toJson(body.extracted_rows),
        toJson(body.modifier_suggestions),
        toJson(body.design_state),
        toJson(body.modifier_templates),
        now,
        now,
      ],
    });

    return Response.json({ ok: true });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
