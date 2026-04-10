// Poll deploy status for a session

import { createServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("deploy_status, deploy_result")
    .eq("id", sessionId)
    .single();

  if (error) {
    return Response.json(
      { error: `Session not found: ${error.message}` },
      { status: 404 },
    );
  }

  // deploy_result is stored as a JSON string by the agent — parse it
  let result = data.deploy_result;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { /* leave as-is */ }
  }

  return Response.json({
    status: data.deploy_status,
    result,
  });
}
