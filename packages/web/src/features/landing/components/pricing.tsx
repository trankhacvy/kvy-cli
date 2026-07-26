import { ArrowUpRight, Check } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Reveal } from "./reveal";

const FREE_FEATURES = [
  "Unlimited sessions and machines",
  "Claude Code + Codex providers",
  "End-to-end encryption",
  "Web dashboard + PWA push notifications",
  "Git diffs and one-click commit",
];

const SELF_HOST_FEATURES = [
  "Single Docker container",
  "Embedded database — zero dependencies",
  "Same codebase as production",
  "Your keys never touch our infrastructure",
];

/**
 * Two-tier pricing while in beta (billing is explicitly deferred in the PRD):
 * hosted-free and self-host-free. The self-host CTA goes to the repo, which
 * carries the `deploy/` walkthrough.
 */
export function Pricing() {
  return (
    <section className="border-border border-t px-4 py-24 sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="font-semibold text-3xl tracking-tighter sm:text-4xl">
            Free while in beta.
          </h2>
          <p className="mt-4 text-base text-muted-foreground leading-relaxed">
            Every feature, every machine, zero dollars. Self-host it forever.
          </p>
        </Reveal>

        <div className="mx-auto mt-12 grid max-w-3xl gap-4 sm:grid-cols-2">
          <Reveal>
            <div className="flex h-full flex-col rounded-xl border border-border bg-card p-6">
              <p className="font-medium text-sm">Hosted</p>
              <p className="mt-4 flex items-baseline gap-1.5">
                <span className="font-semibold text-4xl tracking-tight">$0</span>
                <span className="text-muted-foreground text-sm">/ month</span>
              </p>
              <p className="mt-2 text-muted-foreground text-sm">
                Everything you need while in beta.
              </p>
              <ul className="mt-6 flex flex-1 flex-col gap-2.5">
                {FREE_FEATURES.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                    {item}
                  </li>
                ))}
              </ul>
              <Button asChild className="mt-8 w-full">
                <Link href="/signin/">Get started</Link>
              </Button>
            </div>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="flex h-full flex-col rounded-xl border border-border bg-card p-6">
              <p className="font-medium text-sm">Self-host</p>
              <p className="mt-4 flex items-baseline gap-1.5">
                <span className="font-semibold text-4xl tracking-tight">$0</span>
                <span className="text-muted-foreground text-sm">/ forever</span>
              </p>
              <p className="mt-2 text-muted-foreground text-sm">Your relay, your rules.</p>
              <ul className="mt-6 flex flex-1 flex-col gap-2.5">
                {SELF_HOST_FEATURES.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                    {item}
                  </li>
                ))}
              </ul>
              <Button asChild variant="outline" className="mt-8 w-full">
                <a href="https://github.com/trankhacvy/falcon-cli" target="_blank" rel="noreferrer">
                  View the repo
                  <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
                </a>
              </Button>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
