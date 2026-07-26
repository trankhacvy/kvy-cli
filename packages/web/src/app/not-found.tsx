import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * App-Router 404 page (W1.10, plan.md §16 wave 1). Next's `app/not-found.tsx`
 * convention renders whenever a route doesn't match any page (including,
 * under the static export, a real session/machine id that just doesn't
 * exist in this build's prerendered set) or a page calls `notFound()`
 * itself. Not `"use client"` — this one has no hooks, unlike `error.tsx`.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        This page doesn't exist, or you don't have a link for it yet.
      </p>
      <Button asChild>
        <Link href="/dashboard/">Back to sessions</Link>
      </Button>
    </main>
  );
}
