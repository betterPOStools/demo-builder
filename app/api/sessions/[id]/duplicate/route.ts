import { turso, toJson } from "@/lib/turso";
import { generateId } from "@/lib/utils";

// POST /api/sessions/:id/duplicate — clone a session into a new ID
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const result = await turso.execute({
      sql: "SELECT * FROM sessions WHERE id = ? LIMIT 1",
      args: [id],
    });

    if (result.rows.length === 0) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const source = result.rows[0];
    const newId = generateId();
    const now = new Date().toISOString();

    await turso.execute({
      sql: `INSERT INTO sessions
              (id, name, restaurant_name, restaurant_type, current_step,
               extracted_rows, modifier_suggestions, design_state, modifier_templates,
               generated_sql, pending_images, deploy_target, deploy_status,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', NULL, 'idle', ?, ?)`,
      args: [
        newId,
        source.name ? `${source.name} (copy)` : null,
        source.restaurant_name ? `${source.restaurant_name} (copy)` : null,
        source.restaurant_type ?? null,
        source.current_step ?? 1,
        source.extracted_rows ?? "[]",
        source.modifier_suggestions ?? "[]",
        source.design_state ?? "{}",
        source.modifier_templates ?? "[]",
        now,
        now,
      ],
    });

    return Response.json({ ok: true, id: newId });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
