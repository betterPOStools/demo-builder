// app/api/batch/status/route.ts
// GET /api/batch/status?pt_record_ids=uuid1,uuid2,...
// Returns the current demo generation status for a list of Prospect Tracker
// record IDs. Combines batch_queue rows (in-flight state) with sessions rows
// (completed state) to give callers a unified view per prospect.

import { createServerClient } from "@/lib/supabase/server";

type BatchQueueStatus = "queued" | "processing" | "done" | "failed" | "needs_pdf";
type ResultStatus = "no_snapshot" | BatchQueueStatus;

interface BatchQueueRow {
  id: string;
  pt_record_id: string;
  name: string;
  menu_url: string;
  restaurant_type: string;
  status: BatchQueueStatus;
  session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  pt_record_id: string;
  created_at: string;
}

interface StatusResult {
  pt_record_id: string;
  status: ResultStatus;
  session_id: string | null;
  error: string | null;
  created_at: string | null;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const rawIds = searchParams.get("pt_record_ids");

  if (!rawIds) {
    return Response.json(
      { error: "pt_record_ids query parameter is required" },
      { status: 400 },
    );
  }

  const ptRecordIds = rawIds
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ptRecordIds.length === 0) {
    return Response.json(
      { error: "pt_record_ids must contain at least one UUID" },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  // Fetch the most recent batch_queue row per pt_record_id
  const { data: queueRows, error: queueError } = await supabase
    .from("batch_queue")
    .select("id, pt_record_id, name, menu_url, restaurant_type, status, session_id, error, created_at, updated_at")
    .in("pt_record_id", ptRecordIds)
    .order("updated_at", { ascending: false });

  if (queueError) {
    return Response.json({ error: queueError.message }, { status: 500 });
  }

  // Fetch sessions that have completed for these PT records
  const { data: sessionRows, error: sessionError } = await supabase
    .from("sessions")
    .select("id, pt_record_id, created_at")
    .in("pt_record_id", ptRecordIds)
    .in("deploy_status", ["idle", "done"]);

  if (sessionError) {
    return Response.json({ error: sessionError.message }, { status: 500 });
  }

  // Index rows by pt_record_id for O(1) lookup.
  // For batch_queue, keep the first (most recent due to DESC order) row per ID.
  const queueByPtId = new Map<string, BatchQueueRow>();
  for (const row of (queueRows ?? []) as BatchQueueRow[]) {
    if (!queueByPtId.has(row.pt_record_id)) {
      queueByPtId.set(row.pt_record_id, row);
    }
  }

  const sessionByPtId = new Map<string, SessionRow>();
  for (const row of (sessionRows ?? []) as SessionRow[]) {
    if (!sessionByPtId.has(row.pt_record_id)) {
      sessionByPtId.set(row.pt_record_id, row);
    }
  }

  const results: StatusResult[] = ptRecordIds.map((ptId) => {
    const queueRow = queueByPtId.get(ptId);
    const sessionRow = sessionByPtId.get(ptId);

    if (!queueRow && !sessionRow) {
      return {
        pt_record_id: ptId,
        status: "no_snapshot",
        session_id: null,
        error: null,
        created_at: null,
      };
    }

    return {
      pt_record_id: ptId,
      status: queueRow ? queueRow.status : "done",
      session_id: queueRow?.session_id ?? sessionRow?.id ?? null,
      error: queueRow?.error ?? null,
      created_at: sessionRow?.created_at ?? queueRow?.created_at ?? null,
    };
  });

  return Response.json({ results });
}
