"use client";

import Link from "next/link";
import { Layers, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { useAuth, signOut } from "@/lib/hooks/useAuth";

export function TopHeader() {
  const restaurantName = useStore((s) => s.restaurantName);
  const setRestaurantName = useStore((s) => s.setRestaurantName);
  const isDirty = useStore((s) => s.isDirty);
  const { user } = useAuth();

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-700 bg-slate-900 px-4">
      <div className="flex items-center gap-4">
        <Link href="/" className="flex items-center gap-2 text-slate-200 hover:text-white">
          <Layers className="h-5 w-5 text-blue-500" />
          <span className="text-sm font-semibold tracking-tight">Demo Builder</span>
        </Link>
        <div className="h-5 w-px bg-slate-700" />
        <input
          type="text"
          value={restaurantName}
          onChange={(e) => setRestaurantName(e.target.value)}
          placeholder="Restaurant name..."
          className="h-8 w-48 rounded-md border border-slate-700 bg-slate-800 px-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-2">
        {isDirty && (
          <span className="text-xs text-slate-500">Auto-saving...</span>
        )}
        {user && (
          <>
            <span className="text-xs text-slate-500">{user.email}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-slate-500 hover:text-slate-300"
              onClick={() => signOut()}
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
