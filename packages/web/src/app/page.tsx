import Link from "next/link";
import { Button } from "@/components/ui/button";

// Placeholder route — scaffold stage only (plan.md §1.6). The session-list
// home screen (design §9.2) lands in a later 1.6 bullet once the sync engine
// is wired up; auth (this bullet) now has real pages under /signin.
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Falcon</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Web app scaffold — Next.js App Router, static export, Tailwind + shadcn/ui, dark default
        theme. The session timeline is not wired up yet.
      </p>
      <Button asChild variant="outline">
        <Link href="/signin/">Sign in</Link>
      </Button>
    </main>
  );
}
