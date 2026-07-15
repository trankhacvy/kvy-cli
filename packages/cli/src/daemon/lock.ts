import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DaemonState } from "./state.js";

/**
 * Daemon singleton guard — atomic hard-link lock file with PID payload +
 * stale detection (port of Happy's daemon singleton pattern; design §8,
 * plan.md line 690).
 *
 * Why a hard link and not `open(O_CREAT|O_EXCL)` or a naive
 * read-then-write: `link(src, dest)` fails atomically with `EEXIST` if
 * `dest` already exists, and creating that directory entry is a single
 * filesystem operation — two processes racing to start the daemon can never
 * both observe success. We write our PID payload to a private per-attempt
 * temp file first (an ordinary, non-atomic write, but nobody else can see
 * that name), then hard-link the temp file onto the well-known lock path;
 * success of the link is proof of exclusive ownership. Losers unlink their
 * own temp file and never touch the shared lock path.
 *
 * Stale detection: if the link loses to an existing lock file, read the
 * PID it names and probe it with `kill(pid, 0)` (signal 0 = existence
 * check, no actual signal delivered). A `ESRCH` result means that process
 * is dead — the previous daemon crashed without cleaning up — so the lock
 * is stale and we reclaim it (unlink + retry) instead of blocking forever.
 * An unreadable/corrupt lock file is treated the same way: we can't verify
 * anyone owns it, so we don't let it wedge the system either.
 */

const LOCK_FILE_NAME = "daemon.lock";
const MAX_RECLAIM_ATTEMPTS = 5;

export type DaemonLockPayload = DaemonState;

export interface DaemonLockHandle {
  /** Releases the lock. Safe to call more than once; safe if already gone. */
  release(): Promise<void>;
}

export type AcquireDaemonLockResult =
  | { ok: true; handle: DaemonLockHandle }
  | { ok: false; reason: "held-by-running-process"; existing: DaemonLockPayload }
  | { ok: false; reason: "contended" };

export function lockFilePath(homeDir: string): string {
  return path.join(homeDir, LOCK_FILE_NAME);
}

/**
 * `true` if `pid` names a live process this user can see, `false` if it's
 * dead (or the pid is nonsensical). `EPERM` (process exists, owned by
 * someone else) counts as alive — we must never steal a lock we can't
 * confirm is dead.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockPayload(lockPath: string): Promise<DaemonLockPayload | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pid === "number" &&
      typeof (parsed as Record<string, unknown>).port === "number" &&
      typeof (parsed as Record<string, unknown>).version === "string" &&
      typeof (parsed as Record<string, unknown>).startedAt === "number"
    ) {
      return parsed as DaemonLockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeTempPayload(homeDir: string, payload: DaemonLockPayload): Promise<string> {
  const tmpPath = path.join(
    homeDir,
    `.${LOCK_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(tmpPath, JSON.stringify(payload));
  return tmpPath;
}

export async function acquireDaemonLock(
  homeDir: string,
  payload: DaemonLockPayload,
): Promise<AcquireDaemonLockResult> {
  await mkdir(homeDir, { recursive: true });
  const lockPath = lockFilePath(homeDir);

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
    const tmpPath = await writeTempPayload(homeDir, payload);
    try {
      await link(tmpPath, lockPath);
      return {
        ok: true,
        handle: {
          release: () => unlink(lockPath).catch(() => undefined),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const existing = await readLockPayload(lockPath);
      if (existing !== null && isProcessAlive(existing.pid)) {
        return { ok: false, reason: "held-by-running-process", existing };
      }

      // Stale (owner process is dead) or corrupt (can't tell who owns it) —
      // reclaim it. Another process may be reclaiming the same stale lock
      // concurrently; if our unlink loses that race, the next loop
      // iteration's link attempt will simply fail again and we re-evaluate.
      await unlink(lockPath).catch(() => undefined);
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  return { ok: false, reason: "contended" };
}
