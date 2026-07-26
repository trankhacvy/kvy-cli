import { Reveal } from "./reveal";

/**
 * Briefberry's stats strip, filled with honest, checkable numbers instead of
 * a vanity count — every figure is a shipped product property (PRD §1.3's
 * time-to-magic target, FR-7.4's permission latency, §2.2's provider list,
 * FR-5.1's zero-knowledge relay).
 */
const STATS = [
  { value: "< 5 min", label: "Install to first remote-controlled session" },
  { value: "~1 s", label: "Permission answer to agent continuing" },
  { value: "2", label: "Providers — Claude Code + Codex" },
  { value: "0", label: "Plaintext bytes stored server-side" },
] as const;

export function Stats() {
  return (
    <section className="border-border border-y px-4 sm:px-6">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-x-6 gap-y-10 py-12 md:grid-cols-4">
        {STATS.map((stat, i) => (
          <Reveal key={stat.label} delay={i * 0.06} className="text-center">
            <p className="font-mono text-2xl tracking-tight sm:text-3xl">{stat.value}</p>
            <p className="mx-auto mt-2 max-w-44 text-muted-foreground text-sm leading-snug">
              {stat.label}
            </p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
