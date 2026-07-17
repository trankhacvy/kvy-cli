/**
 * `falcon resume <session-id>` (falcon-prd.md §5.3, plan.md §16 "4.2
 * Adoption Tier 3 + polish"): reattach a terminal to an existing session,
 * local or daemon-managed.
 *
 *  - **local**: `<session-id>` matches a plain (unmanaged) Claude Code
 *    transcript in cwd's workspace (`adopt/listSessions.ts`'s
 *    `listAdoptableSessions` — the same lookup `falcon sessions list`/
 *    `falcon adopt --list` use). Resumed the same way `commands/adopt.ts`'s
 *    already-landed local path does: `claude --resume <id>` spawned with
 *    inherited stdio, blocking until it exits — this is Claude Code's own
 *    `--resume`/session-flag handling (`claude/claudeLocal.ts`'s module doc
 *    describes the same flag interception the full launcher performs; the
 *    direct spawn here mirrors `adopt.ts`'s precedent rather than routing
 *    through the still-unwired `falcon_claude_launcher.cjs` launcher, since
 *    general provider spawning — `index.ts`'s `runStart` — is separate,
 *    later work: "provider spawning not implemented yet").
 *  - **daemon-managed**: everything else. Calls `daemon/resumeSession.ts`'s
 *    `resumeSession()` directly — the exact function the `resumeSession`
 *    machine RPC wraps (`daemon/machineRpc.ts`) — against a `SessionRegistry`
 *    restored from this machine's own `sessions.json`
 *    (`sessionRegistry.ts`/`sessionsStore.ts`, the same durable store
 *    `falcon daemon start-sync` restores at boot). Guards against racing a
 *    *live* daemon's own copy of the same session first: if `falcon daemon
 *    start` is currently running and its control server already tracks
 *    `<session-id>` as live, this refuses rather than risking two processes
 *    sharing one session's DEK/seq (see `resumeSession.ts`'s own module doc
 *    for why that's unsafe) — an honest refusal, not a silent race.
 */
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import crossSpawnDefault from "cross-spawn";
import type { LivenessDeps } from "../adopt/liveness.js";
import { listAdoptableSessions } from "../adopt/listSessions.js";
import { isProcessAlive as isProcessAliveDefault } from "../daemon/lock.js";
import {
  type LaunchProcessDeps,
  launchProviderProcess as launchProviderProcessDefault,
  type SpawnFn,
} from "../daemon/processLauncher.js";
import {
  ResumeSessionError,
  type ResumeSessionDeps,
  resumeSession,
} from "../daemon/resumeSession.js";
import { createSessionRegistry } from "../daemon/sessionRegistry.js";
import { createSpawnAwaiter } from "../daemon/spawnAwaiter.js";
import { readDaemonState } from "../daemon/state.js";
import type { Logger } from "../logger.js";

export interface ResumeCommandDeps {
  homeDir: string;
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  liveness?: LivenessDeps;
  /** Injectable for tests; defaults to `cross-spawn`'s `spawn`, for the local resume path. */
  spawnImpl?: SpawnFn;
  /** Injectable for tests; defaults to `daemon/lock.ts`'s real, `kill(pid,0)`-backed implementation. */
  isProcessAlive?: (pid: number) => boolean;
  /** Injectable for tests; defaults to the global `fetch` — used to probe a live daemon's control server. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real tmux-preferred/detached launcher, for the daemon-managed path. */
  launchProcess?: typeof launchProviderProcessDefault;
  launchDeps?: LaunchProcessDeps;
  /** Returns the argv that re-invokes this same falcon binary (`[node, ...execArgv, entry]`). Injectable for tests. */
  falconEntrypoint?: () => string[];
  /** Test-only escape hatch: overrides merged into the `resumeSession()` deps (e.g. a fake registry/awaiter). */
  resumeSessionOverrides?: Partial<ResumeSessionDeps>;
  write?: (text: string) => void;
  logger?: Logger;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function defaultFalconEntrypoint(): string[] {
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  return [process.execPath, ...process.execArgv, entry];
}

async function runLocalResume(
  sessionId: string,
  deps: Required<Pick<ResumeCommandDeps, "workingDirectory" | "write">> & ResumeCommandDeps,
  logger: Logger,
): Promise<number> {
  const env = deps.env ?? process.env;
  const spawnImpl = deps.spawnImpl ?? (crossSpawnDefault as unknown as SpawnFn);

  deps.write(`falcon resume: reattaching to local session ${sessionId}\n`);
  return new Promise<number>((resolve) => {
    const child: ChildProcess = spawnImpl("claude", ["--resume", sessionId], {
      cwd: deps.workingDirectory,
      env,
      stdio: "inherit",
    });
    child.once("error", (error: Error) => {
      logger.error("[resume] failed to launch claude --resume", { message: error.message });
      deps.write(`falcon resume: failed to launch claude — ${error.message}\n`);
      resolve(1);
    });
    child.once("close", (code: number | null) => resolve(code ?? 0));
  });
}

interface LiveListEntry {
  sessionId: string;
  pid: number;
}

/**
 * Probes a currently-running daemon's control server for whether it already
 * tracks `sessionId` live. `false` if no daemon is running, or the probe
 * fails — an unreachable/absent daemon means "we don't know", not "this
 * session is live"; the caller falls through to the durable-store path
 * either way.
 */
async function isLiveOnRunningDaemon(
  sessionId: string,
  homeDir: string,
  isAlive: (pid: number) => boolean,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const state = await readDaemonState(homeDir);
  if (!state || !isAlive(state.pid)) return false;

  try {
    const res = await fetchImpl(`http://127.0.0.1:${state.port}/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { sessions?: LiveListEntry[] };
    return (body.sessions ?? []).some((s) => s.sessionId === sessionId);
  } catch {
    return false;
  }
}

async function runDaemonManagedResume(
  sessionId: string,
  deps: Required<Pick<ResumeCommandDeps, "homeDir" | "workingDirectory" | "write">> &
    ResumeCommandDeps,
  logger: Logger,
): Promise<number> {
  const isAlive = deps.isProcessAlive ?? isProcessAliveDefault;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const liveElsewhere = await isLiveOnRunningDaemon(sessionId, deps.homeDir, isAlive, fetchImpl);
  if (liveElsewhere) {
    deps.write(
      `falcon resume: session ${sessionId} is currently live-managed by the running daemon — attaching to an already-live daemon session isn't supported yet (see \`falcon daemon status\`/\`falcon kill sessions\`)\n`,
    );
    return 1;
  }

  const registry = createSessionRegistry({ homeDir: deps.homeDir, logger });
  await registry.restore();

  const resumeDeps: ResumeSessionDeps = {
    registry,
    awaiter: createSpawnAwaiter(),
    resolveDirectory: () => deps.workingDirectory,
    launchProcess: deps.launchProcess,
    launchDeps: deps.launchDeps,
    falconEntrypoint: deps.falconEntrypoint ?? defaultFalconEntrypoint,
    logger,
    ...deps.resumeSessionOverrides,
  };

  try {
    const result = await resumeSession(sessionId, resumeDeps);
    deps.write(`falcon resume: resumed session ${result.sessionId}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof ResumeSessionError ? error.message : String(error);
    logger.error("[resume] daemon-managed resume failed", { sessionId, message });
    deps.write(`falcon resume: ${message}\n`);
    return 1;
  }
}

/** Runs `falcon resume <session-id>`. Returns the process exit code. */
export async function runResumeCommand(
  sessionId: string,
  deps: ResumeCommandDeps,
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const logger = deps.logger ?? noopLogger;
  const env = deps.env ?? process.env;

  const local = await listAdoptableSessions({
    workingDirectory: deps.workingDirectory,
    env,
    liveness: deps.liveness,
  });
  const isLocal = local.some((s) => s.providerSessionId === sessionId);

  const fullDeps = { ...deps, write };
  return isLocal
    ? runLocalResume(sessionId, fullDeps, logger)
    : runDaemonManagedResume(sessionId, fullDeps, logger);
}
