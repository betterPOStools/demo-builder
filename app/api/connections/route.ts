import { turso } from "@/lib/turso";
import { randomUUID } from "crypto";

// GET /api/connections — list saved connections
export async function GET() {
  try {
    const result = await turso.execute(
      "SELECT id, name, host, port, database_name, username, upload_server_url, created_at FROM connections ORDER BY created_at DESC",
    );
    const connections = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      database_name: r.database_name,
      username: r.username,
      upload_server_url: r.upload_server_url,
      created_at: r.created_at,
    }));
    return Response.json({ connections });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

// POST /api/connections — save a new connection
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name: string;
      host: string;
      port: number;
      database_name: string;
      username: string;
      password: string;
      upload_server_url?: string;
    };

    if (!body.name || !body.host || !body.database_name || !body.username) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    await turso.execute({
      sql: `INSERT INTO connections (id, name, host, port, database_name, username, password_encrypted, upload_server_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        body.name,
        body.host,
        body.port || 3306,
        body.database_name,
        body.username,
        body.password || null,
        body.upload_server_url || null,
        now,
      ],
    });

    return Response.json({ ok: true, id });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

// DELETE /api/connections?id=xxx
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

    await turso.execute({ sql: "DELETE FROM connections WHERE id = ?", args: [id] });
    return Response.json({ ok: true });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
