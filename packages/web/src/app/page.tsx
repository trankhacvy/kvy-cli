import { Button } from "@/components/ui/button";

// Placeholder route — scaffold stage only (plan.md §1.6, first bullet). The
// session-list home screen (design §9.2) lands in a later 1.6 bullet once the
// sync engine and crypto bridge exist.
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Falcon</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Web app scaffold — Next.js App Router, static export, Tailwind + shadcn/ui, dark
        default theme. Auth, sync, and the session timeline are not wired up yet.
      </p>
      <Button variant="outline" disabled>
        Sign in (coming soon)
      </Button>
    </main>
  );
}
