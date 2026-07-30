import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CopyCommand } from "./copy-command";
import { HeroPreview } from "./hero-preview";
import { Reveal } from "./reveal";

const CHIPS = ["Claude Code", "Codex", "E2E encrypted", "Self-hostable"];

/**
 * Centered hero (Briefberry skeleton): headline → sub → CTAs → product
 * moment, with the proof chips as a separate strip *below* the preview, not
 * inside the hero stack. Mount-staggered entrance via `Reveal immediate`.
 */
export function Hero() {
  return (
    <section className="px-4 pt-20 pb-16 sm:px-6 md:pt-24">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <Reveal immediate>
          <h1 className="font-semibold text-4xl tracking-tighter sm:text-5xl md:text-6xl">
            Walk away. Your agents won&rsquo;t.
          </h1>
        </Reveal>
        <Reveal immediate delay={0.08}>
          <p className="mt-5 max-w-xl text-base text-muted-foreground leading-relaxed sm:text-lg">
            Run Claude Code or Codex on your own machine: approve permissions, steer mid-session,
            and review diffs from any browser.
          </p>
        </Reveal>
        <Reveal immediate delay={0.16}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signin/">Get started</Link>
            </Button>
            <CopyCommand command="npm install -g falcon" />
          </div>
        </Reveal>
      </div>

      <Reveal immediate delay={0.24} className="mx-auto mt-14 max-w-2xl">
        <HeroPreview />
      </Reveal>

      <Reveal immediate delay={0.32}>
        <ul className="mt-10 flex flex-wrap items-center justify-center gap-2">
          {CHIPS.map((chip) => (
            <li
              key={chip}
              className="rounded-full border border-border bg-card px-3 py-1 text-muted-foreground text-xs"
            >
              {chip}
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
