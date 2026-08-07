import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Reveal } from "./reveal";

const FAQS = [
  {
    q: "What is kvy?",
    a: "A CLI that runs coding agents like Claude Code and Codex on your own machine, plus a web dashboard that mirrors every session so you can approve, steer, and review from any browser.",
  },
  {
    q: "Does my code ever leave my machine?",
    a: "No. Agents run locally, exactly as if you'd started them yourself in a terminal. The dashboard only mirrors an encrypted copy of the session so you can follow along and respond remotely.",
  },
  {
    q: "What does 'end-to-end encrypted' mean here?",
    a: "Your devices generate the encryption keys, not our servers. Session content is encrypted before it leaves your machine, and our relay only ever stores and forwards ciphertext it can't read.",
  },
  {
    q: "How is this different from running the CLI directly, or a cloud coding agent?",
    a: "A bare CLI ties you to one terminal on one machine. A cloud agent runs your code on someone else's infrastructure. kvy keeps execution on your machine like the CLI does, and adds the remote visibility and control of a cloud tool without moving your code off it.",
  },
  {
    q: "Does it support agents besides Claude Code and Codex?",
    a: "Those two today, through the same session timeline, permission flow, and push notifications. Support for more coding agents is on the roadmap.",
  },
  {
    q: "Can I self-host it, and how much does it cost?",
    a: "It's free while in beta, hosted or self-hosted. Self-hosting runs the whole stack, server, database, and relay, from a single Docker container, and your keys never touch our infrastructure either way.",
  },
  {
    q: "What happens if I lose my laptop or close my browser mid-session?",
    a: "The agent keeps running on your machine no matter what your browser does. Reconnect from any signed-in device to pick the session back up.",
  },
] as const;

/** Answers the objections a first-time visitor actually has, in their own words. */
export function Faq() {
  return (
    <section id="faq" className="scroll-mt-24 border-border border-t px-4 py-24 sm:px-6">
      <div className="mx-auto grid w-full max-w-6xl gap-12 md:grid-cols-[2fr_3fr] md:gap-16">
        <Reveal>
          <p className="font-mono text-xs tracking-widest text-primary uppercase">FAQ</p>
          <h2 className="mt-3 font-display text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
            Questions, answered.
          </h2>
          <p className="mt-4 max-w-sm text-pretty text-muted-foreground leading-relaxed">
            The honest version of how kvy works, in plain language. Something missing? Reach out on
            GitHub.
          </p>
        </Reveal>

        <Reveal delay={0.08}>
          <Accordion type="single" collapsible>
            {FAQS.map((faq) => (
              <AccordionItem key={faq.q} value={faq.q}>
                <AccordionTrigger className="text-left font-medium">{faq.q}</AccordionTrigger>
                <AccordionContent className="text-pretty text-muted-foreground leading-relaxed">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  );
}
