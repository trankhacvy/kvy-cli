"use client";

import { Button } from "@/components/ui/button";

/**
 * App-Router error boundary (W1.10, plan.md §16 wave 1: "Error boundaries +
 * decrypt-failure surface"). Next's `app/error.tsx` convention wraps every
 * page under this segment — the whole app, since there's no narrower
 * `error.tsx` yet — in a client-side React error boundary; whatever a page
 * component throws during render (or a hook throws synchronously, e.g.
 * `use-live-render-items.ts`'s `getSessionMessages` query function throwing
 * `"Not signed in"`) lands here instead of a blank white screen.
 *
 * Must be a Client Component (Next's own requirement for `error.tsx`) — no
 * different from every other screen in `src/app/`, which is already
 * client-only end to end (design §5.3: no server ever renders user content
 * in this app, since it's ciphertext to the server anyway).
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        {error.message || "An unexpected error occurred."}
      </p>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
