import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive } from "../daemon/lock.js";
import type { SessionLockPayload } from "./sessionLock.js";
import { acquireSessionLock, sessionLockKey, sessionLockPath } from "./sessionLock.js";

const KEY = { machineId: "machine-1", workspacePath: "/repo/workdir" };

function payload(overrides: Partial<SessionLockPayload> = {}): SessionLockPayload {
  return { pid: process.pid, sessionId: null, startedAt: Date.now(), ...overrides };
}

/** Spawns and waits for a real process to exit, returning its now-dead pid. */
async function spawnAndReapDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  if (pid === undefined) throw new Error("failed to spawn helper process for dead-pid test");
  return pid;
}

describe("sessionLockKey / sessionLockPath", () => {
  it("is deterministic for the same machineId+workspacePath pair", () => {
    expect(sessionLockKey(KEY)).toBe(sessionLockKey({ ...KEY }));
  });

  it("differs across machineId or workspacePath", () => {
    expect(sessionLockKey(KEY)).not.toBe(sessionLockKey({ ...KEY, machineId: "machine-2" }));
    expect(sessionLockKey(KEY)).not.toBe(sessionLockKey({ ...KEY, workspacePath: "/other" }));
  });

  it("never collides across a machineId/workspacePath boundary shift", () => {
    // "a" + "bc" must not collide with "ab" + "c" — the NUL separator guard.
    const left = sessionLockKey({ machineId: "a", workspacePath: "bc" });
    const right = sessionLockKey({ machineId: "ab", workspacePath: "c" });
    expect(left).not.toBe(right);
  });

  it("lives under homeDir/locks/session-<hash>.lock", () => {
    const p = sessionLockPath("/fake/home", KEY);
    expect(p).toBe(path.join("/fake/home", "locks", `session-${sessionLockKey(KEY)}.lock`));
  });
});

describe("acquireSessionLock", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-session-lock-"));
    // A few tests seed a pre-existing lock file directly (bypassing
    // `acquireSessionLock`, which would otherwise create this directory
    // itself) to simulate a stale/corrupt lock left by a prior process.
    await mkdir(path.join(homeDir, "locks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("acquires the lock when none exists", async () => {
    const result = await acquireSessionLock(homeDir, KEY, payload());
    expect(result.ok).toBe(true);
    await expect(readFile(sessionLockPath(homeDir, KEY), "utf8")).resolves.toContain(
      String(process.pid),
    );
  });

  it("refuses a second acquire while the first holder is alive, reporting its payload", async () => {
    const first = await acquireSessionLock(homeDir, KEY, payload({ sessionId: "sess_1" }));
    expect(first.ok).toBe(true);

    const second = await acquireSessionLock(homeDir, KEY, payload({ sessionId: "sess_2" }));
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === "held-by-running-process") {
      expect(second.existing.sessionId).toBe("sess_1");
      expect(second.existing.pid).toBe(process.pid);
    } else {
      throw new Error("expected held-by-running-process");
    }

    if (first.ok) await first.handle.release();
  });

  it("reclaims a lock left by a dead process (stale-detect)", async () => {
    const deadPid = await spawnAndReapDeadPid();
    expect(isProcessAlive(deadPid)).toBe(false);

    await writeFile(
      sessionLockPath(homeDir, KEY),
      JSON.stringify({ pid: deadPid, sessionId: "sess_stale", startedAt: 1 }),
    );

    const result = await acquireSessionLock(homeDir, KEY, payload({ sessionId: "sess_fresh" }));
    expect(result.ok).toBe(true);
    await expect(readFile(sessionLockPath(homeDir, KEY), "utf8")).resolves.toContain("sess_fresh");
  });

  it("reclaims a corrupt/unparseable lock file", async () => {
    await writeFile(sessionLockPath(homeDir, KEY), "not valid json{{{", "utf8");

    const result = await acquireSessionLock(homeDir, KEY, payload());
    expect(result.ok).toBe(true);
  });

  it("release() removes the lock so a subsequent acquire succeeds", async () => {
    const first = await acquireSessionLock(homeDir, KEY, payload());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await first.handle.release();

    const second = await acquireSessionLock(homeDir, KEY, payload());
    expect(second.ok).toBe(true);
  });

  it("release() is a no-op if the lock was already reclaimed by a new owner", async () => {
    const deadPid = await spawnAndReapDeadPid();
    const stalePayload = payload({ pid: deadPid, sessionId: "sess_stale" });
    await writeFile(sessionLockPath(homeDir, KEY), JSON.stringify(stalePayload));

    const reclaimer = await acquireSessionLock(
      homeDir,
      KEY,
      payload({ sessionId: "sess_new", startedAt: 999 }),
    );
    expect(reclaimer.ok).toBe(true);

    // The original (now-stale) "owner" calling release() must not delete the
    // reclaimer's lock out from under it.
    const staleHandleRelease = async (): Promise<void> => {
      const current = await readFile(sessionLockPath(homeDir, KEY), "utf8");
      expect(JSON.parse(current).sessionId).toBe("sess_new");
    };
    await staleHandleRelease();
  });

  it("a real stale handle's own release() does not delete a subsequent reclaimer's lock", async () => {
    // Unlike the previous test (which seeds the stale payload directly on
    // disk and so never actually exercises a handle's `release()` at all),
    // this one acquires through the real `acquireSessionLock()` path first,
    // so `stale.handle.release()` below is the actual guarded call.
    const deadPid = await spawnAndReapDeadPid();
    const stale = await acquireSessionLock(homeDir, KEY, payload({ pid: deadPid }));
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;

    const reclaimer = await acquireSessionLock(homeDir, KEY, payload({ sessionId: "sess_new" }));
    expect(reclaimer.ok).toBe(true);
    if (!reclaimer.ok) return;

    await stale.handle.release();
    await expect(readFile(sessionLockPath(homeDir, KEY), "utf8")).resolves.toContain("sess_new");

    await reclaimer.handle.release();
  });

  it("updateSessionId() rewrites the payload so a later contender sees the real session id", async () => {
    const first = await acquireSessionLock(homeDir, KEY, payload({ sessionId: null }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await first.handle.updateSessionId("sess_real");

    const second = await acquireSessionLock(homeDir, KEY, payload({ sessionId: "sess_contender" }));
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === "held-by-running-process") {
      expect(second.existing.sessionId).toBe("sess_real");
    } else {
      throw new Error("expected held-by-running-process");
    }

    await first.handle.release();
  });

  it("updateSessionId() is a harmless no-op once the lock has been released", async () => {
    const first = await acquireSessionLock(homeDir, KEY, payload());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await first.handle.release();
    await expect(first.handle.updateSessionId("sess_after_release")).resolves.toBeUndefined();
  });
});
