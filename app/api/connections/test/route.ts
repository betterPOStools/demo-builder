import { createServerClient } from "@/lib/supabase/server";

// POST /api/connections/test — test a saved connection by ID or inline params
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      connectionId?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
    };

    let host: string, port: number, database: string, user: string, password: string;

    if (body.connectionId) {
      const supabase = createServerClient();
      const { data, error } = await supabase
        .from("connections")
        .select("host, port, database_name, username, password_encrypted")
        .eq("id", body.connectionId)
        .single();

      if (error || !data) {
        return Response.json({ ok: false, error: "Connection not found" }, { status: 404 });
      }

      host = data.host;
      port = data.port;
      database = data.database_name;
      user = data.username;
      password = data.password_encrypted || "123456";
    } else {
      host = body.host || "100.112.68.19";
      port = body.port || 3306;
      database = body.database || "pecandemodb";
      user = body.user || "root";
      password = body.password || "123456";
    }

    // Test via TCP socket connection attempt
    // We can't import mysql2 in edge, so we'll test with a simple TCP probe
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      // Use the deploy agent's Supabase status as a proxy,
      // or do a simple fetch to the agent health endpoint.
      // For now, do a DNS+TCP check by connecting to the MariaDB port.
      const net = await import("net");
      const result = await new Promise<{ ok: boolean; latency: number; error?: string }>((resolve) => {
        const start = Date.now();
        const socket = new net.Socket();
        socket.setTimeout(5000);

        socket.connect(port, host, () => {
          const latency = Date.now() - start;
          socket.destroy();
          resolve({ ok: true, latency });
        });

        socket.on("error", (err: Error) => {
          socket.destroy();
          resolve({ ok: false, latency: Date.now() - start, error: err.message });
        });

        socket.on("timeout", () => {
          socket.destroy();
          resolve({ ok: false, latency: Date.now() - start, error: "Connection timeout" });
        });
      });

      clearTimeout(timeout);

      return Response.json({
        ok: result.ok,
        host,
        port,
        database,
        latency: result.latency,
        error: result.error || null,
      });
    } catch (err) {
      clearTimeout(timeout);
      return Response.json({
        ok: false,
        host,
        port,
        database,
        error: (err as Error).message,
      });
    }
  } catch (error: unknown) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
