import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonLockPayload } from "./lock.js";
import { acquireDaemonLock, isProcessAlive, lockFilePath } from "./lock.js";

function payload(overrides: Partial<DaemonLockPayload> = {}): DaemonLockPayload {
  return { pid: process.pid, port: 4200, version: "0.1.0", startedAt: Date.now(), ...overrides };
}

/** Spawns and waits for a real process to exit, returning its now-dead pid. */
async function spawnAndReapDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  if (pid === undefined) throw new Error("failed to spawn helper process for dead-pid test");
  return pid;
}

describe("acquireDaemonLock", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-daemon-lock-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("acquires the lock when none exists", async () => {
    const result = await acquireDaemonLock(homeDir, payload());
    expect(result.ok).toBe(true);
    await expect(readFile(lockFilePath(homeDir), "utf8")).resolves.toContain(String(process.pid));
  });

  it("refuses a second acquire while the first holder is alive", async () => {
    const first = await acquireDaemonLock(homeDir, payload({ port: 4200 }));
    expect(first.ok).toBe(true);

    const second = await acquireDaemonLock(homeDir, payload({ port: 4201 }));
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === "held-by-running-process") {
      expect(second.existing.port).toBe(4200);
    } else {
      throw new Error("expected held-by-running-process");
    }

    if (first.ok) await first.handle.release();
  });

  it("reclaims a lock left by a dead process (stale-detect)", async () => {
    const deadPid = await spawnAndReapDeadPid();
    expect(isProcessAlive(deadPid)).toBe(false);

    await writeFile(
      lockFilePath(homeDir),
      JSON.stringify({ pid: deadPid, port: 9999, version: "0.0.1", startedAt: 1 }),
    );

    const result = await acquireDaemonLock(homeDir, payload({ port: 5000 }));
    expect(result.ok).toBe(true);
    await expect(readFile(lockFilePath(homeDir), "utf8")).resolves.toContain("5000");
  });

  it("reclaims a corrupt/unparseable lock file", async () => {
    await writeFile(lockFilePath(homeDir), "not valid json{{{", "utf8");

    const result = await acquireDaemonLock(homeDir, payload({ port: 5001 }));
    expect(result.ok).toBe(true);
  });

  it("release() removes the lock so a subsequent acquire succeeds", async () => {
    const first = await acquireDaemonLock(homeDir, payload());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await first.handle.release();

    const second = await acquireDaemonLock(homeDir, payload({ port: 4300 }));
    expect(second.ok).toBe(true);
  });

  it("release() is safe to call twice", async () => {
    const first = await acquireDaemonLock(homeDir, payload());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await first.handle.release();
    await expect(first.handle.release()).resolves.toBeUndefined();
  });

  it("under concurrent acquire attempts, exactly one wins the race", async () => {
    const attempts = Array.from({ length: 12 }, (_, i) =>
      acquireDaemonLock(homeDir, payload({ port: 6000 + i })),
    );
    const results = await Promise.all(attempts);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(11);
    for (const loser of losers) {
      if (!loser.ok) expect(loser.reason).toBe("held-by-running-process");
    }
  });
});

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for pid 0 and negative/non-integer pids", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it("returns false for a pid that has already exited", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid;
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(pid).toBeDefined();
    if (pid !== undefined) expect(isProcessAlive(pid)).toBe(false);
  });
});
