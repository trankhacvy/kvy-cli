import Link from "next/link";
import { KvyMark } from "@/components/kvy-mark";

const FOOTER_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#principles", label: "Why Kvy" },
  { href: "#faq", label: "FAQ" },
] as const;

export function LandingFooter() {
  return (
    <footer className="border-border border-t px-4 py-12 sm:px-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="max-w-xs">
          <div className="flex items-center gap-2.5">
            <KvyMark className="size-7" />
            <span className="font-display font-semibold tracking-tight">kvy</span>
          </div>
          <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
            Run coding agents from anywhere. Local execution, end-to-end encrypted, one dashboard
            for every machine.
          </p>
        </div>

        <nav
          className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground"
          aria-label="Footer"
        >
          {FOOTER_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
          <a
            href="https://github.com/trankhacvy/kvy-cli"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            GitHub
          </a>
        </nav>

        <nav
          className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground"
          aria-label="Legal"
        >
          <Link href="/privacy" className="transition-colors hover:text-foreground">
            Privacy
          </Link>
          <Link href="/terms" className="transition-colors hover:text-foreground">
            Terms
          </Link>
          <Link href="/signin" className="transition-colors hover:text-foreground">
            Get started
          </Link>
        </nav>
      </div>

      <div className="mx-auto mt-10 flex w-full max-w-6xl items-center justify-between border-border border-t pt-6 text-xs text-muted-foreground">
        <p>© 2026 kvy</p>
        <p className="font-mono">local-first · zero-knowledge</p>
      </div>
    </footer>
  );
}
