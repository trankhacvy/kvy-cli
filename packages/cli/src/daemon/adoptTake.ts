/**
 * Daemon-side core for the `adopt.take` machine RPC: takeover vs fork of a
 * plain (unmanaged) `claude` session the transcript indexer has already surfaced.
 *
 * - `mode: 'takeover'` — enforces "never two live continuations of the same
 *   history". If a live, non-Kvy `claude` process still owns this transcript,
 *   SIGTERM it, wait up to `gracefulTimeoutMs` (default 5s), SIGKILL if it's
 *   still alive — then spawn a new managed session continuing from the same
 *   provider session id.
 * - `mode: 'fork'` — skips the kill entirely; the original process keeps running.
 *
 * Idempotency-key replay is the caller's responsibility — this function always
 * performs a real attempt when called and never caches results itself.
 *
 * When `mode: 'takeover'` finds and kills a live process, the result carries a
 * human-readable `warning` — there is no way to know from the transcript alone
 * whether that process's last turn had finished, so any live process is treated
 * as "possibly mid-turn" rather than guessing silently.
 */
import type { AdoptTakeParams, AdoptTakeResult, SpawnParams, SpawnResult } from "@kvy/wire";
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
  "the original session was still running and may have been mid-turn. That step was interrupted by takeover";

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

/** Fills in real OS-backed defaults for anything not overridden, reusing `kill.ts`'s/`liveness.ts`'s primitives. */
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

/** SIGTERM, wait out the grace period, SIGKILL fallback — same escalation as `kill.ts`'s `killGraceful` for a single already-identified pid. */
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
 * Throws if the provider session can't be resolved to a registered workspace,
 * or if the underlying spawn fails — both are real failures, not silently swallowed.
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

  // `spawnSession` can resolve to `{requiresApproval}` (no `sessionId`) when
  // the target directory doesn't exist yet — but an adopted provider session's
  // directory is by definition one Claude Code was already running in, so this
  // should never happen. Still, `AdoptTakeResultSchema` requires a `sessionId`,
  // so surface it as a real error rather than emitting a result that would fail
  // its own schema validation one layer up.
  if (!spawnResult.sessionId) {
    throw new Error(
      `adopt.take: spawn did not return a sessionId for provider session "${params.providerSessionId}" (requiresApproval: ${JSON.stringify(
        spawnResult.requiresApproval,
      )})`,
    );
  }

  return warning
    ? { sessionId: spawnResult.sessionId, warning }
    : { sessionId: spawnResult.sessionId };
}
