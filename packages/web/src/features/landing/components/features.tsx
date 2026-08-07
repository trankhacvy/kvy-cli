import type { LucideIcon } from "lucide-react";
import { Radio, ShieldCheck, SquareTerminal } from "lucide-react";
import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PreviewFloat } from "./preview-float";
import { Reveal } from "./reveal";

/** Row 1 visual: a session timeline, not a terminal dump. */
function TimelinePreview() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-2xl border border-border bg-card text-left shadow-xl shadow-primary/5"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Radio className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-muted-foreground text-xs">Session timeline</span>
        <Badge variant="outline" className="ml-auto gap-1.5">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          Live
        </Badge>
      </div>
      <div className="space-y-3 p-4">
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="font-mono text-muted-foreground text-xs">Edit · src/settings/theme.tsx</p>
          <div className="mt-1.5 space-y-0.5 font-mono text-xs">
            <p className="text-primary">+ const [theme, setTheme] = useDarkMode();</p>
            <p className="text-muted-foreground/50 line-through">- const theme = "light";</p>
          </div>
        </div>
        <div className="rounded-lg border border-border px-3 py-2 text-muted-foreground text-xs">
          Thinking · collapsed
        </div>
        <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-400">
          <span className="font-medium">Needs your attention</span>
          <span>2 machines</span>
        </div>
      </div>
    </div>
  );
}

/** Row 2 visual: the push notification that lets you approve from anywhere. */
function ApprovalPreview() {
  return (
    <div
      aria-hidden="true"
      className="flex justify-center overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-xl shadow-primary/5 sm:p-8"
    >
      <div className="w-full max-w-56 rounded-2xl border border-border bg-background p-3 shadow-lg">
        <div className="flex items-center gap-2.5 rounded-xl bg-muted/60 p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center justify-between font-medium text-xs">
              kvy <span className="text-muted-foreground">now</span>
            </p>
            <p className="truncate text-muted-foreground text-xs">
              Permission requested: pnpm install
            </p>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" className="flex-1" tabIndex={-1}>
            Allow
          </Button>
          <Button size="sm" variant="outline" className="flex-1" tabIndex={-1}>
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Row 3 visual: steering a session and spawning a new one elsewhere. */
function SteerPreview() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-2xl border border-border bg-card text-left shadow-xl shadow-primary/5"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        </div>
        <span className="font-mono text-muted-foreground text-xs">New session</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
          <SquareTerminal className="size-3.5 text-muted-foreground" />
          <span>MacBook Pro</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">new branch feature/dark-mode</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
          <span className="flex-1 truncate text-muted-foreground text-sm">
            Also update the docs for this...
          </span>
          <Button size="sm" tabIndex={-1}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

type Feature = {
  icon: LucideIcon;
  title: string;
  description: string;
  Preview: ComponentType;
};

const FEATURES: Feature[] = [
  {
    icon: Radio,
    title: "Mirror every session, live",
    description:
      "A structured timeline, not a terminal dump: tool-call cards, collapsible thinking, inline diffs, and attention badges across every machine you run on.",
    Preview: TimelinePreview,
  },
  {
    icon: ShieldCheck,
    title: "Approve from anywhere",
    description:
      "A push notification when the agent needs you. Tap Allow, Deny, or Allow-for-session. It keeps going in about a second.",
    Preview: ApprovalPreview,
  },
  {
    icon: SquareTerminal,
    title: "Steer and spawn",
    description:
      "Send follow-ups, interrupt, or take control from any browser. Start new sessions on any machine: fresh branch or worktree included.",
    Preview: SteerPreview,
  },
];

/** Feature rows, each with its own dedicated visual, alternating sides. */
export function Features() {
  return (
    <section id="features" className="relative scroll-mt-24 px-4 py-24 sm:px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 hidden overflow-hidden lg:block"
      >
        <div className="absolute top-1/3 left-1/2 h-[24rem] w-[36rem] -translate-x-1/2 rounded-full bg-primary/5 blur-[120px]" />
      </div>

      <div className="mx-auto w-full max-w-6xl">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-xs tracking-widest text-primary uppercase">Workflow</p>
          <h2 className="mt-3 font-display text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl md:text-5xl">
            One dashboard for every session, on every machine.
          </h2>
          <p className="mt-4 text-pretty text-base text-muted-foreground leading-relaxed">
            Stop babysitting terminals. kvy turns long agent runs into a check-in workflow.
          </p>
        </Reveal>

        <div className="mt-16 flex flex-col gap-20">
          {FEATURES.map((feature, i) => (
            <Reveal
              key={feature.title}
              className={cn(
                "flex flex-col items-center gap-10 lg:flex-row lg:gap-16",
                i % 2 === 1 && "lg:flex-row-reverse",
              )}
            >
              <div className="w-full max-w-md lg:flex-1">
                <PreviewFloat className="transition-[box-shadow] duration-300 hover:shadow-2xl hover:shadow-primary/15">
                  <feature.Preview />
                </PreviewFloat>
              </div>
              <div className="w-full max-w-md lg:flex-1">
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <feature.icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 font-display text-xl font-semibold tracking-tight">
                  {feature.title}
                </h3>
                <p className="mt-2 text-pretty text-muted-foreground leading-relaxed">
                  {feature.description}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
