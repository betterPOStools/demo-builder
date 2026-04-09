"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

export interface AuthState {
  user: User | null;
  loading: boolean;
}

const SKIP_AUTH = process.env.NEXT_PUBLIC_SKIP_AUTH === "true";

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!SKIP_AUTH);

  useEffect(() => {
    if (SKIP_AUTH) return;

    const supabase = createClient();

    const timeout = setTimeout(() => setLoading(false), 3000);
    supabase.auth.getUser().then(({ data }) => {
      clearTimeout(timeout);
      setUser(data.user);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (SKIP_AUTH) return { user: { id: "dev" } as User, loading: false };
  return { user, loading };
}

export async function signInWithEmail(email: string, password: string) {
  const supabase = createClient();
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
}
