import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Landing top bar — Briefberry-bare: logo left, auth actions right, no link
 * row. The logo box mirrors `AppShell`'s so the marketing surface and the app
 * share one identity mark.
 */
export function LandingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Falcon home">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground text-sm">
            F
          </span>
          <span className="font-semibold tracking-tight">Falcon</span>
        </Link>
        <nav className="flex items-center gap-2" aria-label="Account">
          <Button asChild variant="ghost" size="sm">
            <Link href="/signin/">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/signin/">Get started</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
