import type { LucideIcon } from "lucide-react";
import { Laptop, Layers, LockKeyhole } from "lucide-react";
import { Reveal } from "./reveal";

type Pillar = {
  icon: LucideIcon;
  title: string;
  description: string;
};

const PILLARS: Pillar[] = [
  {
    icon: Laptop,
    title: "Local-first",
    description: "Your code runs on your machine. Nothing executes in our cloud, ever.",
  },
  {
    icon: LockKeyhole,
    title: "Zero-knowledge",
    description:
      "Everything mirrored to the web is encrypted before it leaves your device. We can't read it either.",
  },
  {
    icon: Layers,
    title: "Any agent, one dashboard",
    description: "Claude Code, Codex, and whatever you run next, in the same timeline.",
  },
];

/** Kvy's worldview — an editorial two-column block, not a vanity stats strip. */
export function Pillars() {
  return (
    <section id="principles" className="scroll-mt-24 border-border border-y px-4 sm:px-6">
      <div className="mx-auto grid w-full max-w-6xl gap-12 py-16 md:grid-cols-[1fr_2fr] md:gap-16 md:py-20">
        <Reveal>
          <p className="font-mono text-xs tracking-widest text-primary uppercase">Principles</p>
          <h2 className="mt-3 max-w-sm font-display text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
            Your machine, your keys, your agents.
          </h2>
          <p className="mt-4 max-w-sm text-pretty text-muted-foreground leading-relaxed">
            Everything Kvy does follows from these three commitments. They are the product, not a
            marketing line.
          </p>
        </Reveal>

        <div className="divide-border divide-y">
          {PILLARS.map((pillar, i) => (
            <Reveal
              key={pillar.title}
              delay={i * 0.07}
              className="flex flex-col gap-3 py-6 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-6"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <pillar.icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="font-display text-lg font-semibold tracking-tight">
                  {pillar.title}
                </h3>
                <p className="mt-1.5 max-w-md text-pretty text-muted-foreground leading-relaxed">
                  {pillar.description}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
