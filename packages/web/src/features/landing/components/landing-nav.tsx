import Link from "next/link";
import { GithubIcon } from "@/components/icons/github";
import { KvyMark } from "@/components/kvy-mark";
import { Button } from "@/components/ui/button";

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#principles", label: "Why Kvy" },
  { href: "#faq", label: "FAQ" },
] as const;

/**
 * Landing top bar — logo left, anchor links center (desktop only), repo +
 * auth actions right. The logo box mirrors `AppShell`'s so the marketing
 * surface and the app share one identity mark.
 */
export function LandingNav() {
  return (
    <header className="sticky top-0 z-40 border-border/60 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/60">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Kvy home">
          <KvyMark className="size-8" />
          <span className="font-display font-semibold tracking-tight">kvy</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Landing">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-2">
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
        </div>
      </div>
    </header>
  );
}
