/**
 * `~/.kvy/run-state.json` — the persisted state for the Setup/Run
 * scripts subsystem's daemon-side run process and setup-script runs
 * (docs/features/setup-run-scripts.md Phase 3). Keyed by a directory's real
 * (symlink-resolved) absolute path — same key convention as
 * `workspaceConfig.ts`'s `resolveWorkspaceKey` — so a `run.*` RPC's
 * resolved worktree path and a re-read after a daemon restart land on the
 * same entry.
 *
 * Same tmp-write + rename atomicity + per-homeDir in-process write-queue
 * convention as `sessionsStore.ts` (this package's own precedent for
 * exactly this durability shape): the daemon is this file's only writer
 * process, so no cross-process lock file is needed, only `serialize()`
 * below to keep two overlapping updates (e.g. `run.start` and `run.setup`
 * for two different directories racing within the same tick) from
 * clobbering each other's read-modify-write.
 *
 * **PID-recycling caveat** (docs/features/setup-run-scripts.md's own risk
 * note): a persisted `detached`-method `pid`, re-probed with
 * `process.kill(pid, 0)` after a machine reboot, can in principle match an
 * unrelated process that happened to reuse the same pid. The `tmux` method
 * is immune (liveness is `tmux has-session -t <name>`, not a raw pid
 * probe) — callers (`runProcess.ts`) should prefer it, and treat a
 * `detached`-method liveness probe as a best-effort signal, not a hard
 * guarantee, until/unless a `startedAt`-plausibility check is added here.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUN_STATE_SCHEMA_VERSION = 1;

export type RunLaunchMethod = "tmux" | "detached";

export interface RunEntry {
  pid: number;
  method: RunLaunchMethod;
  tmuxSessionName?: string;
  /** `Date.now()` when this run was launched. */
  startedAt: number;
  /** Absolute path to the log file this run's stdout/stderr is redirected into. */
  logFile: string;
  /** The exact script string that was launched — for diagnostics only, never re-executed from here. */
  script: string;
}

export type SetupState = "running" | "succeeded" | "failed";

export interface SetupEntry {
  state: SetupState;
  exitCode?: number;
  /**
   * The OS pid of the setup script's shell process while `state ===
   * "running"` — `setupScript.ts`'s double-start guard probes this (via
   * `process.kill(pid, 0)`) rather than trusting a persisted "running"
   * state blindly, so a setup that ended abnormally (e.g. the whole daemon
   * was killed mid-run) doesn't wedge a directory into "running" forever.
   * Same PID-recycling caveat as `RunEntry` above — absent from a
   * terminal (`succeeded`/`failed`) entry.
   */
  pid?: number;
  /** `Date.now()` when this setup run started. */
  startedAt: number;
  /** `Date.now()` when it finished; absent while `state === "running"`. */
  finishedAt?: number;
  /** Absolute path to the log file this setup run's stdout/stderr is redirected into. */
  logFile: string;
}

export interface DirectoryRunState {
  run?: RunEntry;
  setup?: SetupEntry;
}

interface RunStateFileShape {
  schemaVersion: number;
  directories: Record<string, DirectoryRunState>;
}

export function runStateFilePath(homeDir: string): string {
  return path.join(homeDir, "run-state.json");
}

function isRunEntry(value: unknown): value is RunEntry {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.pid === "number" &&
    (c.method === "tmux" || c.method === "detached") &&
    (c.tmuxSessionName === undefined || typeof c.tmuxSessionName === "string") &&
    typeof c.startedAt === "number" &&
    typeof c.logFile === "string" &&
    typeof c.script === "string"
  );
}

function isSetupEntry(value: unknown): value is SetupEntry {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    (c.state === "running" || c.state === "succeeded" || c.state === "failed") &&
    (c.exitCode === undefined || typeof c.exitCode === "number") &&
    (c.pid === undefined || typeof c.pid === "number") &&
    typeof c.startedAt === "number" &&
    (c.finishedAt === undefined || typeof c.finishedAt === "number") &&
    typeof c.logFile === "string"
  );
}

function isDirectoryRunState(value: unknown): value is DirectoryRunState {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (c.run !== undefined && !isRunEntry(c.run)) return false;
  if (c.setup !== undefined && !isSetupEntry(c.setup)) return false;
  return true;
}

/**
 * Reads every well-formed entry. A missing/corrupt file, or one containing
 * a well-formed-JSON-but-wrong-shape entry, resolves to `{}` (that entry
 * silently dropped) rather than throwing — same "no state == no trust"
 * stance as `sessionsStore.ts`'s `readPersistedSessions`.
 */
export async function readRunState(homeDir: string): Promise<Record<string, DirectoryRunState>> {
  try {
    const raw = await readFile(runStateFilePath(homeDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const directories = (parsed as Partial<RunStateFileShape>).directories;
    if (typeof directories !== "object" || directories === null) return {};

    const result: Record<string, DirectoryRunState> = {};
    for (const [key, value] of Object.entries(directories)) {
      if (isDirectoryRunState(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** Reads a single directory's entry, or `undefined` if none is recorded (or the whole file is missing/corrupt). */
export async function readDirectoryRunState(
  homeDir: string,
  directoryKey: string,
): Promise<DirectoryRunState | undefined> {
  const all = await readRunState(homeDir);
  return all[directoryKey];
}

// One write-chain per homeDir — same rationale as `sessionsStore.ts`'s own
// `serialize()`: calls for the same homeDir always serialize through the
// same read-modify-write critical section, while calls for different
// homeDirs (e.g. across tests) never block each other.
const writeChains = new Map<string, Promise<void>>();

function serialize<T>(homeDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(homeDir) ?? Promise.resolve();
  const settleResult = previous.then(fn, fn);
  writeChains.set(
    homeDir,
    settleResult.then(
      () => undefined,
      () => undefined,
    ),
  );
  return settleResult;
}

async function writeRunStateFile(
  homeDir: string,
  directories: Record<string, DirectoryRunState>,
): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const file = runStateFilePath(homeDir);
  const tmpFile = `${file}.tmp`;
  const payload: RunStateFileShape = { schemaVersion: RUN_STATE_SCHEMA_VERSION, directories };
  await writeFile(tmpFile, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmpFile, file); // atomic on POSIX
}

/** Read-modify-write merge of `patch` into `directoryKey`'s entry (only the fields present in `patch` are replaced — `run`/`setup` each replace wholesale, not deep-merged, matching how callers always construct a full new entry). */
export async function updateDirectoryRunState(
  homeDir: string,
  directoryKey: string,
  patch: DirectoryRunState,
): Promise<DirectoryRunState> {
  return serialize(homeDir, async () => {
    const all = await readRunState(homeDir);
    const existing = all[directoryKey] ?? {};
    const merged: DirectoryRunState = { ...existing, ...patch };
    all[directoryKey] = merged;
    await writeRunStateFile(homeDir, all);
    return merged;
  });
}

/** Clears just the `run` entry for `directoryKey` (e.g. after `run.stop`), leaving any `setup` entry untouched. A no-op if there's nothing to clear. */
export async function clearRunEntry(homeDir: string, directoryKey: string): Promise<void> {
  await serialize(homeDir, async () => {
    const all = await readRunState(homeDir);
    const existing = all[directoryKey];
    if (!existing?.run) return;
    const { run: _run, ...rest } = existing;
    all[directoryKey] = rest;
    await writeRunStateFile(homeDir, all);
  });
}

/** Deletes `run-state.json` outright. Used by tests; a no-op if it doesn't exist. */
export async function clearRunStateFile(homeDir: string): Promise<void> {
  await serialize(homeDir, async () => {
    await unlink(runStateFilePath(homeDir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
}
