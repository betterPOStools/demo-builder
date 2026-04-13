// app/api/batch/queue/route.ts
// POST /api/batch/queue — Accept a list of Prospect Tracker leads and insert
// them into batch_queue for automated demo generation. Each prospect's free-text
// restaurant type is normalized to a RestaurantType enum value before insert.

import { createServerClient } from "@/lib/supabase/server";

type RestaurantType =
  | "fast_casual"
  | "fast_food"
  | "pizza"
  | "bar_grill"
  | "fine_dining"
  | "cafe"
  | "breakfast"
  | "mexican"
  | "asian"
  | "seafood"
  | "other";

interface ProspectInput {
  pt_record_id: string;
  name: string;
  menu_url: string;
  restaurant_type: string;
}

interface QueueRequestBody {
  prospects: ProspectInput[];
  skip_if_exists?: boolean;
}

interface QueueResult {
  queued: number;
  skipped: number;
  invalid: number;
}

function normalizeRestaurantType(raw: string): RestaurantType {
  const t = raw.toLowerCase();
  if (t.includes("pizza"))                                                      return "pizza";
  if (t.includes("bar") || t.includes("grill") || t.includes("pub"))           return "bar_grill";
  if (t.includes("fine") || t.includes("upscale") || t.includes("steakhouse")) return "fine_dining";
  if (t.includes("cafe") || t.includes("coffee") || t.includes("bakery"))      return "cafe";
  if (t.includes("fast food") || t.includes("quick") || t.includes("drive"))   return "fast_food";
  if (t.includes("breakfast") || t.includes("brunch") || t.includes("diner"))  return "breakfast";
  if (t.includes("mexican") || t.includes("taco") || t.includes("burrito"))    return "mexican";
  if (t.includes("asian") || t.includes("chinese") || t.includes("japanese") || t.includes("thai") || t.includes("sushi")) return "asian";
  if (t.includes("seafood") || t.includes("fish") || t.includes("crab"))       return "seafood";
  if (t.includes("sandwich") || t.includes("sub") || t.includes("wrap") || t.includes("bowl")) return "fast_casual";
  return "other";
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as QueueRequestBody).prospects)
  ) {
    return Response.json(
      { error: "Body must be an object with a prospects array" },
      { status: 400 },
    );
  }

  const { prospects, skip_if_exists = true } = body as QueueRequestBody;

  if (prospects.length === 0) {
    return Response.json(
      { error: "prospects array must have at least 1 entry" },
      { status: 400 },
    );
  }

  const supabase = createServerClient();
  const result: QueueResult = { queued: 0, skipped: 0, invalid: 0 };

  for (const prospect of prospects) {
    // Skip entries with no menu URL — nothing to extract from
    if (!prospect.menu_url) {
      result.invalid++;
      continue;
    }

    // BUSINESS RULE: skip_if_exists (default true) — if a session already
    // exists for this PT record in a completed or stable state (idle/done),
    // we do not re-queue it. This prevents duplicate demo generation when the
    // same batch is submitted more than once (e.g. re-running for new leads
    // added to a Prospect Tracker saved search).
    if (skip_if_exists !== false) {
      const { data: existingSession, error: sessionError } = await supabase
        .from("sessions")
        .select("id")
        .eq("pt_record_id", prospect.pt_record_id)
        .in("deploy_status", ["idle", "done"])
        .maybeSingle();

      if (sessionError) {
        return Response.json({ error: sessionError.message }, { status: 500 });
      }

      if (existingSession) {
        result.skipped++;
        continue;
      }
    }

    const { error: insertError } = await supabase.from("batch_queue").insert({
      pt_record_id: prospect.pt_record_id,
      name: prospect.name,
      menu_url: prospect.menu_url,
      restaurant_type: normalizeRestaurantType(prospect.restaurant_type),
      status: "queued",
    });

    if (insertError) {
      return Response.json({ error: insertError.message }, { status: 500 });
    }

    result.queued++;
  }

  return Response.json(result);
}
