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

/** Kvy's worldview in three lines, replacing a vanity stats strip. */
export function Pillars() {
  return (
    <section className="border-border border-y px-4 sm:px-6">
      <div className="mx-auto grid w-full max-w-6xl gap-10 py-16 sm:grid-cols-3 sm:gap-8">
        {PILLARS.map((pillar, i) => (
          <Reveal key={pillar.title} delay={i * 0.06}>
            <pillar.icon className="size-5 text-primary" aria-hidden="true" />
            <h3 className="mt-3 font-semibold text-base">{pillar.title}</h3>
            <p className="mt-1.5 max-w-xs text-muted-foreground text-sm leading-relaxed">
              {pillar.description}
            </p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
