"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth, signInWithEmail, signOut } from "@/lib/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Layers, Loader2 } from "lucide-react";

// Routes that don't require authentication (phone/public pages)
const PUBLIC_PREFIXES = ["/upload"];

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading } = useAuth();

  // Public routes bypass auth entirely
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return <>{children}</>;
  }
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f1117]">
        <div className="flex items-center gap-3 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Checking authentication...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    async function handleSignIn(e: React.FormEvent) {
      e.preventDefault();
      setError(null);
      setSigningIn(true);
      const { error: authError } = await signInWithEmail(email, password);
      if (authError) {
        setError(authError.message);
      }
      setSigningIn(false);
    }

    return (
      <div className="flex h-screen items-center justify-center bg-[#0f1117] px-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="mb-2 flex items-center justify-center gap-2">
              <Layers className="h-6 w-6 text-blue-500" />
              <CardTitle>Demo Builder</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSignIn} className="space-y-3">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && (
                <p className="text-xs text-red-400">{error}</p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={signingIn}
              >
                {signingIn ? "Signing in..." : "Sign In"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
