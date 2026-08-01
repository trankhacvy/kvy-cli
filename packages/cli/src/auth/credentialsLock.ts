/**
 * known-issues.md #20: the daemon and a foreground `kvy claude`/`kvy codex`
 * session each run their own `TokenProvider` against the SAME on-disk
 * `~/.kvy/access.key` refresh token. Without coordination, both can call
 * `/v1/auth/refresh` around the same moment — whichever loses the race gets back a
 * benign-looking 200 that doesn't actually advance its refresh token, and if that
 * stale token is presented again later (past the server's grace window),
 * `refresh.ts` treats it as a replayed/stolen token and revokes the whole device
 * family, forcing a real re-login for what was an entirely benign same-machine
 * race.
 *
 * This lock serializes the refresh-token-file critical section across sibling
 * processes on this machine so at most one of them is ever actually rotating the
 * token at a time. Same atomic hard-link + PID + stale-reclaim pattern as
 * `daemon/lock.ts`'s `acquireDaemonLock` (reuses its `isProcessAlive`), but unlike
 * that singleton guard — which fails fast when another live process holds it —
 * this lock is a short-lived mutex: a contended acquire polls and waits for the
 * holder to finish its (fast, single HTTP call) critical section instead of giving
 * up immediately.
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "../daemon/lock.js";

const LOCK_FILE_NAME = "access.key.lock";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

interface CredentialsLockPayload {
  pid: number;
  startedAt: number;
}

export type ReleaseCredentialsLock = () => Promise<void>;

export interface AcquireCredentialsLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export function lockFilePath(homeDir: string): string {
  return path.join(homeDir, LOCK_FILE_NAME);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockPayload(lockPath: string): Promise<CredentialsLockPayload | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pid === "number" &&
      typeof (parsed as Record<string, unknown>).startedAt === "number"
    ) {
      return parsed as CredentialsLockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeTempPayload(homeDir: string, payload: CredentialsLockPayload): Promise<string> {
  const tmpPath = path.join(
    homeDir,
    `.${LOCK_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(tmpPath, JSON.stringify(payload));
  return tmpPath;
}

async function releaseIfOwnedByThisProcess(
  lockPath: string,
  ownPayload: CredentialsLockPayload,
): Promise<void> {
  const current = await readLockPayload(lockPath);
  if (current === null) return;
  if (current.pid !== ownPayload.pid || current.startedAt !== ownPayload.startedAt) return;
  await unlink(lockPath).catch(() => undefined);
}

async function reclaimIfStillStale(
  lockPath: string,
  observed: CredentialsLockPayload | null,
): Promise<void> {
  const current = await readLockPayload(lockPath);
  if (observed === null) {
    if (current !== null) return;
  } else {
    if (current === null) return;
    if (current.pid !== observed.pid || current.startedAt !== observed.startedAt) return;
  }
  await unlink(lockPath).catch(() => undefined);
}

/**
 * Waits up to `timeoutMs` (default 5s — comfortably longer than a single
 * `/v1/auth/refresh` round trip) for exclusive ownership of the credentials file's
 * lock. Returns `null` on timeout OR on any unexpected filesystem error (e.g. an
 * unwritable/nonexistent home dir) rather than throwing — this coordination is a
 * best-effort optimization, not a correctness requirement on its own (see
 * `withCredentialsLock`), so the caller always gets a clear "proceed unlocked"
 * signal instead of a crash.
 */
export async function acquireCredentialsLock(
  homeDir: string,
  options: AcquireCredentialsLockOptions = {},
): Promise<ReleaseCredentialsLock | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const lockPath = lockFilePath(homeDir);
  const payload: CredentialsLockPayload = { pid: process.pid, startedAt: Date.now() };
  const deadline = Date.now() + timeoutMs;

  try {
    await mkdir(homeDir, { recursive: true });

    while (true) {
      const tmpPath = await writeTempPayload(homeDir, payload);
      try {
        await link(tmpPath, lockPath);
        return () => releaseIfOwnedByThisProcess(lockPath, payload);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        const existing = await readLockPayload(lockPath);
        if (existing !== null && isProcessAlive(existing.pid)) {
          if (Date.now() >= deadline) return null;
          await sleep(pollIntervalMs);
          continue;
        }

        // Stale (owner process is dead) or corrupt (can't tell who owns it) —
        // reclaim it and retry the link immediately, same re-check
        // `daemon/lock.ts`'s `reclaimIfStillStale` performs.
        await reclaimIfStillStale(lockPath, existing);
      } finally {
        await unlink(tmpPath).catch(() => undefined);
      }
    }
  } catch {
    return null;
  }
}

/**
 * Runs `fn` under the credentials lock. A timed-out acquire still runs `fn`
 * unlocked rather than failing the whole refresh outright — this lock is a
 * best-effort race eliminator, not a correctness requirement on its own (the
 * server's grace window and `tokenProvider.ts`'s stale-by-one retry are still
 * there as a fallback).
 */
export async function withCredentialsLock<T>(
  homeDir: string,
  fn: () => Promise<T>,
  options?: AcquireCredentialsLockOptions,
): Promise<T> {
  const release = await acquireCredentialsLock(homeDir, options);
  try {
    return await fn();
  } finally {
    if (release) await release();
  }
}
