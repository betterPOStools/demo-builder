import { createServerClient } from "@/lib/supabase/server";

// POST /api/connections/test
// Checks agent reachability via Supabase heartbeat instead of direct TCP.
// Vercel runs in AWS and can never reach Tailscale IPs directly — TCP probes
// always fail. Instead the agent updates agent_last_seen every poll cycle.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      connectionId?: string;
      host?: string;
    };

    const supabase = createServerClient();

    if (body.connectionId) {
      const { data, error } = await supabase
        .from("connections")
        .select("host, agent_last_seen")
        .eq("id", body.connectionId)
        .single();

      if (error || !data) {
        return Response.json({ ok: false, error: "Connection not found" }, { status: 404 });
      }

      if (data.agent_last_seen) {
        const ageMs = Date.now() - new Date(data.agent_last_seen).getTime();
        const ageSec = Math.round(ageMs / 1000);
        if (ageMs < 30_000) {
          return Response.json({ ok: true, host: data.host, method: "heartbeat", ageSec });
        }
        return Response.json({
          ok: false, host: data.host, method: "heartbeat", ageSec,
          error: `Agent last seen ${ageSec}s ago — may be offline`,
        });
      }
    }

    // No heartbeat yet — use last successful deploy as a proxy signal
    const { data: recent } = await supabase
      .from("sessions")
      .select("updated_at")
      .eq("deploy_status", "done")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (recent && recent.length > 0) {
      const ageMin = Math.round((Date.now() - new Date(recent[0].updated_at).getTime()) / 60_000);
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
      error: "No heartbeat data. Make sure the agent is running on the tablet.",
    });
  } catch (error: unknown) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
