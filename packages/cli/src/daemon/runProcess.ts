/**
 * The Setup/Run scripts subsystem's daemon-side run process
 * (docs/features/setup-run-scripts.md Phase 3): `run.start`/`run.stop`/
 * `run.status`/`run.setup` machine RPC handlers backing a long-lived,
 * remotely start/stop-able process — e.g. `npm run dev` — distinct from a
 * provider session (`sessionRegistry.ts` is provider-session-only).
 *
 * **`resolveRunContext` is both the auth gate and the config-key
 * resolver** (design §12 "no arbitrary-directory execution from remote",
 * mirroring `gitWriteGuard.ts`'s `createRegistryWorktreeAuthorizer`): every
 * handler below calls it first. A worktree outside every registered
 * workspace throws a typed `RunProcessError` before touching anything else.
 * `workspaceRoot` (the registered root the worktree resolves *inside*) is
 * the key `workspaceConfig.ts`'s `setupScript`/`runScript` are stored
 * under — a `.worktrees/<branch>` directory is never itself a config key —
 * while `directoryKey` (the worktree's own real path) is what
 * `runStateStore.ts` keys the actual run/setup state on, so two worktrees
 * under the same repo each get their own independent run process.
 *
 * **Launch reuses `processLauncher.ts` unchanged** (tmux-preferred, detached
 * fallback) — the only new piece is wrapping the run script's stdout/stderr
 * into a single log file via shell redirection (`<script> >> <logFile>
 * 2>&1`, built through `shellCommand.ts`'s `buildShellInvocation`) BEFORE
 * launch, since `launchProviderProcess` doesn't expose a stdout pipe for the
 * tmux path (a real pty, not a Node child process stream) the way
 * `setupScript.ts`'s plain `cross-spawn` child does. Documented tradeoff:
 * the tmux pane itself shows no output — the log file is the single source
 * both `run.status`'s `logTail` and a `tmux attach`'d `tail -f` read.
 *
 * **Liveness is probed lazily, on demand** — no daemon-boot re-adoption
 * task exists (or is needed) for this subsystem: `tmux has-session -t
 * <name>` for the tmux method, `process.kill(pid, 0)` for the detached
 * method (same PID-recycling caveat `runStateStore.ts`'s `RunEntry` doc
 * comment already flags).
 */
import { execFile } from "node:child_process";
import type {
  RunSetupParams,
  RunSetupResult,
  RunStartParams,
  RunStartResult,
  RunStatusParams,
  RunStatusResult,
  RunStopParams,
  RunStopResult,
} from "@falcon/wire";
import { resolveHomeDir } from "../home.js";
import type { Logger } from "../logger.js";
import { isWithinRegisteredWorkspace, type RegistryOptions } from "../workspace/registry.js";
import { readWorkspaceGitConfig, resolveWorkspaceKey } from "../workspaceConfig.js";
import {
  type LaunchProcessDeps,
  launchProviderProcess as launchProviderProcessDefault,
} from "./processLauncher.js";
import { createFreshLogFile, directoryHash, readLogTail, runLogFilePath } from "./runLogPaths.js";
import {
  clearRunEntry,
  type RunEntry,
  readDirectoryRunState,
  updateDirectoryRunState,
} from "./runStateStore.js";
import { runSetupScript, type SpawnFn as SetupSpawnFn } from "./setupScript.js";
import { buildShellInvocation } from "./shellCommand.js";

export class RunProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunProcessError";
  }
}

export interface RunContext {
  /** The worktree's own real (symlink-resolved) path — `runStateStore.ts`'s key for this directory's run/setup state. */
  directoryKey: string;
  /** The registered workspace root the worktree resolves inside — `workspaceConfig.ts`'s key for `setupScript`/`runScript`. */
  workspaceRoot: string;
}

/** Resolves + authorizes `worktree` — throws `RunProcessError` when it isn't inside any registered workspace (design §12). */
export async function resolveRunContext(
  worktree: string,
  options: RegistryOptions = {},
): Promise<RunContext> {
  const entry = await isWithinRegisteredWorkspace(worktree, options);
  if (entry === null) {
    throw new RunProcessError(`worktree is not inside a registered workspace: ${worktree}`);
  }
  const directoryKey = await resolveWorkspaceKey(worktree);
  return { directoryKey, workspaceRoot: entry.path };
}

export interface RunProcessDeps {
  /** Defaults to the real `resolveHomeDir(process.env)` (`~/.falcon` or `FALCON_HOME_DIR`) — same fallback as every other homeDir-scoped module in this package. */
  homeDir?: string;
  logger?: Logger;
  /** Forwarded to `resolveRunContext`'s registry lookup; defaults to `{homeDir}`. */
  registryOptions?: RegistryOptions;
  /** Injectable for tests; defaults to the real `launchProviderProcess` (tmux-preferred). */
  launchProcess?: typeof launchProviderProcessDefault;
  launchDeps?: LaunchProcessDeps;
  /** Injectable for tests; defaults to a real `tmux has-session -t <name>` probe. */
  probeTmuxSession?: (sessionName: string) => Promise<boolean>;
  /** Injectable for tests; defaults to a real `process.kill(pid, 0)` probe. */
  isAlive?: (pid: number) => boolean;
  /** Injectable for tests; defaults to a real SIGTERM(≤5s)→SIGKILL escalation plus a best-effort `tmux kill-session`. */
  killRunEntry?: (entry: RunEntry) => Promise<void>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable for tests; forwarded to `setupScript.ts`'s `runSetupScript` for `run.setup` — defaults to `cross-spawn`. */
  setupSpawnImpl?: SetupSpawnFn;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const GRACEFUL_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    return true;
  }
}

function defaultProbeTmuxSession(sessionName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tmux", ["has-session", "-t", sessionName], (error) => resolve(!error));
  });
}

async function isRunEntryLive(entry: RunEntry, deps: RunProcessDeps): Promise<boolean> {
  if (entry.method === "tmux") {
    if (!entry.tmuxSessionName) return false;
    const probe = deps.probeTmuxSession ?? defaultProbeTmuxSession;
    return probe(entry.tmuxSessionName);
  }
  const isAlive = deps.isAlive ?? defaultIsAlive;
  return isAlive(entry.pid);
}

/** SIGTERM, wait up to 5s, then SIGKILL if still alive — mirrors `kill.ts`'s escalation policy (falcon-system-design.md §11) at the scale of a single run entry, plus a best-effort `tmux kill-session` for the tmux method. */
async function defaultKillRunEntry(entry: RunEntry, deps: RunProcessDeps): Promise<void> {
  const isAlive = deps.isAlive ?? defaultIsAlive;

  try {
    process.kill(entry.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
  }

  const deadline = Date.now() + GRACEFUL_TIMEOUT_MS;
  while (isAlive(entry.pid) && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
  }

  if (isAlive(entry.pid)) {
    try {
      process.kill(entry.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
    }
  }

  if (entry.method === "tmux" && entry.tmuxSessionName) {
    const sessionName = entry.tmuxSessionName;
    await new Promise<void>((resolve) => {
      execFile("tmux", ["kill-session", "-t", sessionName], () => resolve());
    });
  }
}

/** Wraps `script` so the shell it runs under redirects both stdout and stderr into `logFile`, appending (the file was already freshly truncated by `createFreshLogFile` before launch). */
function wrapWithLogRedirect(script: string, logFile: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `${script} >> "${logFile}" 2>&1`;
  }
  return `${script} >> '${logFile}' 2>&1`;
}

/** `run.start` machine RPC handler. Throws `RunProcessError` when the worktree is unauthorized or no `runScript` is configured. */
export async function handleRunStart(
  params: RunStartParams,
  deps: RunProcessDeps = {},
): Promise<RunStartResult> {
  const logger = deps.logger ?? noopLogger;
  const homeDir = deps.homeDir ?? resolveHomeDir(process.env);
  const context = await resolveRunContext(params.worktree, deps.registryOptions ?? { homeDir });

  const config = await readWorkspaceGitConfig(context.workspaceRoot, { homeDir });
  const script = config?.runScript;
  if (!script) {
    throw new RunProcessError(
      `no run script configured for this workspace: ${context.workspaceRoot}`,
    );
  }

  const existing = await readDirectoryRunState(homeDir, context.directoryKey);
  if (existing?.run && (await isRunEntryLive(existing.run, deps))) {
    logger.info("[run-process] run already active for this directory", {
      worktree: params.worktree,
    });
    return {
      started: false,
      alreadyRunning: true,
      method: existing.run.method,
      pid: existing.run.pid,
      tmuxSessionName: existing.run.tmuxSessionName,
    };
  }

  const now = deps.now ?? Date.now;
  const startedAt = now();
  const logFile = runLogFilePath(homeDir, context.directoryKey);
  await createFreshLogFile(logFile);

  const platform = deps.platform ?? process.platform;
  const invocation = buildShellInvocation(wrapWithLogRedirect(script, logFile, platform), platform);
  const launch = deps.launchProcess ?? launchProviderProcessDefault;

  const launched = await launch(
    {
      sessionLabel: `run-${directoryHash(context.directoryKey)}`,
      command: invocation.command,
      args: invocation.args,
      cwd: context.directoryKey,
      env: deps.env ?? process.env,
    },
    deps.launchDeps,
  );

  const tmuxSessionName = launched.method === "tmux" ? launched.tmuxSessionName : undefined;

  await updateDirectoryRunState(homeDir, context.directoryKey, {
    run: {
      pid: launched.pid,
      method: launched.method,
      tmuxSessionName,
      startedAt,
      logFile,
      script,
    },
  });

  logger.info("[run-process] launched run process", {
    worktree: params.worktree,
    method: launched.method,
    pid: launched.pid,
  });

  return { started: true, method: launched.method, pid: launched.pid, tmuxSessionName };
}

/** `run.stop` machine RPC handler. Throws `RunProcessError` when the worktree is unauthorized. */
export async function handleRunStop(
  params: RunStopParams,
  deps: RunProcessDeps = {},
): Promise<RunStopResult> {
  const logger = deps.logger ?? noopLogger;
  const homeDir = deps.homeDir ?? resolveHomeDir(process.env);
  const context = await resolveRunContext(params.worktree, deps.registryOptions ?? { homeDir });

  const state = await readDirectoryRunState(homeDir, context.directoryKey);
  const entry = state?.run;
  if (!entry) {
    return { stopped: false, wasRunning: false };
  }

  const live = await isRunEntryLive(entry, deps);
  if (!live) {
    // Stale persisted entry (the process died without `run.stop` ever being
    // called) — clean it up, but there was nothing to actually stop.
    await clearRunEntry(homeDir, context.directoryKey);
    return { stopped: false, wasRunning: false };
  }

  const kill = deps.killRunEntry ?? ((e: RunEntry) => defaultKillRunEntry(e, deps));
  await kill(entry);
  await clearRunEntry(homeDir, context.directoryKey);

  logger.info("[run-process] stopped run process", { worktree: params.worktree, pid: entry.pid });
  return { stopped: true, wasRunning: true };
}

/** `run.status` machine RPC handler — read-only. Throws `RunProcessError` when the worktree is unauthorized. */
export async function handleRunStatus(
  params: RunStatusParams,
  deps: RunProcessDeps = {},
): Promise<RunStatusResult> {
  const homeDir = deps.homeDir ?? resolveHomeDir(process.env);
  const context = await resolveRunContext(params.worktree, deps.registryOptions ?? { homeDir });
  const state = await readDirectoryRunState(homeDir, context.directoryKey);

  let run: RunStatusResult["run"];
  if (state?.run) {
    const live = await isRunEntryLive(state.run, deps);
    const logTail = await readLogTail(state.run.logFile);
    run = live
      ? {
          state: "running",
          pid: state.run.pid,
          method: state.run.method,
          startedAt: state.run.startedAt,
          logTail,
        }
      : { state: "stopped", logTail };
  } else {
    run = { state: "none" };
  }

  let setup: RunStatusResult["setup"];
  if (state?.setup) {
    setup = {
      state: state.setup.state,
      exitCode: state.setup.exitCode,
      startedAt: state.setup.startedAt,
      finishedAt: state.setup.finishedAt,
      logTail: await readLogTail(state.setup.logFile),
    };
  } else {
    setup = { state: "not-run" };
  }

  return { run, setup };
}

/** `run.setup` machine RPC handler ("Re-run setup" from the web panel) — delegates to `setupScript.ts`'s async, fire-and-forget runner. Throws `RunProcessError` when the worktree is unauthorized. */
export async function handleRunSetup(
  params: RunSetupParams,
  deps: RunProcessDeps = {},
): Promise<RunSetupResult> {
  const homeDir = deps.homeDir ?? resolveHomeDir(process.env);
  const context = await resolveRunContext(params.worktree, deps.registryOptions ?? { homeDir });
  return runSetupScript(
    { workspaceRoot: context.workspaceRoot, directory: context.directoryKey },
    { homeDir, logger: deps.logger, spawnImpl: deps.setupSpawnImpl },
  );
}
