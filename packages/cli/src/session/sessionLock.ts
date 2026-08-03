/**
 * durability neighbor): before `commands/start.ts` mints a fresh session
 * nonce, it takes an exclusive, per-`(machineId, workspacePath)` lock file at
 * `~/.kvy/locks/session-<sha256(machineId|path)>.lock` — if a *live* pid
 * already holds it, a second `kvy claude` in the same directory refuses to
 * start a second, independent PTY writing into the same workspace (the two
 * processes would otherwise silently fork the transcript). `--force-new-session`
 * bypasses the check entirely.
 *
 * Same atomic hard-link + stale-pid-reclaim pattern as `daemon/lock.ts`'s
 * `acquireDaemonLock` (see that file's doc comment for the full "why a hard
 * link" rationale), generalized here for a
 * `SessionLockPayload` instead of a `DaemonState`, and keyed per-directory
 * rather than singleton-per-machine. Reuses `daemon/lock.ts`'s
 * `isProcessAlive` rather than duplicating it.
 *
 * Unlike the daemon singleton lock, this lock's payload is written in two
 * steps: the acquiring process doesn't know its own `sessionId` yet at
 * acquire time (the whole point is to lock the directory *before* the
 * network round trip that mints/reuses one) — `handle.updateSessionId()`
 * rewrites the payload once `bootstrapSession()` resolves, so a *subsequent*
 * contender can print a real session id instead of "unknown". A contender
 * that loses the race against a very-freshly-acquired lock (before its
 * `updateSessionId()` has landed) simply sees `sessionId: null` and prints
 * "unknown" — an honest, narrow, and harmless race window, not a correctness
 * bug.
 */
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "../daemon/lock.js";

const LOCKS_DIR_NAME = "locks";
const MAX_RECLAIM_ATTEMPTS = 5;

export interface SessionLockPayload {
  pid: number;
  /** `null` until the acquiring process's `bootstrapSession()` resolves. */
  sessionId: string | null;
  startedAt: number;
}

export interface SessionLockHandle {
  /**
   * Releases the lock. Safe to call more than once; safe if already gone.
   * Only unlinks if the lock file still names *this* acquisition (pid +
   * startedAt) — mirrors `daemon/lock.ts`'s `release()` guard.
   */
  release(): Promise<void>;
  /**
   * Rewrites the lock file's `sessionId` once it's known (after
   * `bootstrapSession()` resolves), so a subsequent contender can report a
   * real id instead of "unknown". A no-op (does not throw) if this
   * acquisition no longer owns the lock — an update racing a stale reclaim
   * has nothing useful left to update.
   */
  updateSessionId(sessionId: string): Promise<void>;
}

export type AcquireSessionLockResult =
  | { ok: true; handle: SessionLockHandle }
  | { ok: false; reason: "held-by-running-process"; existing: SessionLockPayload }
  | { ok: false; reason: "contended" };

export interface SessionLockKey {
  machineId: string;
  workspacePath: string;
}

/**
 * `sha256(machineId | 0x00 | workspacePath)`, hex-encoded — the NUL separator
 * prevents the same boundary-collision class `session/bootstrap.ts`'s
 * `buildSessionTag` already guards against.
 */
export function sessionLockKey(key: SessionLockKey): string {
  return createHash("sha256")
    .update(key.machineId)
    .update("\x00")
    .update(key.workspacePath)
    .digest("hex");
}

export function sessionLockPath(homeDir: string, key: SessionLockKey): string {
  return path.join(homeDir, LOCKS_DIR_NAME, `session-${sessionLockKey(key)}.lock`);
}

async function readLockPayload(lockPath: string): Promise<SessionLockPayload | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pid === "number" &&
      typeof (parsed as Record<string, unknown>).startedAt === "number" &&
      ((parsed as Record<string, unknown>).sessionId === null ||
        typeof (parsed as Record<string, unknown>).sessionId === "string")
    ) {
      return parsed as SessionLockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeTempPayload(locksDir: string, payload: SessionLockPayload): Promise<string> {
  const tmpPath = path.join(
    locksDir,
    `.session.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(tmpPath, JSON.stringify(payload));
  return tmpPath;
}

/**
 * Unlinks `lockPath` only if it still holds the payload this acquisition
 * wrote (pid + startedAt) — guards against deleting a new owner's lock after
 * a stale reclaim, same reasoning as `daemon/lock.ts`'s
 * `releaseIfOwnedByThisProcess`.
 */
async function releaseIfOwnedByThisProcess(
  lockPath: string,
  ownPayload: SessionLockPayload,
): Promise<void> {
  const current = await readLockPayload(lockPath);
  if (current === null) return;
  if (current.pid !== ownPayload.pid || current.startedAt !== ownPayload.startedAt) return;
  await unlink(lockPath).catch(() => undefined);
}

/**
 * Reclaims `lockPath` only if it still names the exact stale/corrupt payload
 * just diagnosed (`observed`, or `null` for "was unparseable") — same
 * re-check `daemon/lock.ts`'s `reclaimIfStillStale` performs, narrowing the
 * window where two contenders could both decide to reclaim the same dead
 * lock.
 */
async function reclaimIfStillStale(
  lockPath: string,
  observed: SessionLockPayload | null,
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
 * Rewrites the lock file's `sessionId` in place (tmp-write + rename, atomic
 * on POSIX) — only if it still names this acquisition's pid + startedAt.
 */
async function updatePayloadIfOwnedByThisProcess(
  lockPath: string,
  locksDir: string,
  ownPayload: SessionLockPayload,
  sessionId: string,
): Promise<void> {
  const current = await readLockPayload(lockPath);
  if (current === null) return;
  if (current.pid !== ownPayload.pid || current.startedAt !== ownPayload.startedAt) return;

  const updated: SessionLockPayload = { ...ownPayload, sessionId };
  const tmpPath = path.join(
    locksDir,
    `.session.${process.pid}.${randomBytes(6).toString("hex")}.update.tmp`,
  );
  await writeFile(tmpPath, JSON.stringify(updated));
  await rename(tmpPath, lockPath);
}

/**
 * Acquires the per-directory session lock. `ok: false, reason:
 * "held-by-running-process"` means a live process already owns this
 * directory's session — the caller should print `existing.sessionId` (or
 * "unknown" if still `null`) and exit rather than start a second PTY here.
 * Stale (dead-pid) or corrupt locks are reclaimed transparently, same as
 * `daemon/lock.ts`'s singleton guard.
 */
export async function acquireSessionLock(
  homeDir: string,
  key: SessionLockKey,
  payload: SessionLockPayload,
): Promise<AcquireSessionLockResult> {
  const locksDir = path.join(homeDir, LOCKS_DIR_NAME);
  await mkdir(locksDir, { recursive: true });
  const lockPath = sessionLockPath(homeDir, key);

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
    const tmpPath = await writeTempPayload(locksDir, payload);
    try {
      await link(tmpPath, lockPath);
      return {
        ok: true,
        handle: {
          release: () => releaseIfOwnedByThisProcess(lockPath, payload),
          updateSessionId: (sessionId: string) =>
            updatePayloadIfOwnedByThisProcess(lockPath, locksDir, payload, sessionId),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const existing = await readLockPayload(lockPath);
      if (existing !== null && isProcessAlive(existing.pid)) {
        return { ok: false, reason: "held-by-running-process", existing };
      }

      // Stale (owner process is dead) or corrupt (can't tell who owns it) —
      // reclaim it, re-checking immediately before unlinking (see
      // `reclaimIfStillStale`'s doc comment).
      await reclaimIfStillStale(lockPath, existing);
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  return { ok: false, reason: "contended" };
}
