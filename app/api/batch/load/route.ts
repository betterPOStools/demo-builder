// app/api/batch/load/route.ts
//
// Finds the pre-generated demo session for a Prospect Tracker record, wires up
// a deploy target connection, and sets deploy_status = 'queued' so the local
// deploy agent picks it up and executes the SQL against MariaDB.

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

interface LoadRequestBody {
  pt_record_id: string;
  connection_id?: string;
}

interface DeployTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  upload_server_url: string | null;
}

interface ConnectionRow {
  id: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password_encrypted: string;
  upload_server_url: string | null;
}

interface SessionRow {
  id: string;
  pt_record_id: string;
  deploy_status: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { pt_record_id, connection_id } = body as LoadRequestBody;

  // --- Validate ---
  if (!pt_record_id || typeof pt_record_id !== "string") {
    return NextResponse.json(
      { error: "pt_record_id is required." },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  // Phase A2 (2026-04-14) stripped the `db_` prefix from batch_queue.pt_record_id
  // but left demo_builder.sessions.pt_record_id untouched — 745 of 753 rows still
  // carry the prefix. PT sends `db_<placeId>`, VPT sends the raw place_id. Match
  // both so either client resolves the same session.
  const sessionCandidates = pt_record_id.startsWith("db_")
    ? [pt_record_id, pt_record_id.slice(3)]
    : [pt_record_id, `db_${pt_record_id}`];

  // --- Look up the session ---
  const { data: sessionData, error: sessionError } = await supabase
    .from("sessions")
    .select("id, pt_record_id, deploy_status")
    .in("pt_record_id", sessionCandidates)
    .in("deploy_status", ["idle", "done", "failed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sessionError) {
    console.error("[batch/load] session lookup error:", sessionError);
    return NextResponse.json(
      { error: "Failed to query sessions.", detail: sessionError.message },
      { status: 500 },
    );
  }

  if (!sessionData) {
    return NextResponse.json(
      {
        error:
          "No pre-generated demo found for this prospect. Run batch generation first.",
      },
      { status: 404 },
    );
  }

  const session = sessionData as SessionRow;

  // --- Look up the connection ---
  // BUSINESS RULE: If no connection_id is supplied, fall back to the connection
  // named "Demo Tablet" owned by aaron@valuesystemspos.com. This is the standard
  // field-demo target (Tailscale IP 100.112.68.19) used for all sales demos.
  // Requiring the caller to always pass a connection_id would break the simple
  // one-click "Load to Tablet" flow in the Prospect Tracker integration.
  let connectionQuery;
  if (connection_id) {
    connectionQuery = supabase
      .from("connections")
      .select(
        "id, host, port, database_name, username, password_encrypted, upload_server_url",
      )
      .eq("id", connection_id)
      .maybeSingle();
  } else {
    connectionQuery = supabase
      .from("connections")
      .select(
        "id, host, port, database_name, username, password_encrypted, upload_server_url",
      )
      .ilike("name", "Demo Tablet")
      .eq("user_email", "aaron@valuesystemspos.com")
      .limit(1)
      .maybeSingle();
  }

  const { data: connectionData, error: connectionError } = await connectionQuery;

  if (connectionError) {
    console.error("[batch/load] connection lookup error:", connectionError);
    return NextResponse.json(
      { error: "Failed to query connections.", detail: connectionError.message },
      { status: 500 },
    );
  }

  if (!connectionData) {
    return NextResponse.json(
      {
        error:
          "No deploy target found. Save a connection named 'Demo Tablet' in Demo Builder settings.",
      },
      { status: 400 },
    );
  }

  const connection = connectionData as ConnectionRow;

  const deployTarget: DeployTarget = {
    host: connection.host,
    port: connection.port,
    database: connection.database_name,
    user: connection.username,
    password: connection.password_encrypted,
    upload_server_url: connection.upload_server_url ?? null,
  };

  // --- Queue the session ---
  const { error: updateError } = await supabase
    .from("sessions")
    .update({
      deploy_status: "queued",
      deploy_target: deployTarget,
      deploy_result: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  if (updateError) {
    console.error("[batch/load] session update error:", updateError);
    return NextResponse.json(
      { error: "Failed to queue session.", detail: updateError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    session_id: session.id,
    message: "Demo queued for deployment. Ready in ~25 seconds.",
  });
}
