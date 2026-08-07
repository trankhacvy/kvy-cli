"use client";

import { ArrowUp, ShieldCheck, Wifi } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * The hero's product moment: a living split-screen that shows kvy's whole
 * point — type in the CLI on the left, watch the session mirror onto the
 * phone on the right. A looping four-beat script drives both halves from a
 * single `step`, so terminal and mobile can never drift out of sync.
 *
 * The flow is the real one: launch `kvy claude`, drop a prompt at the `>`
 * cursor, then see the agent run tests and ask for a permission — mirrored
 * on the phone the whole way. The sync badge is an absolutely-positioned
 * overlay pinned to the terminal's edge, so resizing either half never
 * shifts the layout.
 *
 * Decorative: hidden from assistive tech, its buttons are unfocusable, and
 * it collapses to a static end-state when the user prefers reduced motion.
 */

const COMMAND = "kvy claude";
const PROMPT = "add dark-mode to settings";
const STARTUP = "• claude started · session 8f3a · MacBook Pro";

/** How long each beat of the script holds before advancing. */
const BEATS = [3400, 2200, 1800, 3000];

const SCRIPT = [
  {
    cli: [],
    phone: "start" as const,
    syncLabel: "Session started",
  },
  {
    cli: [{ kind: "cmd", text: "pnpm test" }],
    phone: "msg" as const,
    msg: "Updated 3 files. Running the test suite now.",
    syncLabel: "Mirrored live",
  },
  {
    cli: [{ kind: "out", text: "✓ 24 passed · 3 files touched" }],
    phone: "msg" as const,
    msg: "All 24 tests pass. Ready for review.",
    syncLabel: "Tests passed",
  },
  {
    cli: [{ kind: "perm", text: "Bash: pnpm install && pnpm build" }],
    phone: "perm" as const,
    syncLabel: "Needs you",
  },
] as const;

/** Clamped accessor so a numeric step can't under/overflow the script. */
function scriptAt(step: number) {
  return SCRIPT[step % SCRIPT.length] ?? SCRIPT[0];
}

/** Types the launch command, then the `>` prompt, character-by-character. */
function useTypedPair(step: number) {
  const reduce = useReducedMotion();
  const [cmd, setCmd] = useState(reduce ? COMMAND : "");
  const [prompt, setPrompt] = useState(reduce ? PROMPT : "");

  useEffect(() => {
    if (reduce || step !== 0) {
      setCmd(COMMAND);
      setPrompt(PROMPT);
      return;
    }
    setCmd("");
    setPrompt("");
    let cmdTimer: number | undefined;
    let promptTimer: number | undefined;
    let promptInterval: number | undefined;
    let i = 0;
    cmdTimer = window.setInterval(() => {
      i += 1;
      setCmd(COMMAND.slice(0, i));
      if (i >= COMMAND.length) {
        window.clearInterval(cmdTimer);
        promptTimer = window.setTimeout(() => {
          let j = 0;
          promptInterval = window.setInterval(() => {
            j += 1;
            setPrompt(PROMPT.slice(0, j));
            if (j >= PROMPT.length) window.clearInterval(promptInterval);
          }, 42);
        }, 280);
      }
    }, 64);
    return () => {
      window.clearInterval(cmdTimer);
      if (promptTimer !== undefined) window.clearTimeout(promptTimer);
      if (promptInterval !== undefined) window.clearInterval(promptInterval);
    };
  }, [step, reduce]);

  return { cmd, prompt };
}

/** The CLI half — a real-looking terminal with a blinking caret. */
function Cli({ step }: { step: number }) {
  const { cmd, prompt } = useTypedPair(step);
  const lines = scriptAt(step).cli;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-[#0b0d0c] text-left shadow-2xl shadow-primary/10">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3.5 py-2">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
        </div>
        <span className="ml-2 font-mono text-[11px] text-white/40">kvy — claude · MacBook Pro</span>
      </div>

      <div className="space-y-2.5 px-4 py-4 font-mono text-xs leading-relaxed sm:text-[13px]">
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="text-white/85"
        >
          <span className="text-primary">$</span> {cmd}
          {step === 0 && cmd !== COMMAND && (
            <span className="ml-0.5 inline-block h-3.5 w-[7px] translate-y-0.5 animate-pulse bg-primary/80" />
          )}
        </motion.p>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          className="text-white/50"
        >
          {STARTUP}
        </motion.p>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: cmd === COMMAND ? 1 : 0 }}
          transition={{ duration: 0.25 }}
          className="text-white/85"
        >
          <span className="text-primary">&gt;</span> {prompt}
          {step === 0 && cmd === COMMAND && prompt !== PROMPT && (
            <span className="ml-0.5 inline-block h-3.5 w-[7px] translate-y-0.5 animate-pulse bg-primary/80" />
          )}
        </motion.p>

        {lines.map((line) =>
          line.kind === "cmd" ? (
            <motion.p
              key={`cmd-${line.text}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.1 }}
              className="text-white/85"
            >
              <span className="text-primary">$</span> {line.text}
            </motion.p>
          ) : line.kind === "perm" ? (
            <motion.div
              key={`perm-${line.text}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
              className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5"
            >
              <p className="flex items-center gap-1.5 font-medium text-white/90">
                <ShieldCheck className="size-3.5 text-primary" />
                Permission requested
              </p>
              <p className="mt-1 text-white/50">{line.text}</p>
              <div className="mt-2 flex gap-1.5">
                <span className="rounded-md bg-primary px-2.5 py-1 font-sans text-[11px] font-medium text-primary-foreground">
                  Allow
                </span>
                <span className="rounded-md border border-white/15 px-2.5 py-1 font-sans text-[11px] font-medium text-white/70">
                  Deny
                </span>
              </div>
            </motion.div>
          ) : (
            <motion.p
              key={`out-${line.text}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.1 }}
              className="text-white/50"
            >
              {line.text}
            </motion.p>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The phone half — the app mirroring the same session, beat-for-beat. The case
 * keeps a real phone's proportions (≈19.5:9), so the screen is tall enough to
 * hold header, live mirror, and input bar like an actual chat app.
 */
function Phone({ step }: { step: number }) {
  const beat = scriptAt(step);

  return (
    <div className="relative w-full">
      <div className="aspect-[9/19.5] rounded-[2.5rem] border border-border bg-background p-2 shadow-2xl shadow-primary/10">
        <div className="relative flex h-full flex-col overflow-hidden rounded-[1.9rem] border border-border bg-card">
          {/* Dynamic island */}
          <div className="absolute top-3 left-1/2 z-10 h-6 w-24 -translate-x-1/2 rounded-full bg-black" />
          <span className="absolute top-3.5 right-5 font-mono text-[10px] text-muted-foreground">
            9:41
          </span>

          <div className="flex flex-1 flex-col px-4 pt-12 pb-4">
            {/* App header */}
            <div className="flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-md bg-primary/20 font-mono text-[11px] font-semibold text-primary">
                k
              </span>
              <span className="font-mono text-[13px] font-medium">kvy</span>
              <Badge variant="outline" className="ml-auto gap-1 px-2 text-[10px]">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                Live
              </Badge>
            </div>

            {/* Session row */}
            <div className="mt-3 rounded-xl border border-border bg-muted/40 px-3.5 py-2.5">
              <p className="truncate font-mono text-xs text-muted-foreground">
                claude · MacBook Pro
              </p>
              <p className="mt-0.5 truncate text-[13px] text-foreground">{PROMPT}</p>
            </div>

            {/* Mirrored content, driven by the same step */}
            <div className="mt-3 flex flex-1 flex-col justify-center">
              <motion.div
                key={step}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              >
                {beat.phone === "start" && (
                  <div className="rounded-xl border border-border bg-background px-3.5 py-2.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                      Session started
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">You: {PROMPT}</p>
                  </div>
                )}
                {beat.phone === "msg" && (
                  <div className="space-y-2">
                    <div className="rounded-xl border border-border bg-background px-3.5 py-2.5">
                      <p className="text-xs font-medium">Claude</p>
                      <p className="mt-1 text-[13px] text-muted-foreground">{beat.msg}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
                      <span className="text-primary">$</span> pnpm test
                    </div>
                  </div>
                )}
                {beat.phone === "perm" && (
                  <div className="rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <ShieldCheck className="size-3.5 text-primary" />
                      Permission requested
                    </p>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      Bash: pnpm install && pnpm build
                    </p>
                    <div className="mt-2.5 flex gap-2">
                      <Button size="sm" tabIndex={-1} className="flex-1">
                        Allow
                      </Button>
                      <Button size="sm" variant="outline" tabIndex={-1} className="flex-1">
                        Deny
                      </Button>
                    </div>
                  </div>
                )}
              </motion.div>
            </div>

            {/* Input bar */}
            <div className="mt-3 flex items-center gap-2 rounded-full border border-border bg-muted/40 py-2 pr-2 pl-4">
              <span className="truncate text-[11px] text-muted-foreground">Message Claude…</span>
              <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <ArrowUp className="size-3" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Loops the four-beat script: each step schedules the next via BEATS. */
function useStepLoop(stepCount: number) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(reduce ? stepCount - 1 : 0);

  useEffect(() => {
    if (reduce) return;
    const t = window.setTimeout(() => setStep((prev) => (prev + 1) % stepCount), BEATS[step]);
    return () => window.clearTimeout(t);
  }, [step, stepCount, reduce]);

  return step;
}

export function HeroPreview() {
  const reduce = useReducedMotion();
  const step = useStepLoop(SCRIPT.length);

  return (
    <div aria-hidden="true" className="mx-auto w-full max-w-5xl">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-20">
        <div className="relative z-10 w-full min-w-0 sm:flex-1">
          <Cli step={step} />

          {/* Sync badge: an absolute overlay pinned to the terminal's edge, so
              it never participates in layout and can't shift either half. It
              floats in the wide gap between the halves — hidden on mobile,
              where the phone stacks below the terminal. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 z-10 hidden -translate-y-1/2 translate-x-1/2 flex-col items-center gap-1 sm:flex sm:right-[-2.5rem]"
          >
            <motion.div
              animate={reduce ? undefined : { opacity: [0.35, 1, 0.35] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            >
              <Wifi className="size-4 text-primary sm:-scale-x-100" />
            </motion.div>
            <span className="font-mono text-[9px] whitespace-nowrap text-muted-foreground">
              {scriptAt(step).syncLabel}
            </span>
          </div>
        </div>

        <div className="w-full max-w-[350px] shrink-0 sm:w-[315px]">
          <Phone step={step} />
        </div>
      </div>
    </div>
  );
}
