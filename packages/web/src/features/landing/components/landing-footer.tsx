import Link from "next/link";

export function LandingFooter() {
  return (
    <footer className="border-border border-t px-4 py-8 sm:px-6">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm">
        <p>© 2026 Falcon</p>
        <nav className="flex flex-wrap items-center gap-5" aria-label="Footer">
          <a
            href="https://github.com/trankhacvy/falcon-cli"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <Link href="/privacy/" className="transition-colors hover:text-foreground">
            Privacy
          </Link>
          <Link href="/terms/" className="transition-colors hover:text-foreground">
            Terms
          </Link>
          <Link href="/signin/" className="transition-colors hover:text-foreground">
            Sign in
          </Link>
          <Link href="/signin/" className="transition-colors hover:text-foreground">
            Get started
          </Link>
        </nav>
      </div>
    </footer>
  );
}
