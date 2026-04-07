import { createServerClient } from "@/lib/supabase/server";

// GET /api/connections — list saved connections
export async function GET() {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("connections")
      .select("id, name, host, port, database_name, username, upload_server_url, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ connections: data ?? [] });
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

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("connections")
      .insert({
        user_email: "aaron@valuesystemspos.com",
        name: body.name,
        host: body.host,
        port: body.port || 3306,
        database_name: body.database_name,
        username: body.username,
        password_encrypted: body.password,
        upload_server_url: body.upload_server_url || null,
      })
      .select("id")
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true, id: data?.id });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

// DELETE /api/connections?id=xxx
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }

    const supabase = createServerClient();
    const { error } = await supabase.from("connections").delete().eq("id", id);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
