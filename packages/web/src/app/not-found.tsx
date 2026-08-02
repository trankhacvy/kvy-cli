import Link from "next/link";
import { Button } from "@/components/ui/button";

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
