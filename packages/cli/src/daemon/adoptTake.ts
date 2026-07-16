/**
 * Daemon-side core for the `adopt.take` machine RPC (design §7.8/§8/§10.4,
 * plan.md §16 "3.3 Session adoption (UC9)"): takeover vs fork of a plain
 * (unmanaged) `claude` session the transcript indexer has already surfaced.
 *
 * - `mode: 'takeover'` — the divergence guard (design FR-9.4: "never two
 *   live continuations of the same history"). If a live, non-Falcon
 *   `claude` process still owns this transcript, SIGTERM it, wait up to
 *   `gracefulTimeoutMs` (default 5s), SIGKILL if it's still alive — then
 *   spawn a new managed session continuing from the same provider session
 *   id.
 * - `mode: 'fork'` — skips the kill entirely (the original process, if
 *   any, keeps running untouched) but still spawns the new continuation.
 *
 * Idempotency-key replay is the caller's responsibility (`machineRpc.ts`,
 * same convention as `spawn`) — this function always performs a real
 * attempt when called; it never caches results itself.
 *
 * Mid-turn warning (design §10.4 / FR-9.3: "if the process is mid-turn,
 * show a warning"): when `mode: 'takeover'` actually found (and killed) a
 * live process, the result carries a human-readable `warning` — there is
 * no way to know from the transcript alone whether that process's *last*
 * turn had finished, so any live process is treated as "possibly mid-turn"
 * and the client is told plainly rather than guessing silently.
 */
import type { AdoptTakeParams, AdoptTakeResult, SpawnParams, SpawnResult } from "@falcon/wire";
import {
  createLivenessDeps,
  findOwningClaudeProcess,
  type LivenessDeps,
} from "../adopt/liveness.js";
import { getProjectPath } from "../claude/scanner.js";
import type { Logger } from "../logger.js";
import { createKillDeps, type KillSignal } from "./kill.js";
import type { ProviderSessionResolver } from "./providerSessionResolver.js";

const DEFAULT_GRACEFUL_TIMEOUT_MS = 5000;
const MID_TURN_WARNING =
  "the original session was still running and may have been mid-turn — that step was interrupted by takeover";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface AdoptTakeDeps {
  resolveProviderSession: ProviderSessionResolver;
  spawnSession: (params: SpawnParams) => Promise<SpawnResult>;
  liveness?: LivenessDeps;
  killPid?: (pid: number, signal: KillSignal) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  gracefulTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/** Fills in real OS-backed defaults (reusing `kill.ts`'s primitives) for anything not overridden — same shape as `createKillDeps`/`createLivenessDeps`. */
export function createAdoptTakeDeps(
  required: Pick<AdoptTakeDeps, "resolveProviderSession" | "spawnSession">,
  overrides: Partial<AdoptTakeDeps> = {},
): AdoptTakeDeps {
  const killDeps = createKillDeps();
  return {
    liveness: createLivenessDeps(),
    killPid: killDeps.killPid,
    isAlive: killDeps.isAlive,
    sleep: killDeps.sleep,
    now: killDeps.now,
    gracefulTimeoutMs: DEFAULT_GRACEFUL_TIMEOUT_MS,
    ...required,
    ...overrides,
  };
}

async function waitForExit(
  pid: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (isAlive(pid) && now() < deadline) {
    await sleep(200);
  }
  return isAlive(pid);
}

/** SIGTERM, wait out the grace period, SIGKILL fallback — mirrors `kill.ts`'s `killGraceful` escalation policy for a single, already-identified pid. */
async function killGracefully(
  pid: number,
  deps: Required<
    Pick<AdoptTakeDeps, "killPid" | "isAlive" | "sleep" | "now" | "gracefulTimeoutMs">
  >,
  logger: Logger,
): Promise<void> {
  deps.killPid(pid, "SIGTERM");
  logger.info("[adopt-take] SIGTERM sent to owning process", { pid });

  const stillAlive = await waitForExit(
    pid,
    deps.isAlive,
    deps.sleep,
    deps.now,
    deps.gracefulTimeoutMs,
  );
  if (!stillAlive) return;

  deps.killPid(pid, "SIGKILL");
  logger.warn("[adopt-take] owning process ignored SIGTERM, sent SIGKILL", { pid });
}

/**
 * Runs one `adopt.take` attempt: optionally kills the owning process
 * (`mode: 'takeover'` only), then spawns a new managed session continuing
 * from `params.providerSessionId`. Throws (any `Error`) if the provider
 * session can't be resolved to a registered workspace, or if the
 * underlying spawn fails — both are real failures, not silently-swallowed
 * side channels.
 */
export async function handleAdoptTake(
  params: AdoptTakeParams,
  deps: AdoptTakeDeps,
): Promise<AdoptTakeResult> {
  const logger = deps.logger ?? noopLogger;
  const liveness = deps.liveness ?? createLivenessDeps();
  const defaultKillDeps = createKillDeps();
  const killPid = deps.killPid ?? defaultKillDeps.killPid;
  const isAlive = deps.isAlive ?? defaultKillDeps.isAlive;
  const sleep = deps.sleep ?? defaultKillDeps.sleep;
  const now = deps.now ?? defaultKillDeps.now;
  const gracefulTimeoutMs = deps.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;

  const resolved = await deps.resolveProviderSession(params.providerSessionId);
  if (!resolved) {
    throw new Error(
      `adopt.take: could not resolve provider session "${params.providerSessionId}" to a registered workspace`,
    );
  }

  let warning: string | undefined;

  if (params.mode === "takeover") {
    const projectDir = getProjectPath(resolved.directory, deps.env ?? process.env);
    const owning = await findOwningClaudeProcess(resolved.directory, projectDir, liveness);
    if (owning && owning.providerSessionId === params.providerSessionId) {
      warning = MID_TURN_WARNING;
      await killGracefully(owning.pid, { killPid, isAlive, sleep, now, gracefulTimeoutMs }, logger);
    }
  }

  const spawnResult = await deps.spawnSession({
    idempotencyKey: params.idempotencyKey,
    workspaceId: resolved.workspaceId,
    directory: resolved.directory,
    provider: "claude-code",
    permissionMode: "default",
    continueFrom: { providerSessionId: params.providerSessionId },
  });

  return warning
    ? { sessionId: spawnResult.sessionId, warning }
    : { sessionId: spawnResult.sessionId };
}
