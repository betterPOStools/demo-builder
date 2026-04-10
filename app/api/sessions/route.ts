import { turso } from "@/lib/turso";

// GET /api/sessions — list recent sessions
export async function GET() {
  try {
    const result = await turso.execute(
      "SELECT id, name, restaurant_name, current_step, deploy_status, updated_at, created_at FROM sessions ORDER BY updated_at DESC LIMIT 200",
    );
    const sessions = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      restaurant_name: r.restaurant_name,
      current_step: r.current_step,
      deploy_status: r.deploy_status,
      updated_at: r.updated_at,
      created_at: r.created_at,
    }));
    return Response.json({ sessions });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

// POST /api/sessions — create a new session
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id: string; restaurant_name?: string };
    if (!body.id) return Response.json({ error: "Missing id" }, { status: 400 });

    const now = new Date().toISOString();
    await turso.execute({
      sql: `INSERT INTO sessions (id, restaurant_name, current_step, created_at, updated_at)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`,
      args: [body.id, body.restaurant_name ?? null, now, now],
    });

    return Response.json({ ok: true, id: body.id });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
