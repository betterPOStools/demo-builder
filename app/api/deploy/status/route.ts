import { turso } from "@/lib/turso";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const result = await turso.execute({
    sql: "SELECT deploy_status, deploy_result FROM sessions WHERE id = ? LIMIT 1",
    args: [sessionId],
  });

  if (result.rows.length === 0) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const row = result.rows[0];
  let deployResult = row.deploy_result;
  if (typeof deployResult === "string") {
    try { deployResult = JSON.parse(deployResult); } catch { /* leave as-is */ }
  }

  return Response.json({ status: row.deploy_status, result: deployResult });
}
