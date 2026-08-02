import Link from "next/link";
import { GithubIcon } from "@/components/icons/github";
import { KvyMark } from "@/components/kvy-mark";
import { Button } from "@/components/ui/button";

/**
 * Landing top bar — Briefberry-bare: logo left, repo link + auth actions
 * right, no link row. The logo box mirrors `AppShell`'s so the marketing
 * surface and the app share one identity mark.
 */
export function LandingNav() {
  return (
    <header className="sticky top-0 z-40 border-border/60 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/60">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Kvy home">
          <KvyMark className="size-8" />
          <span className="font-semibold tracking-tight">KVY</span>
        </Link>
        <nav className="flex items-center gap-1.5 sm:gap-2" aria-label="Account">
          <Button asChild variant="ghost" size="icon-sm" aria-label="View source on GitHub">
            <a href="https://github.com/trankhacvy/kvy-cli" target="_blank" rel="noreferrer">
              <GithubIcon className="size-4.5" />
            </a>
          </Button>
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
