import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHomeDir } from "../home.js";
import { createLogger, type Logger } from "../logger.js";
import { startControlServer } from "./controlServer.js";
import { acquireDaemonLock, isProcessAlive } from "./lock.js";
import { clearDaemonState, type DaemonState, readDaemonState, writeDaemonState } from "./state.js";

/**
 * Wires the singleton lock (`lock.ts`), the control server (`controlServer.ts`),
 * and `daemon.state.json` (`state.ts`) into the four `falcon daemon` verbs
 * (design §8, plan.md §7.2):
 *
 *  - `start`      — short-lived: spawns `start-sync` detached, then (unless
 *                   `--no-wait`) polls until it reports ready.
 *  - `start-sync` — the daemon's own long-running process body (see
 *                   `markers.ts` — this is the exact argv `falcon kill`
 *                   recognizes as the daemon). Acquires the lock, boots the
 *                   control server, writes state, then blocks until shutdown
 *                   is requested (SIGINT/SIGTERM or the control server's own
 *                   `/stop`), then cleans up.
 *  - `stop`       — prefers a graceful HTTP `/stop` through the control
 *                   server; falls back to SIGTERM-then-SIGKILL via the pid
 *                   `daemon.state.json` advertises.
 *  - `status`     — reads `daemon.state.json`, confirms the pid is alive,
 *                   and probes the control server for extra confidence
 *                   (a reused pid after reboot would otherwise look "alive").
 *
 * Session tracking/spawning (`getSessions`/`stopSession`/`spawnSession`) is
 * out of scope here — that's the daemon's session-registry/spawner work
 * (§7.3/§8, separate plan bullets) — so `start-sync` wires the control
 * server with honest stand-ins (no sessions tracked yet, spawn always
 * reports "not implemented").
 */

export interface DaemonCommandDeps {
  homeDir: string;
  version: string;
  logger: Logger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Spawns `falcon daemon start-sync` as a detached, unref'd background process. */
  spawnStartSync: () => void;
  /** Sends `signal` to `pid`; swallows ESRCH (process already gone). */
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive: (pid: number) => boolean;
  /** Used for the control server's `/stop` (graceful shutdown) and `status`'s liveness probe. */
  fetchImpl: typeof fetch;
  /** Registers OS shutdown signals for `start-sync`; returns an unregister function. */
  registerShutdownSignals: (onShutdown: () => void) => () => void;
  /** How long `start` (without `--no-wait`) polls `daemon.state.json` before giving up. */
  readyTimeoutMs: number;
  /** How long `stop` waits for the pid to exit after each stop attempt (HTTP, then SIGTERM, then SIGKILL). */
  stopWaitTimeoutMs: number;
}

function readCliVersion(): string {
  try {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function defaultRegisterShutdownSignals(onShutdown: () => void): () => void {
  const handler = () => onShutdown();
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

/**
 * Re-invokes the exact entrypoint this process was started with
 * (`process.argv[1]` — works for `tsx src/index.ts`, `node dist/index.mjs`,
 * and the `bin/falcon.mjs` shim alike) with `daemon start-sync`, detached
 * and with stdio ignored so it survives the parent `start` command exiting.
 * Mirrors Happy's `spawnHappyCLI(['daemon', 'start-sync'], {detached: true})`.
 *
 * Also re-passes `process.execArgv` ahead of the entry path. Without this,
 * dev mode (`tsx src/index.ts daemon start`) spawns a plain `node
 * src/index.ts` child with none of tsx's `--require`/`--import` loader
 * hooks, which fails outright (`SyntaxError: Cannot use import statement
 * outside a module`) since node can't parse raw TypeScript on its own — the
 * spawned `start-sync` would then never write `daemon.state.json`, and
 * `start` would just time out waiting for it. `execArgv` is empty for the
 * plain `node dist/index.mjs` / `bin/falcon.mjs` cases, so this is a no-op
 * there.
 */
function defaultSpawnStartSync(): void {
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...process.execArgv, entry, "daemon", "start-sync"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function createDaemonCommandDeps(
  overrides: Partial<DaemonCommandDeps> = {},
): DaemonCommandDeps {
  return {
    homeDir: resolveHomeDir(),
    version: readCliVersion(),
    logger: createLogger(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    spawnStartSync: defaultSpawnStartSync,
    killPid: defaultKillPid,
    isProcessAlive,
    fetchImpl: fetch,
    registerShutdownSignals: defaultRegisterShutdownSignals,
    readyTimeoutMs: 5000,
    stopWaitTimeoutMs: 3000,
    ...overrides,
  };
}

export interface DaemonCommandResult {
  code: number;
  message: string;
}

const READY_POLL_MS = 50;

export async function runDaemonStart(
  deps: DaemonCommandDeps,
  opts: { noWait: boolean },
): Promise<DaemonCommandResult> {
  const existing = await readDaemonState(deps.homeDir);
  if (existing && deps.isProcessAlive(existing.pid)) {
    return {
      code: 0,
      message: `falcon daemon: already running (pid ${existing.pid}, port ${existing.port})\n`,
    };
  }

  deps.spawnStartSync();

  if (opts.noWait) {
    return { code: 0, message: "falcon daemon: starting in the background (--no-wait)\n" };
  }

  const deadline = Date.now() + deps.readyTimeoutMs;
  while (Date.now() < deadline) {
    const state = await readDaemonState(deps.homeDir);
    if (state && deps.isProcessAlive(state.pid)) {
      return {
        code: 0,
        message: `falcon daemon: started (pid ${state.pid}, port ${state.port})\n`,
      };
    }
    await deps.sleep(READY_POLL_MS);
  }
  return { code: 1, message: "falcon daemon: timed out waiting for the daemon to become ready\n" };
}

export async function runDaemonStartSync(deps: DaemonCommandDeps): Promise<number> {
  const { homeDir, logger } = deps;

  let triggerShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    triggerShutdown = resolve;
  });

  const controlServer = await startControlServer({
    getSessions: () => [],
    stopSession: () => false,
    spawnSession: async () => ({
      type: "error",
      errorMessage: "falcon daemon: session spawning is not implemented yet",
    }),
    requestShutdown: () => triggerShutdown(),
    onSessionStarted: () => {},
    logger,
  });

  const payload: DaemonState = {
    pid: process.pid,
    port: controlServer.port,
    version: deps.version,
    startedAt: deps.now(),
  };

  const lockResult = await acquireDaemonLock(homeDir, payload);
  if (!lockResult.ok) {
    await controlServer.stop();
    if (lockResult.reason === "held-by-running-process") {
      logger.warn("daemon start-sync: another daemon is already running", {
        pid: lockResult.existing.pid,
        port: lockResult.existing.port,
      });
    } else {
      logger.warn("daemon start-sync: failed to acquire the singleton lock (contended)");
    }
    return 1;
  }

  await writeDaemonState(homeDir, payload);
  logger.info("daemon start-sync: ready", { pid: payload.pid, port: payload.port });

  const unregisterSignals = deps.registerShutdownSignals(triggerShutdown);
  await shutdownRequested;
  unregisterSignals();

  await controlServer.stop();
  await lockResult.handle.release();
  await clearDaemonState(homeDir);
  logger.info("daemon start-sync: stopped");
  return 0;
}

const STOP_HTTP_TIMEOUT_MS = 2000;
const STOP_POLL_MS = 50;

async function waitWhileAlive(
  pid: number,
  deps: Pick<DaemonCommandDeps, "isProcessAlive" | "sleep">,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && deps.isProcessAlive(pid)) {
    await deps.sleep(STOP_POLL_MS);
  }
}

export async function runDaemonStop(deps: DaemonCommandDeps): Promise<DaemonCommandResult> {
  const state = await readDaemonState(deps.homeDir);
  if (!state) {
    return { code: 0, message: "falcon daemon: not running\n" };
  }

  if (!deps.isProcessAlive(state.pid)) {
    await clearDaemonState(deps.homeDir);
    return { code: 0, message: "falcon daemon: not running (stale state cleared)\n" };
  }

  // Prefer a graceful stop through the control server's own `/stop` endpoint.
  let stoppedGracefully = false;
  try {
    const res = await deps.fetchImpl(`http://127.0.0.1:${state.port}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(STOP_HTTP_TIMEOUT_MS),
    });
    stoppedGracefully = res.ok;
  } catch {
    stoppedGracefully = false;
  }

  if (stoppedGracefully) {
    await waitWhileAlive(state.pid, deps, deps.stopWaitTimeoutMs);
  }

  if (deps.isProcessAlive(state.pid)) {
    // Control server unreachable, or didn't shut the process down in time —
    // fall back to a plain signal-based stop via the pid `daemon.state.json`
    // advertises. The lock file is left alone: `acquireDaemonLock`'s
    // stale-PID reclaim (lock.ts) already cleans it up on the next
    // `daemon start`, once this pid is confirmed dead.
    deps.killPid(state.pid, "SIGTERM");
    await waitWhileAlive(state.pid, deps, deps.stopWaitTimeoutMs);
    if (deps.isProcessAlive(state.pid)) {
      deps.killPid(state.pid, "SIGKILL");
    }
  }

  await clearDaemonState(deps.homeDir);
  return { code: 0, message: `falcon daemon: stopped (pid ${state.pid})\n` };
}

async function probeControlServer(port: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runDaemonStatus(deps: DaemonCommandDeps): Promise<DaemonCommandResult> {
  const state = await readDaemonState(deps.homeDir);
  if (!state) {
    return { code: 1, message: "falcon daemon: not running\n" };
  }

  if (!deps.isProcessAlive(state.pid)) {
    await clearDaemonState(deps.homeDir);
    return { code: 1, message: "falcon daemon: not running (stale state cleared)\n" };
  }

  const reachable = await probeControlServer(state.port, deps.fetchImpl);
  if (!reachable) {
    return {
      code: 1,
      message: `falcon daemon: not running (pid ${state.pid} is alive but its control server on port ${state.port} is unreachable — stale state)\n`,
    };
  }

  return {
    code: 0,
    message: `falcon daemon: running (pid ${state.pid}, port ${state.port}, version ${state.version})\n`,
  };
}
