import type { LucideIcon } from "lucide-react";
import { LockKeyhole, Radio, ShieldCheck, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Reveal } from "./reveal";

type Feature = {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Wide cells carry a faint primary tint so the 4-cell bento has rhythm. */
  wide?: boolean;
};

const FEATURES: Feature[] = [
  {
    icon: Radio,
    title: "Mirror every session, live",
    description:
      "A structured timeline, not a terminal dump: tool-call cards, collapsible thinking, inline diffs, and attention badges across all your machines.",
    wide: true,
  },
  {
    icon: ShieldCheck,
    title: "Approve from anywhere",
    description:
      "A push notification when the agent needs you. Tap Allow, Deny, or Allow-for-session. It keeps going in about a second.",
  },
  {
    icon: SquareTerminal,
    title: "Steer and spawn",
    description:
      "Send follow-ups, interrupt, or take control from any browser. Start new sessions on any machine: fresh branch or worktree included.",
  },
  {
    icon: LockKeyhole,
    title: "Zero-knowledge by design",
    description:
      "Keys are generated on your devices and content is encrypted before it leaves. The relay stores only ciphertext. Self-host the whole stack in one container.",
    wide: true,
  },
];

/** Feature bento — 4 cells as wide+1 / 1+wide on desktop, stacked on mobile. */
export function Features() {
  return (
    <section className="px-4 py-24 sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <Reveal className="max-w-2xl">
          <h2 className="font-semibold text-3xl tracking-tighter sm:text-4xl">
            One dashboard for every session, on every machine.
          </h2>
          <p className="mt-4 text-base text-muted-foreground leading-relaxed">
            Stop babysitting terminals. Falcon turns long agent runs into a check-in workflow.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <Reveal
              key={feature.title}
              delay={(i % 2) * 0.06}
              className={cn(feature.wide && "md:col-span-2")}
            >
              <div
                className={cn(
                  "flex h-full flex-col gap-4 rounded-xl border border-border bg-card p-6 transition-colors hover:border-foreground/20",
                  feature.wide && "bg-linear-to-br from-primary/8 via-card to-card",
                )}
              >
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <feature.icon className="size-5" aria-hidden="true" />
                </span>
                <div className="space-y-1.5">
                  <h3 className="font-semibold text-base">{feature.title}</h3>
                  <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
