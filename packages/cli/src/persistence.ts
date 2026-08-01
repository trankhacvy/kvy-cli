/**
 * Ported (adapted) from Happy — https://github.com/slopus/happy
 * Original: happy/packages/happy-cli/src/persistence.ts
 *
 * MIT License
 * Copyright (c) 2026 Happy Coder Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---
 * `~/.kvy/` local state persistence (design §7.2, plan.md §16 "1.3 CLI
 * skeleton + local mode"):
 *
 *   settings.json   schema-versioned; atomic read-modify-write via an
 *                   O_CREAT|O_EXCL lock file + tmp-write + rename.
 *   access.key      {token, masterSecret} — 0600, written via tmp + rename
 *                   so a reader never observes a partially-written file.
 *
 * Adapted from Happy: settings fields trimmed to what Kvy's design
 * actually defines (no `sandboxConfig`/`chromeMode` — Happy-specific
 * features with no Kvy equivalent); credentials narrowed to the single
 * `masterSecret` variant, since @kvy/crypto's `deriveKeyTree` (unlike
 * Happy's legacy-vs-dataKey split) only ever derives from one masterSecret.
 */

import { existsSync, constants as fsConstants } from "node:fs";
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import { resolveHomeDir } from "./home.js";

export interface PersistenceOptions {
  /** Overrides the resolved `~/.kvy` (or `KVY_HOME_DIR`) directory. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

function homeDirFrom(options: PersistenceOptions): string {
  return options.homeDir ?? resolveHomeDir(options.env ?? process.env);
}

function settingsFile(homeDir: string): string {
  return path.join(homeDir, "settings.json");
}

function credentialsFile(homeDir: string): string {
  return path.join(homeDir, "access.key");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

//
// Settings
//

/** Bumped whenever the `Settings` shape changes; written into every settings.json. */
export const SUPPORTED_SETTINGS_SCHEMA_VERSION = 1;

export interface Settings {
  schemaVersion: number;
  onboardingCompleted: boolean;
  /** Assigned once at first run; identifies this machine to the server (design §3.2, §7.2). */
  machineId?: string;
  /** Persisted override for KVY_BACKEND_URL (e.g. set once by `kvy auth login`). */
  backendUrl?: string;
  /** Persisted override for KVY_FRONTEND_URL. */
  frontendUrl?: string;
  /** Whether `ensureDaemonRunning()` (plan.md §16 "1.5 Daemon v1") auto-starts the daemon. */
  daemonAutoStart?: boolean;
  /**
   * Old→new provider-session-id lineage recorded by `kvy adopt`
   * (design §7.8 FR-9.5, plan.md §16 "3.3 Session adoption (UC9)"): keyed
   * by the original (oldest) provider session id, each value is the full
   * adoption chain in order, `[originalId, ...resumedIds]` — Claude Code's
   * `--resume` mints a brand-new session id every time, so this is how
   * Kvy later presents one continuous timeline across resumes instead
   * of a series of unrelated sessions.
   */
  adoptedSessions?: Record<string, string[]>;
  /**
   * Per-workspace settings written by `kvy workspace config
   * [--base-ref/--remote/--setup-script/--run-script/--directory]`
   * (kvy-prd.md line 148, plan.md §16 "4.1 Git panel";
   * docs/features/setup-run-scripts.md) — keyed by the workspace's real
   * (symlink-resolved) absolute directory path, same key shape
   * `daemon/gitDiff.ts`'s `resolveConfiguredBaseRef` looks up when a
   * `git.diff` RPC omits an explicit `baseRef`. `remote` is stored for a
   * future `git push`/PR fast-follow (kvy-prd.md FR-7.7) — unused by the
   * read-only MVP diff viewer. `setupScript`/`runScript`
   * (docs/features/setup-run-scripts.md) back the Setup/Run scripts
   * subsystem — `daemon/setupScript.ts` reads `setupScript` after a fresh
   * worktree creation; `daemon/runProcess.ts`'s `run.*` machine RPCs read
   * `runScript`.
   */
  workspaces?: Record<
    string,
    { baseRef?: string; remote?: string; setupScript?: string; runScript?: string }
  >;
  /**
   * Epoch-ms timestamp of the last auto-update-on-start background check
   * (`update/autoUpdateTrigger.ts`, plan.md §16 "4.3 Distribution &
   * self-host") — rate-limits how often `kvy` spawns a background
   * `kvy update` child so a stream of invocations doesn't hammer GitHub.
   */
  lastUpdateCheckAt?: number;
  /**
   * Per-machine sleep-inhibit policy (docs/features/sleep-inhibit.md,
   * docs/competitive-notes-omnara.md #12 "Sleep-inhibit control") —
   * re-applied via `daemon/sleepInhibit.ts`'s `createSleepInhibitManager`
   * at every `runDaemonStartSync` boot (independent of login state, so a
   * previously persisted "always" is enforced even in local-only mode),
   * and written by the `sleepInhibit.set` machine RPC handler whenever the
   * manager reports `supported: true` for the local platform. Absent (or
   * omitted from a settings.json an older `kvy` wrote) means "off" —
   * same lenient, unknown-value-tolerant precedent as `daemonAutoStart`.
   */
  sleepInhibit?: "off" | "onPower" | "always";
}

const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SETTINGS_SCHEMA_VERSION,
  onboardingCompleted: false,
};

/**
 * Field-by-field extraction rather than whole-object validation: unknown or
 * missing fields silently fall back to defaults, so a settings.json written
 * by an older *or* newer schema version never fails to load — only its
 * recognized fields are read. Schema migrations (when `SUPPORTED_SETTINGS_SCHEMA_VERSION`
 * bumps) add branches here, not a version gate on the whole read.
 */
function normalizeSettings(raw: Record<string, unknown>): Settings {
  const settings: Settings = { ...defaultSettings };
  if (typeof raw.onboardingCompleted === "boolean") {
    settings.onboardingCompleted = raw.onboardingCompleted;
  }
  if (typeof raw.machineId === "string") settings.machineId = raw.machineId;
  if (typeof raw.backendUrl === "string") settings.backendUrl = raw.backendUrl;
  if (typeof raw.frontendUrl === "string") settings.frontendUrl = raw.frontendUrl;
  if (typeof raw.daemonAutoStart === "boolean") settings.daemonAutoStart = raw.daemonAutoStart;
  if (isPlainObject(raw.adoptedSessions)) {
    const adoptedSessions: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(raw.adoptedSessions)) {
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        adoptedSessions[key] = value;
      }
    }
    settings.adoptedSessions = adoptedSessions;
  }
  if (isPlainObject(raw.workspaces)) {
    const workspaces: Record<
      string,
      { baseRef?: string; remote?: string; setupScript?: string; runScript?: string }
    > = {};
    for (const [key, value] of Object.entries(raw.workspaces)) {
      if (!isPlainObject(value)) continue;
      const entry: { baseRef?: string; remote?: string; setupScript?: string; runScript?: string } =
        {};
      if (typeof value.baseRef === "string") entry.baseRef = value.baseRef;
      if (typeof value.remote === "string") entry.remote = value.remote;
      if (typeof value.setupScript === "string") entry.setupScript = value.setupScript;
      if (typeof value.runScript === "string") entry.runScript = value.runScript;
      workspaces[key] = entry;
    }
    settings.workspaces = workspaces;
  }
  if (typeof raw.lastUpdateCheckAt === "number" && Number.isFinite(raw.lastUpdateCheckAt)) {
    settings.lastUpdateCheckAt = raw.lastUpdateCheckAt;
  }
  if (
    raw.sleepInhibit === "off" ||
    raw.sleepInhibit === "onPower" ||
    raw.sleepInhibit === "always"
  ) {
    settings.sleepInhibit = raw.sleepInhibit;
  }
  return settings;
}

/** Reads `settings.json`, falling back to defaults on a missing/corrupt file — never throws. */
export async function readSettings(options: PersistenceOptions = {}): Promise<Settings> {
  const file = settingsFile(homeDirFrom(options));
  if (!existsSync(file)) return { ...defaultSettings };

  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isPlainObject(parsed) ? normalizeSettings(parsed) : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
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
 * retry budget — the caller has no safe way to proceed past that.
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
  throw new Error(`failed to acquire settings lock after ${timeoutSec}s: ${lockFile}`);
}

/**
 * Atomically read-modify-write `settings.json`, safe against concurrent
 * `kvy` invocations: an exclusive lock file guards the critical section,
 * and the write itself lands via tmp-file + rename (atomic on POSIX), so a
 * concurrent reader never observes a half-written file.
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>,
  options: PersistenceOptions = {},
): Promise<Settings> {
  const homeDir = homeDirFrom(options);
  const file = settingsFile(homeDir);
  const lockFile = `${file}.lock`;
  const tmpFile = `${file}.tmp`;

  await mkdir(homeDir, { recursive: true });
  const lock = await acquireLock(lockFile);

  try {
    const current = await readSettings(options);
    const updated = await updater(current);
    const withVersion: Settings = { ...updated, schemaVersion: SUPPORTED_SETTINGS_SCHEMA_VERSION };

    await writeFile(tmpFile, JSON.stringify(withVersion, null, 2), "utf8");
    await rename(tmpFile, file); // atomic on POSIX

    return withVersion;
  } finally {
    await lock.close();
    // Best-effort: by this point the settings write already succeeded (or
    // the section above threw past this point already), so a failure to
    // remove the lock file isn't something the caller can act on — the next
    // acquirer's stale-mtime check reclaims it regardless.
    await unlink(lockFile).catch(() => {});
  }
}

//
// Credentials (access.key)
//

const credentialsSchema = z.object({
  token: z.string().min(1),
  /** Base64-encoded masterSecret — see @kvy/crypto's `deriveKeyTree`. */
  masterSecret: z.string().min(1),
});

export type Credentials = z.infer<typeof credentialsSchema>;

/** Reads `access.key`, returning `null` on a missing or corrupt/invalid file — never throws. */
export async function readCredentials(
  options: PersistenceOptions = {},
): Promise<Credentials | null> {
  const file = credentialsFile(homeDirFrom(options));
  if (!existsSync(file)) return null;

  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    return credentialsSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Writes `access.key` 0600-permissioned via tmp-file + rename, so a
 * concurrent reader never observes a partially-written or wrongly-permissioned
 * file. `fs.writeFile`'s `mode` option only takes effect when the file is
 * *created*, not when an existing path is overwritten — so the tmp file is
 * chmod'd explicitly before the rename lands it at the final path (rename
 * preserves the source inode's mode on POSIX).
 */
export async function writeCredentials(
  credentials: Credentials,
  options: PersistenceOptions = {},
): Promise<void> {
  const homeDir = homeDirFrom(options);
  const file = credentialsFile(homeDir);
  const tmpFile = `${file}.tmp`;

  await mkdir(homeDir, { recursive: true });
  await writeFile(tmpFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  await chmod(tmpFile, 0o600);
  await rename(tmpFile, file);
}

/**
 * Deletes `access.key`, e.g. on `kvy auth logout`. A no-op if it doesn't
 * exist — including if it's removed concurrently between the check and the
 * delete (e.g. two overlapping `logout` calls), so this never throws on a
 * race, only on a genuine unexpected error (e.g. permissions).
 */
export async function clearCredentials(options: PersistenceOptions = {}): Promise<void> {
  const file = credentialsFile(homeDirFrom(options));
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
