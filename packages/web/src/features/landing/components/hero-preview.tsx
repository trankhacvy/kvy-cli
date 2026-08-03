import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * The hero's product moment: a miniature of the real dashboard — live
 * session, tool-call row, and the permission card that is Kvy's whole
 * reason to exist. Rendered with the app's actual UI primitives (Button,
 * Badge, token classes) rather than a screenshot, so it can never drift out
 * of date with the design system. Decorative: hidden from assistive tech,
 * and its buttons are unfocusable.
 */
export function HeroPreview() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-xl border border-border bg-card text-left shadow-2xl shadow-black/25"
    >
      {/* Window chrome */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        </div>
        <div className="mx-auto flex h-6 w-52 items-center justify-center rounded-md bg-muted/60 font-mono text-[11px] text-muted-foreground sm:w-64">
          kvy-cli.tkvy.dev/dashboard
        </div>
        <Badge variant="outline" className="gap-1.5">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          Live
        </Badge>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {/* Prompt */}
        <div className="flex gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary font-medium text-xs">
            You
          </span>
          <p className="pt-1 text-sm leading-6">
            Add dark-mode support to the settings page and run the tests.
          </p>
        </div>

        {/* Assistant + tool call */}
        <div className="flex gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 font-medium text-primary text-xs">
            C
          </span>
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            <p className="text-sm leading-6">Updated 3 files. Running the test suite now.</p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
              <span className="text-muted-foreground">$</span>
              <span className="truncate">pnpm test</span>
              <span className="ml-auto shrink-0 text-primary">exit 0</span>
            </div>
          </div>
        </div>

        {/* The permission card — the magic moment */}
        <div className="ml-6 rounded-lg border border-primary/30 bg-primary/5 p-3.5 sm:ml-10">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-sm">
            <ShieldCheck className="size-4 text-primary" />
            Permission requested
            <span className="font-normal text-muted-foreground">· just now</span>
          </div>
          <p className="mt-1.5 font-mono text-muted-foreground text-xs">
            Bash: pnpm install && pnpm build
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" tabIndex={-1}>
              Allow
            </Button>
            <Button size="sm" variant="outline" tabIndex={-1}>
              Deny
            </Button>
            <Button size="sm" variant="ghost" tabIndex={-1}>
              Allow for session
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
