/**
 * Workspace registry — "which workspace directories does this machine know
 * about" (plan.md §16 "3.1 Remote spawn" / "3.3 Session adoption (UC9)",
 * kvy-system-design.md §12: "spawn params validated against registered
 * workspace paths"). Several already-landed tasks
 * (`daemon/workspacePath.ts`'s `WorkspaceRootLookup`,
 * `daemon/transcriptIndexer.ts`'s `listWorkspaces`,
 * `daemon/providerSessionResolver.ts`'s `ProviderSessionResolver`) each
 * deliberately left this as an injected seam with no real default, noting a
 * standalone store didn't exist yet. This module is that store; see
 * `./adapters.ts` for real implementations of the first two seams built on
 * top of it.
 *
 * Persisted at `~/.kvy/workspaces.json` — a dedicated file, not a new
 * field on `persistence.ts`'s `settings.json`. Several sibling tasks touch
 * `settings.json`/`workspaceConfig.ts` already (`adoptedSessions`,
 * per-workspace git config); this task's brief asks for a self-contained,
 * disjoint file addition, so the atomic-write shape below is copied from
 * `persistence.ts` (same `O_CREAT|O_EXCL` lock file + tmp-write-then-rename
 * pattern) rather than sharing its implementation.
 *
 * Keyed by the workspace directory's real (symlink-resolved) absolute
 * path — same rationale as `workspaceConfig.ts`'s `resolveWorkspaceKey`: a
 * lookup from a daemon-resolved `realpath` and a lookup from a raw
 * `process.cwd()` land on the same entry. That resolved path also *is* the
 * workspace's `workspaceId` everywhere in this module — matching the
 * simplification `P3-3.1-web-new-session-flow`'s `live-actions.ts` already
 * assumed ("no workspace registry yet ... the directory stands in as its
 * own stable workspace identity"), now backed by a real store.
 */
import { existsSync, constants as fsConstants } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { resolveHomeDir } from "../home.js";

export interface RegistryOptions {
  /** Overrides the resolved `~/.kvy` (or `KVY_HOME_DIR`) directory. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RegisteredWorkspaceEntry {
  /** Real (symlink-resolved) absolute path — also this workspace's `workspaceId`. */
  path: string;
  displayName?: string;
  /** ISO-8601 timestamp of first registration; unchanged by re-registering. */
  registeredAt: string;
}

interface RegistryFile {
  schemaVersion: number;
  workspaces: RegisteredWorkspaceEntry[];
}

const SCHEMA_VERSION = 1;
const EMPTY_REGISTRY: RegistryFile = { schemaVersion: SCHEMA_VERSION, workspaces: [] };

function homeDirFrom(options: RegistryOptions): string {
  return options.homeDir ?? resolveHomeDir(options.env ?? process.env);
}

function registryFile(homeDir: string): string {
  return path.join(homeDir, "workspaces.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEntry(value: unknown): RegisteredWorkspaceEntry | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.path !== "string" || value.path.length === 0) return null;
  if (typeof value.registeredAt !== "string") return null;
  const entry: RegisteredWorkspaceEntry = { path: value.path, registeredAt: value.registeredAt };
  if (typeof value.displayName === "string") entry.displayName = value.displayName;
  return entry;
}

/** Field-by-field extraction, same rationale as `persistence.ts`'s `normalizeSettings`: unknown/malformed entries are dropped, not fatal to the whole read. */
function normalizeRegistry(raw: unknown): RegistryFile {
  if (!isPlainObject(raw) || !Array.isArray(raw.workspaces))
    return { ...EMPTY_REGISTRY, workspaces: [] };
  const workspaces: RegisteredWorkspaceEntry[] = [];
  for (const item of raw.workspaces) {
    const entry = normalizeEntry(item);
    if (entry) workspaces.push(entry);
  }
  return { schemaVersion: SCHEMA_VERSION, workspaces };
}

/** Reads `workspaces.json`, falling back to an empty registry on a missing/corrupt file — never throws. */
async function readRegistry(options: RegistryOptions): Promise<RegistryFile> {
  const file = registryFile(homeDirFrom(options));
  if (!existsSync(file)) return { ...EMPTY_REGISTRY, workspaces: [] };

  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return normalizeRegistry(parsed);
  } catch {
    return { ...EMPTY_REGISTRY, workspaces: [] };
  }
}

const LOCK_RETRY_INTERVAL_MS = 100;
const MAX_LOCK_ATTEMPTS = 50; // 5 seconds total
const STALE_LOCK_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquires an exclusive lock file via O_CREAT|O_EXCL (atomic create-or-fail),
 * retrying while another process/invocation holds it, and reclaiming it if
 * its mtime is older than `STALE_LOCK_TIMEOUT_MS` (a prior holder that died
 * without cleaning up). Throws if the lock can't be acquired within the
 * retry budget — mirrors `persistence.ts`'s `acquireLock` exactly.
 */
async function acquireLock(lockFile: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      return await open(lockFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      await sleep(LOCK_RETRY_INTERVAL_MS);
      try {
        const stats = await stat(lockFile);
        if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
          await unlink(lockFile).catch(() => {});
        }
      } catch {
        // Lock file vanished between the failed open and this stat — another
        // attempt already cleared it; the next loop iteration retries open().
      }
    }
  }
  const timeoutSec = (MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS) / 1000;
  throw new Error(`failed to acquire workspace registry lock after ${timeoutSec}s: ${lockFile}`);
}

/**
 * Atomically read-modify-write `workspaces.json`, safe against concurrent
 * `kvy` invocations: an exclusive lock file guards the critical section,
 * and the write itself lands via tmp-file + rename (atomic on POSIX), so a
 * concurrent reader never observes a half-written file.
 */
async function updateRegistry(
  updater: (current: RegistryFile) => RegistryFile,
  options: RegistryOptions,
): Promise<RegistryFile> {
  const homeDir = homeDirFrom(options);
  const file = registryFile(homeDir);
  const lockFile = `${file}.lock`;
  const tmpFile = `${file}.tmp`;

  await mkdir(homeDir, { recursive: true });
  const lock = await acquireLock(lockFile);

  try {
    const current = await readRegistry(options);
    const updated = updater(current);
    const withVersion: RegistryFile = { ...updated, schemaVersion: SCHEMA_VERSION };

    await writeFile(tmpFile, JSON.stringify(withVersion, null, 2), "utf8");
    await rename(tmpFile, file); // atomic on POSIX

    return withVersion;
  } finally {
    await lock.close();
    // Best-effort: by this point the write already succeeded (or the
    // section above already threw past this point), so a failure to remove
    // the lock file isn't actionable here — the next acquirer's stale-mtime
    // check reclaims it regardless.
    await unlink(lockFile).catch(() => {});
  }
}

/**
 * Resolves `directory` to the key this registry stores/looks entries up
 * under — the real path when it exists, else the plain absolute path (same
 * fallback as `workspaceConfig.ts`'s `resolveWorkspaceKey`, so a directory
 * that hasn't been created yet can still be pre-registered).
 */
export async function resolveWorkspacePath(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Registers `directory` (creating a new entry with `registeredAt` set to
 * now) or, if already registered, updates its `displayName` in place
 * without touching `registeredAt`. Idempotent — registering the same
 * directory twice is safe and returns the same entry (with any new
 * `displayName` patch applied).
 */
export async function registerWorkspace(
  directory: string,
  patch: { displayName?: string } = {},
  options: RegistryOptions = {},
): Promise<RegisteredWorkspaceEntry> {
  const key = await resolveWorkspacePath(directory);
  const registry = await updateRegistry((current) => {
    const existingIndex = current.workspaces.findIndex((entry) => entry.path === key);
    if (existingIndex === -1) {
      const entry: RegisteredWorkspaceEntry = {
        path: key,
        registeredAt: new Date().toISOString(),
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      };
      return { ...current, workspaces: [...current.workspaces, entry] };
    }

    const existing = current.workspaces[existingIndex] as RegisteredWorkspaceEntry;
    const merged: RegisteredWorkspaceEntry = {
      ...existing,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    };
    const workspaces = [...current.workspaces];
    workspaces[existingIndex] = merged;
    return { ...current, workspaces };
  }, options);

  return registry.workspaces.find((entry) => entry.path === key) as RegisteredWorkspaceEntry;
}

/** Lists every registered workspace, in registration order. */
export async function listWorkspaces(
  options: RegistryOptions = {},
): Promise<RegisteredWorkspaceEntry[]> {
  const registry = await readRegistry(options);
  return registry.workspaces;
}

/** Removes `directory`'s registration, if any. Returns whether an entry was actually removed. */
export async function unregisterWorkspace(
  directory: string,
  options: RegistryOptions = {},
): Promise<boolean> {
  const key = await resolveWorkspacePath(directory);
  let removed = false;
  await updateRegistry((current) => {
    const workspaces = current.workspaces.filter((entry) => entry.path !== key);
    removed = workspaces.length !== current.workspaces.length;
    return { ...current, workspaces };
  }, options);
  return removed;
}

/**
 * Returns the registered workspace `directory` falls inside of (equal to
 * its root, or nested under it), or `null` if none matches. Resolves
 * `directory` via `realpath` first so a symlink can't be used to appear
 * inside a root it doesn't actually resolve into — generalizes the same
 * containment check `daemon/workspacePath.ts`'s `validateSpawnWorkspace`
 * already performs against a single injected root to "any registered
 * root". A directory that doesn't exist (or can't be resolved) never
 * matches — an unregistered, nonexistent path can't be "within" anything.
 */
export async function isWithinRegisteredWorkspace(
  directory: string,
  options: RegistryOptions = {},
): Promise<RegisteredWorkspaceEntry | null> {
  let real: string;
  try {
    real = await realpath(path.resolve(directory));
  } catch {
    return null;
  }

  const registry = await readRegistry(options);
  for (const entry of registry.workspaces) {
    const relative = path.relative(entry.path, real);
    const isInside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (isInside) return entry;
  }
  return null;
}
