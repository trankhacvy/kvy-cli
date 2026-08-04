import Link from "next/link";
import { InstallTabs } from "@/components/install-tabs";
import { Button } from "@/components/ui/button";
import { Reveal } from "./reveal";

/** Closing moment — same CTAs as the hero, one last time. */
export function FinalCta() {
  return (
    <section className="border-border border-t px-4 py-28 sm:px-6">
      <Reveal className="mx-auto flex max-w-2xl flex-col items-center text-center">
        <h2 className="font-semibold text-3xl tracking-tighter sm:text-4xl">
          Your next session is one command away.
        </h2>
        <p className="mt-4 text-base text-muted-foreground leading-relaxed">
          Free while in beta. Install, sign in, type{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">kvy</code>.
        </p>
        <div className="mt-8 flex flex-col items-center gap-4">
          <Button asChild size="lg">
            <Link href="/signin/">Get started</Link>
          </Button>
          <InstallTabs className="max-w-md" />
        </div>
      </Reveal>
    </section>
  );
}
