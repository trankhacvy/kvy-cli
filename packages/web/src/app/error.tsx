"use client";

import { Button } from "@/components/ui/button";

// Must be a Client Component — Next.js requires `error.tsx` to be `"use client"`.
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
