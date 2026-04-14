// GET /api/batch/feed
// Dashboard feed: aggregate status counts + recent job rows.
// Polled every 5s by the BatchFeed component on the home page.

import { createServerClient } from "@/lib/supabase/server";

export const revalidate = 0; // never cache — always fresh

export async function GET(): Promise<Response> {
  const supabase = createServerClient();

  const [countsRes, jobsRes] = await Promise.all([
    // Count per status using five parallel count queries
    Promise.all(
      (["queued", "processing", "done", "failed", "needs_pdf"] as const).map(
        async (status) => {
          const { count } = await supabase
            .from("batch_queue")
            .select("id", { count: "exact", head: true })
            .eq("status", status);
          return [status, count ?? 0] as const;
        },
      ),
    ),
    // 60 most-recently-updated jobs for the live feed
    supabase
      .from("batch_queue")
      .select("id, name, status, error, menu_url, updated_at")
      .order("updated_at", { ascending: false })
      .limit(60),
  ]);

  const counts = Object.fromEntries(countsRes) as Record<string, number>;
  const jobs = jobsRes.data ?? [];

  return Response.json({ counts, jobs }, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}
