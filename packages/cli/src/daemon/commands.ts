import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as ioClientDefault, type Socket } from "socket.io-client";
import { resolveBackendUrl } from "../auth/config.js";
import {
  type FalconCredentials,
  readCredentials as readAuthCredentialsDefault,
} from "../auth/credentials.js";
import { resolveHomeDir } from "../home.js";
import { createLogger, type Logger } from "../logger.js";
import { readSettings, updateSettings } from "../persistence.js";
import {
  createTranscriptIndexerWorkspaceLister,
  createWorkspaceRootLookup,
} from "../workspace/adapters.js";
import { startControlServer } from "./controlServer.js";
import { acquireDaemonLock, isProcessAlive } from "./lock.js";
import {
  createMachineIntegrationDeps,
  type MachineIntegrationDeps,
  type MachineIntegrationHandle,
  startMachineIntegration,
} from "./machineIntegration.js";
import { listProcesses, type ProcessEntry, resolveProcessCwd } from "./processScan.js";
import type { ProviderSessionResolver } from "./providerSessionResolver.js";
import { type ResumeSessionDeps, resolveResumeDirectoryFromRecord } from "./resumeSession.js";
import {
  captureBundleMtimeMs as captureBundleMtimeMsDefault,
  hasBundleBeenReplaced as hasBundleBeenReplacedDefault,
} from "./selfUpdate.js";
import { createSessionRegistry } from "./sessionRegistry.js";
import type { PersistedSession } from "./sessionsStore.js";
import {
  createSleepInhibitManager as createSleepInhibitManagerDefault,
  type SleepInhibitManager,
  type SleepInhibitManagerDeps,
} from "./sleepInhibit.js";
import { createSpawnAwaiter } from "./spawnAwaiter.js";
import type { SpawnEngineDeps } from "./spawnEngine.js";
import { clearDaemonState, type DaemonState, readDaemonState, writeDaemonState } from "./state.js";
import type { RegisteredWorkspace } from "./transcriptIndexer.js";
import type { SessionEncryptionData } from "./types.js";
import type { WorkspaceRootLookup } from "./workspacePath.js";

/**
 * Wires the singleton lock (`lock.ts`), the control server (`controlServer.ts`),
 * the session registry (`sessionRegistry.ts`), and `daemon.state.json`
 * (`state.ts`) into the four `falcon daemon` verbs (design §8, plan.md
 * §7.2/§7.4):
 *
 *  - `start`      — short-lived: spawns `start-sync` detached, then (unless
 *                   `--no-wait`) polls until it reports ready.
 *  - `start-sync` — the daemon's own long-running process body (see
 *                   `markers.ts` — this is the exact argv `falcon kill`
 *                   recognizes as the daemon). Acquires the lock, restores
 *                   `sessions.json` into the session registry, boots the
 *                   control server, writes state, then — if this machine
 *                   has stored credentials (`falcon auth login` already
 *                   ran) — opens the machine-scoped `/v1/stream` socket and
 *                   registers the real `spawn`/`resumeSession`/`git.*`/
 *                   `fs.*`/`adopt.*` RPC handlers (`machineIntegration.ts`,
 *                   design §4.4/§8). Then blocks until shutdown is
 *                   requested (SIGINT/SIGTERM, the control server's own
 *                   `/stop`, or its own heartbeat's self-update handoff —
 *                   see below), then cleans up. A 60s heartbeat runs
 *                   throughout: it prunes dead session pids
 *                   (`SessionRegistry.pruneDeadSessions`, design §8: "prunes
 *                   stale session pids via `kill(pid,0)`") and checks
 *                   whether the installed CLI bundle has been replaced on
 *                   disk (`selfUpdate.ts`) — once replaced *and* the
 *                   registry reports no live sessions, it triggers the same
 *                   shutdown path, then (post-cleanup) spawns a fresh
 *                   `start-sync` to take over, mirroring Happy's "release
 *                   ownership BEFORE spawning the new daemon" ordering.
 *  - `stop`       — prefers a graceful HTTP `/stop` through the control
 *                   server; falls back to SIGTERM-then-SIGKILL via the pid
 *                   `daemon.state.json` advertises.
 *  - `status`     — reads `daemon.state.json`, confirms the pid is alive,
 *                   and probes the control server for extra confidence
 *                   (a reused pid after reboot would otherwise look "alive").
 *
 * `spawnSession` (the HTTP loopback `/spawn-session` path) stays an honest
 * stand-in here — it's a disjoint, separate feature (no `workspaceId`/
 * `idempotencyKey` in its body, a `sessionId` field belonging to a
 * different resume contract) from the machine-RPC `spawn`/`resumeSession`
 * this module now wires for real; see `P3-3.1-daemon-spawn-rpc`'s
 * task-summary for why it was deliberately left untouched.
 *
 * The machine RPC handlers' `resolveWorkspaceRoot`/`listWorkspaces` seams
 * default to the real `~/.falcon/workspaces.json`-backed registry
 * (`workspace/registry.ts`, adapted in `workspace/adapters.ts`) — a `spawn`
 * RPC's `workspaceId` is validated against an actually-registered directory
 * (`workspacePath.ts`'s `validateSpawnWorkspace`, via
 * `machineIntegration.ts`), and the transcript indexer
 * (`transcriptIndexer.ts`, started from within `machineIntegration.ts` once
 * a machine client is up) fs-watches actually-registered workspaces instead
 * of nothing. `resolveResumeDirectory` now defaults to the real
 * `resolveResumeDirectoryFromRecord` (`resumeSession.ts`), re-resolving a
 * persisted session's stored spawn `directory` via `realpath` so
 * spawn-directory-dedup survives a daemon restart (plan.md §16 "Flow 3 —
 * spawn-directory-dedup"). `resolveProviderSession` still has no real default
 * (resolving a bare provider session id back to a workspace needs
 * transcript-content scanning, a different, later composition — see
 * `providerSessionResolver.ts`'s own doc comment) — it honestly reports
 * "unresolved" rather than guessing. `DaemonCommandDeps`
 * exposes all of these as overridable so tests (and any future real
 * `resolveProviderSession`) can plug in a different implementation without
 * touching this wiring again.
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
  /** Lists every OS process visible to this user. Defaults to `processScan.ts`'s real `ps`-backed implementation. Used at boot to re-adopt live orphaned sessions (`readoptSessions.ts`). */
  listProcesses: () => Promise<ProcessEntry[]>;
  /** Resolves a pid's current working directory. Defaults to `processScan.ts`'s real implementation. Used alongside `listProcesses` for boot-time re-adoption. */
  resolveProcessCwd: (pid: number) => Promise<string | null>;
  /** Used for the control server's `/stop` (graceful shutdown) and `status`'s liveness probe. */
  fetchImpl: typeof fetch;
  /** Registers OS shutdown signals for `start-sync`; returns an unregister function. */
  registerShutdownSignals: (onShutdown: () => void) => () => void;
  /** How long `start` (without `--no-wait`) polls `daemon.state.json` before giving up. */
  readyTimeoutMs: number;
  /** How long `stop` waits for the pid to exit after each stop attempt (HTTP, then SIGTERM, then SIGKILL). */
  stopWaitTimeoutMs: number;
  /**
   * Absolute path to the built CLI bundle (`dist/index.mjs`) whose mtime
   * `start-sync`'s heartbeat watches for self-update detection
   * (`selfUpdate.ts`). The default here (computed relative to *this*
   * module's own location) is only correct when this file runs unbundled
   * from its real source path (dev/`tsx`, and `vitest`, which both execute
   * it directly) — once pkgroll bundles every module into a single
   * `dist/index.mjs`, that relative computation no longer lines up (the
   * same caveat `readCliVersion()` above has for `package.json`). `index.ts`
   * passes an explicit, bundle-aware override, exactly like it already does
   * for `version`.
   */
  bundlePath: string;
  /** How often `start-sync`'s heartbeat prunes dead sessions and checks for a self-update. */
  heartbeatIntervalMs: number;
  /** Injectable for tests; defaults to `selfUpdate.ts`'s real, `fs`-backed implementation. */
  captureBundleMtimeMs: (entryPath: string) => number | null;
  /** Injectable for tests; defaults to `selfUpdate.ts`'s real, `fs`-backed implementation. */
  hasBundleBeenReplaced: (entryPath: string, initialMtimeMs: number | null) => boolean;

  // --- Machine-scoped WS client + RPC handler wiring (machineIntegration.ts) ---

  /** The backend origin `startMachineClient` registers against and opens `/v1/stream` to. Defaults to `resolveBackendUrl()` (`FALCON_BACKEND_URL`, or the production default). */
  machineServerUrl: string;
  /** Reads `~/.falcon/access.key`; `null` means "not logged in", in which case `start-sync` runs local-only and never opens a machine-scoped socket. Defaults to `auth/credentials.ts`'s real reader. */
  readAuthCredentials: (homeDir: string) => FalconCredentials | null;
  /** Builds the socket.io-client transport for the machine-scoped connection. Injectable so tests can point at a fake/local server; defaults to the real `socket.io-client`. */
  machineIoFactory: (url: string, opts: Record<string, unknown>) => Socket;
  /** How often the machine client sends its `machine-alive` heartbeat. Defaults to 60s (design §8). */
  machineHeartbeatIntervalMs: number;
  /** Resolves a `spawn` RPC's `workspaceId` to its registered root directory. Defaults to the real `workspaces.json`-backed registry — see this module's own doc comment. */
  resolveWorkspaceRoot: WorkspaceRootLookup;
  /** Lists every registered workspace for the transcript indexer's boot-time fs-watch (`transcriptIndexer.ts`). Defaults to the same real registry as `resolveWorkspaceRoot`. */
  listWorkspaces: () => Promise<RegisteredWorkspace[]>;
  /** Resolves `adopt.take`/`adopt.mirror`'s bare provider session id to a registered workspace. No real default yet — see this module's own doc comment. */
  resolveProviderSession: ProviderSessionResolver;
  /** Resolves the working directory to relaunch a `resumeSession` RPC's target in. Defaults to `resumeSession.ts`'s `resolveResumeDirectoryFromRecord` (re-`realpath`s the persisted session's stored `directory`) — see this module's own doc comment. */
  resolveResumeDirectory: (
    session: PersistedSession,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /** Test-only escape hatch: extra overrides merged into `spawnEngine.ts`'s deps (e.g. a fake process launcher, so tests never actually spawn `tmux`/a provider CLI). Unset in production. */
  spawnEngineOverrides?: Partial<SpawnEngineDeps>;
  /** Same, for `resumeSession.ts`. */
  resumeSessionOverrides?: Partial<ResumeSessionDeps>;

  // --- Sleep-inhibit (docs/features/sleep-inhibit.md, docs/competitive-notes-omnara.md #12) ---

  /**
   * Creates the sleep-inhibit assertion manager (`daemon/sleepInhibit.ts`).
   * Injectable so tests use a fake manager instead of ever spawning a real
   * `caffeinate`; defaults to the real `createSleepInhibitManager`. The
   * manager is created and boot-applied here in `runDaemonStartSync`
   * (unconditionally, BEFORE `startMachineIntegration`) rather than inside
   * `machineIntegration.ts`, because a previously persisted "always" must
   * still be enforced even in logged-out/local-only mode, where
   * `startMachineIntegration` returns `null` and never runs its own wiring.
   */
  createSleepInhibitManager: (deps: SleepInhibitManagerDeps) => SleepInhibitManager;
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

/**
 * Mirrors `readCliVersion()`'s directory computation exactly (correct in
 * dev/`vitest`, override required in prod — see `bundlePath`'s doc comment
 * above and `index.ts`'s `resolveBundlePath()`).
 */
function defaultBundlePath(): string {
  const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return path.join(pkgRoot, "dist", "index.mjs");
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
  // Resolved ahead of the returned object (honoring an override, same as
  // the final value the `homeDir` field below will actually carry) so the
  // registry-backed defaults constructed here read/write the SAME
  // `~/.falcon` (or overridden test tmpdir) the rest of this deps object
  // uses — never a mismatched real-home-dir default under a test's
  // overridden `homeDir`.
  const homeDir = overrides.homeDir ?? resolveHomeDir();
  return {
    homeDir,
    version: readCliVersion(),
    logger: createLogger(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    spawnStartSync: defaultSpawnStartSync,
    killPid: defaultKillPid,
    isProcessAlive,
    listProcesses,
    resolveProcessCwd,
    fetchImpl: fetch,
    registerShutdownSignals: defaultRegisterShutdownSignals,
    readyTimeoutMs: 5000,
    stopWaitTimeoutMs: 3000,
    bundlePath: defaultBundlePath(),
    heartbeatIntervalMs: 60_000,
    captureBundleMtimeMs: captureBundleMtimeMsDefault,
    hasBundleBeenReplaced: hasBundleBeenReplacedDefault,
    machineServerUrl: resolveBackendUrl(),
    readAuthCredentials: (homeDir) => readAuthCredentialsDefault(homeDir),
    machineIoFactory: (url, opts) => ioClientDefault(url, opts),
    machineHeartbeatIntervalMs: 60_000,
    resolveWorkspaceRoot: createWorkspaceRootLookup({ homeDir }),
    listWorkspaces: createTranscriptIndexerWorkspaceLister({ homeDir }),
    resolveProviderSession: async () => null,
    resolveResumeDirectory: resolveResumeDirectoryFromRecord,
    createSleepInhibitManager: createSleepInhibitManagerDefault,
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

  // Restore sessions.json BEFORE serving any request (design §7.4/§8): a
  // resume that races the daemon's own boot must always see whatever was
  // durable before the crash/restart, never a still-empty registry.
  const registry = createSessionRegistry({ homeDir, now: deps.now, logger });
  const restoredCount = await registry.restore();
  if (restoredCount > 0) {
    logger.info("daemon start-sync: restored persisted sessions", { count: restoredCount });
  }

  // Re-adopt any live orphaned session (plan.md §16 "Flow 3 —
  // spawn-directory-dedup"): a still-running session process a prior daemon
  // spawned but this restart never got a chance to re-track. Must happen
  // BEFORE the control server (and any spawn RPC) starts serving, so
  // spawn-directory-dedup sees it immediately rather than racing a fresh
  // duplicate spawn.
  const readoptedCount = await registry.readoptLiveSessions({
    listProcesses: deps.listProcesses,
    resolveCwd: deps.resolveProcessCwd,
  });
  if (readoptedCount > 0) {
    logger.info("daemon start-sync: re-adopted live orphaned sessions after restart", {
      count: readoptedCount,
    });
  }

  // Matches the launched process's pid to its `/session-started` webhook —
  // shared by both the `spawn` and `resumeSession` machine RPCs
  // (`spawnEngine.ts`/`resumeSession.ts`, via `machineIntegration.ts` below).
  const spawnAwaiter = createSpawnAwaiter();

  // The one place a spawned/resumed session's self-report actually lands:
  // feeds the durable registry AND resolves whichever RPC is waiting on this
  // pid. Without the second half, `spawn`/`resumeSession` would always time
  // out after 15s — the awaiter would exist but nothing would ever feed it.
  function onSessionStarted(
    sessionId: string,
    metadata: unknown,
    encryption?: SessionEncryptionData,
    pid?: number,
  ): void {
    registry.onSessionStarted(sessionId, metadata, encryption, pid);
    if (pid !== undefined) {
      spawnAwaiter.resolve({ sessionId, metadata, encryption, pid });
    }
  }

  // A4: the child's own best-effort self-report of why it failed to start
  // (`/session-start-failed`, `start.ts`'s/`startCodex.ts`'s
  // `bootstrapSession()` catch block) — routes straight into the same
  // `spawnAwaiter` so a daemon-initiated `spawn` RPC's `waitFor` can reject
  // with the real message instead of only ever seeing a generic timeout.
  function onSessionStartFailed(pid: number, error: string): void {
    spawnAwaiter.reject(pid, error);
  }

  // Assigned further down, once the singleton lock is held — but captured by the
  // control server's `reloadAuth` closure here so a re-paired session can ask the
  // daemon to pick up new credentials without a full restart (AX-1.6).
  let machineIntegrationDeps: MachineIntegrationDeps | null = null;
  let machineIntegration: MachineIntegrationHandle | null = null;

  const controlServer = await startControlServer({
    getSessions: registry.getSessions,
    stopSession: registry.stopSession,
    spawnSession: async () => ({
      type: "error",
      errorMessage: "falcon daemon: session spawning is not implemented yet",
    }),
    requestShutdown: () => triggerShutdown(),
    onSessionStarted,
    onSessionStartFailed,
    reloadAuth: async () => {
      if (!machineIntegrationDeps) return false;
      await machineIntegration?.stop();
      machineIntegration = await startMachineIntegration(machineIntegrationDeps);
      logger.info("daemon reload-auth: machine integration restarted", {
        connected: machineIntegration !== null,
      });
      return machineIntegration !== null;
    },
    logger,
  });

  // Carry over any previously-registered `machineId`/`wrappedDek`
  // (`machineClient.ts`'s `persistMachineId`, `machineIntegration.ts`'s own
  // DEK persistence) so `startMachineIntegration` below actually resumes the
  // same server-side machine row under the same DEK, instead of registering
  // a brand new machine (and minting a mismatched fresh DEK) on every single
  // boot — without this, overwriting the whole state file with a
  // `machineId`/`wrappedDek`-less payload before `startMachineIntegration`
  // runs would erase both first and make every restart look like a fresh
  // machine.
  const previousState = await readDaemonState(homeDir);
  const payload: DaemonState = {
    pid: process.pid,
    port: controlServer.port,
    version: deps.version,
    startedAt: deps.now(),
    machineId: previousState?.machineId,
    wrappedDek: previousState?.wrappedDek,
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

  // Sleep-inhibit (docs/features/sleep-inhibit.md, docs/competitive-notes-
  // omnara.md #12): created and boot-re-applied here, unconditionally and
  // BEFORE `startMachineIntegration` below — a previously persisted "always"
  // must still hold the OS assertion even in logged-out/local-only mode,
  // where `startMachineIntegration` returns `null` and never runs. Only
  // created once the singleton lock is actually held (never spawn
  // `caffeinate` from a daemon that lost the boot race).
  const sleepInhibitManager = deps.createSleepInhibitManager({ logger, daemonPid: process.pid });
  const persistedSettings = await readSettings({ homeDir });
  sleepInhibitManager.applyMode(persistedSettings.sleepInhibit ?? "off");

  // Open the machine-scoped WS client + register the real machine RPC
  // handlers (design §4.4/§8, plan.md §16 "3.1"/"3.2"/"3.3") now that the
  // lock is held and the registry is restored — a `null` result just means
  // "not logged in yet", not a boot failure (see machineIntegration.ts).
  machineIntegrationDeps = createMachineIntegrationDeps(
    { homeDir, registry, awaiter: spawnAwaiter },
    {
      logger,
      serverUrl: deps.machineServerUrl,
      fetchImpl: deps.fetchImpl,
      ioFactory: deps.machineIoFactory,
      readCredentials: () => deps.readAuthCredentials(homeDir),
      resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
      listWorkspaces: deps.listWorkspaces,
      resolveProviderSession: deps.resolveProviderSession,
      resolveResumeDirectory: deps.resolveResumeDirectory,
      heartbeatIntervalMs: deps.machineHeartbeatIntervalMs,
      spawnEngineOverrides: deps.spawnEngineOverrides,
      resumeSessionOverrides: deps.resumeSessionOverrides,
      getSleepInhibit: async () => sleepInhibitManager.getState(),
      // Persist only when the platform actually supports the assertion —
      // recording a mode on a non-Mac would remember an intent the daemon
      // can never honor, which `sleepInhibit.set`'s wire contract explicitly
      // treats as indistinguishable from "unsupported" (see machineRpc.ts's
      // own doc comment). Apply-then-persist is safe here because the
      // support check gates the persist, not the apply.
      setSleepInhibit: async ({ mode }) => {
        const state = sleepInhibitManager.applyMode(mode);
        if (state.supported) {
          await updateSettings((current) => ({ ...current, sleepInhibit: mode }), { homeDir });
        }
        return state;
      },
    },
  );
  machineIntegration = await startMachineIntegration(machineIntegrationDeps);

  // Self-update detection (§8: "watch installed artifact mtime ... restart
  // when idle") shares this same heartbeat with dead-session pruning (§8:
  // "prunes stale session pids via kill(pid,0)") — one interval, two
  // unrelated but equally periodic jobs, same as Happy's own heartbeat.
  const initialBundleMtimeMs = deps.captureBundleMtimeMs(deps.bundlePath);
  let restartHandoffTriggered = false;

  const heartbeat = setInterval(() => {
    registry.pruneDeadSessions(deps.isProcessAlive);

    if (restartHandoffTriggered) return;
    if (!deps.hasBundleBeenReplaced(deps.bundlePath, initialBundleMtimeMs)) return;
    if (registry.hasLiveSessions()) {
      logger.debug(
        "daemon start-sync: bundle replaced on disk but sessions are still active, deferring restart",
      );
      return;
    }

    logger.info("daemon start-sync: bundle replaced and idle, handing off to a fresh daemon");
    restartHandoffTriggered = true;
    triggerShutdown();
  }, deps.heartbeatIntervalMs);
  heartbeat.unref?.();

  const unregisterSignals = deps.registerShutdownSignals(triggerShutdown);
  await shutdownRequested;
  clearInterval(heartbeat);
  unregisterSignals();

  // Stop taking new machine RPCs / heartbeats before tearing down the
  // control server and releasing the lock, mirroring the boot order above
  // (machine client started last, stopped first). `machineIntegration.stop()`
  // is awaited — it now also closes every tracked dev-server preview tunnel
  // (`closeAllTunnels`, docs/features/dev-server-preview.md) before
  // resolving. `sleepInhibitManager.stop()` MUST run before
  // `deps.spawnStartSync()` can fire in the restart-handoff branch below —
  // release-then-fresh-daemon-reapplies is what prevents two daemons briefly
  // holding two caffeinate children during a self-update handoff (the `-w`
  // tether is the crash-path backstop; this is the polite path for the
  // ordinary case).
  await machineIntegration?.stop();
  sleepInhibitManager.stop();
  await controlServer.stop();
  await lockResult.handle.release();
  await clearDaemonState(homeDir);

  if (restartHandoffTriggered) {
    // Ownership released BEFORE spawning the replacement — otherwise its own
    // "already running" check (`runDaemonStart`) would see our still-present
    // state/lock and refuse to start, leaving nothing running once we exit.
    deps.spawnStartSync();
    logger.info("daemon start-sync: spawned replacement daemon");
  }

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
      message: `falcon daemon: not running (pid ${state.pid} is alive but its control server on port ${state.port} is unreachable, stale state)\n`,
    };
  }

  return {
    code: 0,
    message: `falcon daemon: running (pid ${state.pid}, port ${state.port}, version ${state.version})\n`,
  };
}
