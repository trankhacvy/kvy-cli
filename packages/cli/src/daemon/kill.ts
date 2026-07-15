/**
 * `falcon kill daemon|sessions|all|all-force` (plan.md §7.2/§7.4).
 *
 * The escape hatch for a wedged daemon (falcon-system-design.md §11:
 * "Wedged provider process ... SIGKILL fallback; `falcon kill sessions`
 * escape hatch"): targets are discovered purely by scanning the OS process
 * list (`processScan.ts` + `markers.ts`), never by reading
 * `daemon.state.json` or calling `controlServer.ts`'s loopback API —
 * either could be exactly what's unreachable when this is needed.
 *
 * Non-force variants (`daemon`, `sessions`, `all`) send SIGTERM to every
 * target, wait up to `gracefulTimeoutMs` (default 5s — the same
 * SIGTERM-then-wait-then-SIGKILL grace period used elsewhere in the design,
 * e.g. `adopt.take`'s takeover, falcon-system-design.md §7.8), then SIGKILL
 * anything still alive. `all-force` SIGKILLs every target immediately, no
 * grace period.
 */

import type { Logger } from "../logger.js";
import { type ClassifiedProcess, classifyProcesses, type FalconProcessKind } from "./markers.js";
import { listProcesses, type ProcessEntry } from "./processScan.js";

export type KillSignal = "SIGTERM" | "SIGKILL";

export interface KillOutcome {
  pid: number;
  command: string;
  kind: FalconProcessKind;
  /** The last signal actually sent to this pid, or "none" if sending failed outright. */
  signal: KillSignal | "none";
  error?: string;
}

export interface KillSummary {
  /** Falcon processes matched before any signal was sent. */
  targeted: ClassifiedProcess[];
  outcomes: KillOutcome[];
}

export interface KillDeps {
  listProcesses: () => Promise<ProcessEntry[]>;
  killPid: (pid: number, signal: KillSignal) => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  currentPid: number;
  logger?: Logger;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_GRACEFUL_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 200;

function defaultKillPid(pid: number, signal: KillSignal): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    // ESRCH: no such process — it's already gone, which is the outcome we
    // wanted anyway. Anything else (e.g. EPERM) is a real failure.
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process — genuinely dead. EPERM (and anything else):
    // the signal was rejected/unclear, not confirmed as delivered to a dead
    // process — assume it's still alive rather than skipping the SIGKILL
    // escalation (e.g. a daemon spawned under a different user, where a
    // liveness probe can hit EPERM while the process is very much running).
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    return true;
  }
}

/** Builds the real, OS-backed dependency set, with any pieces overridden (used by tests). */
export function createKillDeps(overrides: Partial<KillDeps> = {}): KillDeps {
  return {
    listProcesses,
    killPid: defaultKillPid,
    isAlive: defaultIsAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    currentPid: process.pid,
    ...overrides,
  };
}

async function waitForExit(
  pids: number[],
  deps: KillDeps,
  timeoutMs: number,
): Promise<Set<number>> {
  let alive = new Set(pids.filter((pid) => deps.isAlive(pid)));
  const deadline = deps.now() + timeoutMs;
  while (alive.size > 0 && deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    alive = new Set([...alive].filter((pid) => deps.isAlive(pid)));
  }
  return alive;
}

function buildOutcome(
  target: ClassifiedProcess,
  signal: KillSignal | "none",
  error?: string,
): KillOutcome {
  return {
    pid: target.pid,
    command: target.command,
    kind: target.kind,
    signal,
    ...(error !== undefined ? { error } : {}),
  };
}

function recordOutcome(
  outcomes: KillOutcome[],
  target: ClassifiedProcess,
  signal: KillSignal | "none",
  error?: string,
): void {
  outcomes.push(buildOutcome(target, signal, error));
}

async function killForce(targets: ClassifiedProcess[], deps: KillDeps): Promise<KillOutcome[]> {
  const logger = deps.logger ?? noopLogger;
  const outcomes: KillOutcome[] = [];
  for (const target of targets) {
    try {
      deps.killPid(target.pid, "SIGKILL");
      recordOutcome(outcomes, target, "SIGKILL");
      logger.info("[KILL] SIGKILL sent", { pid: target.pid, kind: target.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordOutcome(outcomes, target, "none", message);
      logger.warn("[KILL] SIGKILL failed", { pid: target.pid, message });
    }
  }
  return outcomes;
}

async function killGraceful(
  targets: ClassifiedProcess[],
  deps: KillDeps,
  gracefulTimeoutMs: number,
): Promise<KillOutcome[]> {
  const logger = deps.logger ?? noopLogger;
  // Keyed by pid rather than pushed in completion order, so the final
  // return can be re-assembled index-aligned with `targets` regardless of
  // which pass (initial SIGTERM failure vs. post-wait resolution) produced
  // each outcome.
  const outcomeByPid = new Map<number, KillOutcome>();
  const terminated: ClassifiedProcess[] = [];

  for (const target of targets) {
    try {
      deps.killPid(target.pid, "SIGTERM");
      terminated.push(target);
      logger.info("[KILL] SIGTERM sent", { pid: target.pid, kind: target.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomeByPid.set(target.pid, buildOutcome(target, "none", message));
      logger.warn("[KILL] SIGTERM failed", { pid: target.pid, message });
    }
  }

  const stillAlive = await waitForExit(
    terminated.map((t) => t.pid),
    deps,
    gracefulTimeoutMs,
  );

  for (const target of terminated) {
    if (!stillAlive.has(target.pid)) {
      outcomeByPid.set(target.pid, buildOutcome(target, "SIGTERM"));
      continue;
    }
    try {
      deps.killPid(target.pid, "SIGKILL");
      outcomeByPid.set(target.pid, buildOutcome(target, "SIGKILL"));
      logger.warn("[KILL] ignored SIGTERM, sent SIGKILL", { pid: target.pid, kind: target.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomeByPid.set(target.pid, buildOutcome(target, "SIGTERM", message));
      logger.warn("[KILL] SIGKILL escalation failed", { pid: target.pid, message });
    }
  }

  return targets.map((target) => {
    const outcome = outcomeByPid.get(target.pid);
    if (!outcome) {
      throw new Error(`kill.ts: missing outcome for pid ${target.pid} — this is a bug`);
    }
    return outcome;
  });
}

async function findTargets(
  deps: KillDeps,
  kinds: FalconProcessKind[],
): Promise<ClassifiedProcess[]> {
  const processes = await deps.listProcesses();
  return classifyProcesses(processes, deps.currentPid).filter((p) => kinds.includes(p.kind));
}

export async function killDaemon(
  deps: KillDeps = createKillDeps(),
  gracefulTimeoutMs = DEFAULT_GRACEFUL_TIMEOUT_MS,
): Promise<KillSummary> {
  const targeted = await findTargets(deps, ["daemon"]);
  return { targeted, outcomes: await killGraceful(targeted, deps, gracefulTimeoutMs) };
}

export async function killSessions(
  deps: KillDeps = createKillDeps(),
  gracefulTimeoutMs = DEFAULT_GRACEFUL_TIMEOUT_MS,
): Promise<KillSummary> {
  const targeted = await findTargets(deps, ["session"]);
  return { targeted, outcomes: await killGraceful(targeted, deps, gracefulTimeoutMs) };
}

export async function killAll(
  deps: KillDeps = createKillDeps(),
  gracefulTimeoutMs = DEFAULT_GRACEFUL_TIMEOUT_MS,
): Promise<KillSummary> {
  const targeted = await findTargets(deps, ["daemon", "session"]);
  return { targeted, outcomes: await killGraceful(targeted, deps, gracefulTimeoutMs) };
}

export async function killAllForce(deps: KillDeps = createKillDeps()): Promise<KillSummary> {
  const targeted = await findTargets(deps, ["daemon", "session"]);
  return { targeted, outcomes: await killForce(targeted, deps) };
}

export type KillTarget = "daemon" | "sessions" | "all" | "all-force";

/** Renders a `KillSummary` as user-facing CLI text for `falcon kill <target>`. */
export function describeKillSummary(target: KillTarget, summary: KillSummary): string {
  if (summary.targeted.length === 0) {
    return `falcon kill ${target}: no matching processes found\n`;
  }
  const succeeded = summary.outcomes.filter((o) => o.error === undefined).length;
  const lines = summary.outcomes.map((o) => {
    const status = o.error !== undefined ? `FAILED (${o.error})` : o.signal;
    return `  pid ${o.pid} [${o.kind}] ${status} — ${o.command}`;
  });
  return `falcon kill ${target}: ${succeeded}/${summary.targeted.length} process(es) terminated\n${lines.join("\n")}\n`;
}
