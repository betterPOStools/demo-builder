import { turso } from "@/lib/turso";

// POST /api/connections/test
// Checks agent reachability via heartbeat (agent_last_seen) instead of direct TCP.
// Vercel runs in AWS and can never reach Tailscale IPs directly.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      connectionId?: string;
      host?: string;
    };

    if (body.connectionId) {
      const result = await turso.execute({
        sql: "SELECT host, agent_last_seen FROM connections WHERE id = ? LIMIT 1",
        args: [body.connectionId],
      });

      if (result.rows.length === 0) {
        return Response.json({ ok: false, error: "Connection not found" }, { status: 404 });
      }

      const row = result.rows[0];
      if (row.agent_last_seen) {
        const ageMs = Date.now() - new Date(row.agent_last_seen as string).getTime();
        const ageSec = Math.round(ageMs / 1000);
        if (ageMs < 30_000) {
          return Response.json({ ok: true, host: row.host, method: "heartbeat", ageSec });
        }
        return Response.json({
          ok: false, host: row.host, method: "heartbeat", ageSec,
          error: `Agent last seen ${ageSec}s ago — may be offline`,
        });
      }
    }

    // No heartbeat — use last successful deploy as a proxy signal
    const recent = await turso.execute(
      "SELECT updated_at FROM sessions WHERE deploy_status = 'done' ORDER BY updated_at DESC LIMIT 1",
    );

    if (recent.rows.length > 0) {
      const ageMin = Math.round((Date.now() - new Date(recent.rows[0].updated_at as string).getTime()) / 60_000);
      return Response.json({
        ok: true,
        host: body.host || "",
        method: "last_deploy",
        note: `Last successful deploy ${ageMin}m ago`,
      });
    }

    return Response.json({
      ok: false,
      host: body.host || "",
      error: "No heartbeat data. Make sure the agent is running.",
    });
  } catch (error: unknown) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
