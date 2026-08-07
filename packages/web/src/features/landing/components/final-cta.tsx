import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { InstallTabs } from "@/components/install-tabs";
import { Button } from "@/components/ui/button";
import { Reveal } from "./reveal";

/** Closing moment — a contained glass panel with an ambient glow. */
export function FinalCta() {
  return (
    <section className="px-4 py-24 sm:px-6 md:py-28">
      <Reveal className="mx-auto w-full max-w-4xl">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-card/60 px-6 py-16 text-center shadow-2xl shadow-primary/10 sm:px-12 md:py-20">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-0 h-64 w-[34rem] max-w-full -translate-x-1/2 -translate-y-1/3 rounded-full bg-primary/15 blur-[100px]" />
          </div>

          <div className="relative flex flex-col items-center">
            <p className="font-mono text-xs tracking-widest text-primary uppercase">Install</p>
            <h2 className="mt-3 max-w-xl font-display text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl md:text-5xl">
              Your next session is one command away.
            </h2>
            <p className="mt-4 max-w-md text-pretty text-muted-foreground leading-relaxed">
              Free while in beta. Install, sign in, type{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">kvy</code>.
            </p>
            <div className="mt-9 flex w-full max-w-md flex-col items-stretch gap-4 sm:items-center">
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
          </div>
        </div>
      </Reveal>
    </section>
  );
}
