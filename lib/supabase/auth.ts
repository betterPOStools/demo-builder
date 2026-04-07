// Extract authenticated user email from request cookies.
// Falls back to hardcoded email for now since we use service role key server-side.

import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const DEFAULT_EMAIL = "aaron@valuesystemspos.com";

export async function getUserEmail(): Promise<string> {
  try {
    const cookieStore = await cookies();
    const authCookie = cookieStore.getAll().find((c) =>
      c.name.includes("auth-token"),
    );

    if (!authCookie) return DEFAULT_EMAIL;

    // Use anon key to verify the token
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const {
      data: { user },
    } = await supabase.auth.getUser(authCookie.value);

    return user?.email ?? DEFAULT_EMAIL;
  } catch {
    return DEFAULT_EMAIL;
  }
}
