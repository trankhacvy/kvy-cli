import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CopyCommand } from "./copy-command";
import { HeroPreview } from "./hero-preview";
import { Reveal } from "./reveal";

/**
 * Centered hero (Briefberry skeleton): headline → sub → CTAs → product
 * moment. The preview itself carries the "real product" proof now, so there's
 * no separate chip strip underneath it. Mount-staggered entrance via `Reveal
 * immediate`.
 */
export function Hero() {
  return (
    <section className="px-4 pt-20 pb-16 sm:px-6 md:pt-24">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <Reveal immediate>
          <h1 className="font-semibold max-w-xl text-4xl leading-tight tracking-tighter sm:text-5xl md:text-6xl">
            Run coding agents from anywhere.
          </h1>
        </Reveal>
        <Reveal immediate delay={0.08}>
          <p className="mt-5 max-w-xl text-base text-muted-foreground leading-relaxed sm:text-lg">
            Claude Code, Codex, and more, running on your own machine. Approve permissions, steer
            mid-session, and review diffs from any browser.
          </p>
        </Reveal>
        <Reveal immediate delay={0.16}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signin/">Get started</Link>
            </Button>
            <CopyCommand command="npm install -g @vibe-oss/kvy" />
          </div>
        </Reveal>
      </div>

      <Reveal immediate delay={0.24} className="mx-auto mt-14 max-w-2xl">
        <HeroPreview />
      </Reveal>
    </section>
  );
}
