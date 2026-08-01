import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive } from "../daemon/lock.js";
import { acquireCredentialsLock, lockFilePath, withCredentialsLock } from "./credentialsLock.js";

/** Spawns and waits for a real process to exit, returning its now-dead pid. */
async function spawnAndReapDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  if (pid === undefined) throw new Error("failed to spawn helper process for dead-pid test");
  return pid;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("acquireCredentialsLock", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-credentials-lock-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("acquires the lock when none exists", async () => {
    const release = await acquireCredentialsLock(homeDir);
    expect(release).not.toBeNull();
    await expect(readFile(lockFilePath(homeDir), "utf8")).resolves.toContain(String(process.pid));
    if (release) await release();
  });

  it("release() removes the lock so a subsequent acquire succeeds immediately", async () => {
    const release = await acquireCredentialsLock(homeDir);
    expect(release).not.toBeNull();
    if (release) await release();

    const second = await acquireCredentialsLock(homeDir);
    expect(second).not.toBeNull();
    if (second) await second();
  });

  it("release() is safe to call twice", async () => {
    const release = await acquireCredentialsLock(homeDir);
    expect(release).not.toBeNull();
    if (!release) return;
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it("a contended acquire waits for the holder to release, instead of failing immediately", async () => {
    const first = await acquireCredentialsLock(homeDir);
    expect(first).not.toBeNull();

    const secondPromise = acquireCredentialsLock(homeDir, { pollIntervalMs: 10 });
    let secondResolved = false;
    void secondPromise.then(() => {
      secondResolved = true;
    });

    await sleep(50);
    expect(secondResolved).toBe(false); // still waiting on the first holder

    if (first) await first();
    const second = await secondPromise;
    expect(second).not.toBeNull();
    if (second) await second();
  });

  it("times out and returns null if the holder never releases within timeoutMs", async () => {
    const first = await acquireCredentialsLock(homeDir);
    expect(first).not.toBeNull();

    const second = await acquireCredentialsLock(homeDir, { timeoutMs: 50, pollIntervalMs: 10 });
    expect(second).toBeNull();

    if (first) await first();
  });

  it("reclaims a lock left by a dead process (stale-detect)", async () => {
    const deadPid = await spawnAndReapDeadPid();
    expect(isProcessAlive(deadPid)).toBe(false);

    await writeFile(lockFilePath(homeDir), JSON.stringify({ pid: deadPid, startedAt: 1 }));

    const release = await acquireCredentialsLock(homeDir);
    expect(release).not.toBeNull();
    await expect(readFile(lockFilePath(homeDir), "utf8")).resolves.toContain(String(process.pid));
    if (release) await release();
  });

  it("reclaims a corrupt/unparseable lock file", async () => {
    await writeFile(lockFilePath(homeDir), "not valid json{{{", "utf8");

    const release = await acquireCredentialsLock(homeDir);
    expect(release).not.toBeNull();
    if (release) await release();
  });

  it("under concurrent acquire attempts, exactly one wins immediately and the rest queue up and eventually all succeed", async () => {
    const attempts = Array.from({ length: 8 }, () =>
      acquireCredentialsLock(homeDir, { pollIntervalMs: 5 }),
    );
    const releases = await Promise.all(
      attempts.map(async (attemptPromise) => {
        const release = await attemptPromise;
        if (release) await release();
        return release;
      }),
    );
    expect(releases.every((release) => release !== null)).toBe(true);
  });
});

describe("withCredentialsLock", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-credentials-lock-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("runs fn under the lock and releases it afterward", async () => {
    let ranWhileLocked = false;
    await withCredentialsLock(homeDir, async () => {
      const contended = await acquireCredentialsLock(homeDir, { timeoutMs: 10, pollIntervalMs: 5 });
      ranWhileLocked = contended === null;
    });

    expect(ranWhileLocked).toBe(true);
    const afterRelease = await acquireCredentialsLock(homeDir, { timeoutMs: 10 });
    expect(afterRelease).not.toBeNull();
    if (afterRelease) await afterRelease();
  });

  it("still runs fn (unlocked) when acquiring the lock times out", async () => {
    const first = await acquireCredentialsLock(homeDir);
    expect(first).not.toBeNull();

    let ran = false;
    const result = await withCredentialsLock(
      homeDir,
      async () => {
        ran = true;
        return "done";
      },
      { timeoutMs: 20, pollIntervalMs: 5 },
    );

    expect(ran).toBe(true);
    expect(result).toBe("done");
    if (first) await first();
  });

  it("releases the lock even if fn throws", async () => {
    await expect(
      withCredentialsLock(homeDir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const afterThrow = await acquireCredentialsLock(homeDir, { timeoutMs: 10 });
    expect(afterThrow).not.toBeNull();
    if (afterThrow) await afterThrow();
  });
});
