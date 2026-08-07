import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { InstallTabs } from "@/components/install-tabs";
import { Button } from "@/components/ui/button";
import { HeroPreview } from "./hero-preview";
import { Reveal } from "./reveal";

/**
 * Centered hero with presence: eyebrow → display headline with an accent
 * phrase → sub → CTAs → install command → the product moment. The preview
 * carries the "real product" proof, framed by an ambient primary glow and
 * a hard noise break so the dark surface never feels flat.
 */
export function Hero() {
  return (
    <section className="relative px-4 pt-16 pb-16 sm:px-6 md:pt-24 md:pb-20">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem]"
      >
        <div className="absolute left-1/2 top-0 h-[26rem] w-[46rem] max-w-[90vw] -translate-x-1/2 rounded-full bg-primary/12 blur-[110px]" />
      </div>

      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <Reveal immediate>
          <Link
            href="#features"
            className="group inline-flex items-center gap-2 rounded-full border border-border bg-background/60 py-1 pr-3 pl-1 text-sm text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
          >
            <span className="rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary text-xs">
              Beta
            </span>
            Free while in beta
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </Reveal>

        <Reveal immediate delay={0.06}>
          <h1 className="mt-6 max-w-2xl font-display text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl md:text-7xl">
            Run coding agents{" "}
            <span className="bg-gradient-to-br from-primary via-primary to-primary/40 bg-clip-text text-transparent">
              from anywhere.
            </span>
          </h1>
        </Reveal>

        <Reveal immediate delay={0.12}>
          <p className="mt-6 max-w-xl text-pretty text-base text-muted-foreground leading-relaxed sm:text-lg">
            Claude Code, Codex, and more, running on your own machine. Approve permissions, steer
            mid-session, and review diffs from any browser.
          </p>
        </Reveal>

        <Reveal immediate delay={0.18} className="w-full">
          <div className="mx-auto mt-9 flex w-full max-w-md flex-col items-stretch gap-4 sm:items-center">
            <Button asChild size="lg" className="gap-2 self-center">
              <Link href="/signin/">
                Get started
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <div className="w-full">
              <InstallTabs className="max-w-md" />
            </div>
          </div>
        </Reveal>
      </div>

      <Reveal immediate delay={0.24} className="mx-auto mt-16 w-full max-w-5xl px-0">
        <HeroPreview />
      </Reveal>
    </section>
  );
}
