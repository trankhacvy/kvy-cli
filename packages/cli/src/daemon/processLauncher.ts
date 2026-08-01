/**
 * tmux-preferred process launcher for the daemon `spawn` RPC (design §7.3:
 * "prefer tmux (`tmux new-session -d -s kvy-<sid>`) so users can attach a
 * real terminal, detached fallback otherwise"; plan.md §16 "3.1 Remote
 * spawn"). Same `cross-spawn` convention already used by
 * `claude/claudeLocal.ts` (Windows `.cmd` shim correctness).
 *
 * tmux wins when available because it gives the user a real terminal to
 * `tmux attach -t kvy-<label>` into later — the detached fallback runs
 * headless with no way to attach a TTY after the fact, which is strictly
 * worse UX but still correct (the session is fully controllable remotely
 * either way).
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import crossSpawnDefault from "cross-spawn";
import type { Logger } from "../logger.js";
import { isProcessAlive } from "./lock.js";
import type { ProcessExitInfo, ProcessExitWatcher } from "./types.js";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface LaunchProcessOptions {
  /** Used to build the tmux session name (`kvy-<sessionLabel>`) — caller's job to keep it tmux-session-name-safe (e.g. a cuid2 idempotency key). */
  sessionLabel: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LaunchProcessDeps {
  /** Injectable for tests; defaults to `cross-spawn`'s `spawn`. */
  spawnImpl?: SpawnFn;
  logger?: Logger;
  /**
   * Injectable for tests; defaults to `lock.ts`'s real `isProcessAlive`
   * (a `process.kill(pid, 0)` liveness probe). Backs the tmux-mode exit
   * watcher (A3/A4) — the daemon holds no direct child handle for a tmux
   * pane process, so liveness has to be polled rather than observed via a
   * Node `"exit"` event.
   */
  isProcessAlive?: (pid: number) => boolean;
  /** Injectable for tests; how often the tmux-mode watcher polls. Defaults to 1000ms. */
  tmuxExitPollIntervalMs?: number;
}

export type LaunchedProcess =
  | { method: "tmux"; pid: number; tmuxSessionName: string; watchExit: ProcessExitWatcher }
  | { method: "detached"; pid: number; watchExit: ProcessExitWatcher };

const TMUX_STARTUP_TIMEOUT_MS = 5_000;
/** How long a detached spawn waits for an immediate async `error` event (e.g. ENOENT) before declaring success. */
const DETACHED_SPAWN_GRACE_MS = 200;
/** Default tmux-mode pane-pid liveness poll interval (A3/A4) — see `LaunchProcessDeps.tmuxExitPollIntervalMs`. */
const DEFAULT_TMUX_EXIT_POLL_INTERVAL_MS = 1000;

/**
 * A one-shot exit broadcaster (A3/A4): `fire()` is idempotent (only the
 * first call has any effect) and `watch()` always calls its subscriber
 * eventually, even if `fire()` already ran before `watch()` was called —
 * `spawnAwaiter.ts`'s `waitFor` subscribes some time after launch, never
 * synchronously with it, so a process that exits immediately (e.g. a bad
 * exec) must not be missed just because nobody was listening yet.
 */
function createExitBroadcaster(): {
  watch: ProcessExitWatcher;
  fire: (info: ProcessExitInfo) => void;
} {
  let fired: ProcessExitInfo | null = null;
  const subscribers = new Set<(info: ProcessExitInfo) => void>();
  return {
    watch(onExit) {
      if (fired) {
        const info = fired;
        queueMicrotask(() => onExit(info));
        return () => {};
      }
      subscribers.add(onExit);
      return () => {
        subscribers.delete(onExit);
      };
    },
    fire(info) {
      if (fired) return;
      fired = info;
      for (const cb of [...subscribers]) cb(info);
      subscribers.clear();
    },
  };
}

/** Wires a real `ChildProcess`'s own `"exit"` event straight through — the precise, no-polling case (the detached-spawn path, where the daemon holds a direct handle). */
function watchChildExit(child: ChildProcess): ProcessExitWatcher {
  const broadcaster = createExitBroadcaster();
  child.once("exit", (code, signal) => broadcaster.fire({ code, signal }));
  return broadcaster.watch;
}

/**
 * Polls a pid's liveness (`process.kill(pid, 0)`) until it disappears — the
 * only option for the tmux-mode pane pid, which is a separate process the
 * daemon never directly spawned (tmux itself daemonizes it), so there is no
 * `ChildProcess` handle to attach a real `"exit"` listener to. Necessarily
 * imprecise: it can only ever report "gone" (`code`/`signal` both `null`),
 * and detection lags the true exit by up to `intervalMs`.
 */
function watchPidByPolling(
  pid: number,
  checkAlive: (pid: number) => boolean,
  intervalMs: number,
): ProcessExitWatcher {
  const broadcaster = createExitBroadcaster();
  const timer = setInterval(() => {
    if (!checkAlive(pid)) {
      clearInterval(timer);
      broadcaster.fire({ code: null, signal: null });
    }
  }, intervalMs);
  timer.unref?.();
  return broadcaster.watch;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function tmuxSessionName(sessionLabel: string): string {
  return `kvy-${sessionLabel}`;
}

type CompletionResult =
  | { spawnError: NodeJS.ErrnoException }
  | { code: number; stdout: string; stderr: string };

/** Runs a short-lived command to completion, collecting stdout/stderr/exit code (or a spawn error). */
function runToCompletion(
  spawnImpl: SpawnFn,
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<CompletionResult> {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => resolve({ spawnError: error as NodeJS.ErrnoException }));
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function queryTmuxPanePid(spawnImpl: SpawnFn, sessionName: string): Promise<number> {
  const result = await runToCompletion(
    spawnImpl,
    "tmux",
    ["list-panes", "-t", sessionName, "-F", "#{pane_pid}"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  if ("spawnError" in result) {
    throw new Error(
      `failed to query tmux pane pid for "${sessionName}": ${result.spawnError.message}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `tmux list-panes exited ${result.code} for "${sessionName}": ${result.stderr.trim()}`,
    );
  }

  const firstLine = result.stdout.split("\n").find((line) => line.trim().length > 0);
  const pid = firstLine ? Number.parseInt(firstLine.trim(), 10) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `tmux list-panes returned no usable pid for "${sessionName}": ${JSON.stringify(result.stdout)}`,
    );
  }
  return pid;
}

/** `null` means "tmux isn't installed, fall back to a detached process" — anything else that goes wrong throws. */
async function trySpawnViaTmux(
  opts: LaunchProcessOptions,
  spawnImpl: SpawnFn,
  logger: Logger,
  checkAlive: (pid: number) => boolean,
  pollIntervalMs: number,
): Promise<LaunchedProcess | null> {
  const sessionName = tmuxSessionName(opts.sessionLabel);
  const result = await runToCompletion(
    spawnImpl,
    "tmux",
    ["new-session", "-d", "-s", sessionName, "--", opts.command, ...opts.args],
    {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TMUX_STARTUP_TIMEOUT_MS,
    },
  );

  if ("spawnError" in result) {
    if (result.spawnError.code === "ENOENT") {
      logger.debug("[process-launcher] tmux not available, falling back to a detached process");
      return null;
    }
    throw new Error(`tmux new-session failed: ${result.spawnError.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`tmux new-session exited ${result.code}: ${result.stderr.trim()}`);
  }

  const pid = await queryTmuxPanePid(spawnImpl, sessionName);
  logger.debug("[process-launcher] spawned via tmux", { sessionName, pid });
  return {
    method: "tmux",
    pid,
    tmuxSessionName: sessionName,
    watchExit: watchPidByPolling(pid, checkAlive, pollIntervalMs),
  };
}

/** Detached, unref'd fallback for when tmux isn't installed. */
function spawnDetached(opts: LaunchProcessOptions, spawnImpl: SpawnFn): Promise<LaunchedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: "ignore",
    });
    // Attach the real exit watcher immediately — before the grace timer even
    // settles — so a process that exits (or fails to spawn) right away is
    // never missed (A3/A4: this is what lets `spawnAwaiter.waitFor` reject
    // fast on a dead child instead of always waiting out the full timeout).
    const watchExit = watchChildExit(child);

    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (typeof child.pid !== "number") {
        reject(new Error(`detached spawn of "${opts.command}" did not yield a pid`));
        return;
      }
      child.unref?.();
      resolve({ method: "detached", pid: child.pid, watchExit });
    }, DETACHED_SPAWN_GRACE_MS);
    timer.unref?.();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn "${opts.command}": ${error.message}`));
    });
  });
}

/**
 * Launches `opts.command` tmux-preferred, falling back to a detached process
 * when tmux isn't installed. Returns the pid of the actual spawned process
 * (the pane's process for the tmux path, not tmux's own server pid) so the
 * caller can match it against a later `/session-started` webhook.
 */
export async function launchProviderProcess(
  opts: LaunchProcessOptions,
  deps: LaunchProcessDeps = {},
): Promise<LaunchedProcess> {
  const spawnImpl = deps.spawnImpl ?? (crossSpawnDefault as unknown as SpawnFn);
  const logger = deps.logger ?? noopLogger;
  const checkAlive = deps.isProcessAlive ?? isProcessAlive;
  const pollIntervalMs = deps.tmuxExitPollIntervalMs ?? DEFAULT_TMUX_EXIT_POLL_INTERVAL_MS;

  const viaTmux = await trySpawnViaTmux(opts, spawnImpl, logger, checkAlive, pollIntervalMs);
  if (viaTmux) return viaTmux;

  const detached = await spawnDetached(opts, spawnImpl);
  logger.debug("[process-launcher] spawned detached (tmux unavailable)", { pid: detached.pid });
  return detached;
}
