import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  createEnsureDaemonRunningDeps,
  type EnsureDaemonRunningDeps,
  ensureDaemonRunning,
} from "./ensureDaemonRunning.js";
import { writeDaemonState } from "./state.js";

function noopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function buildDeps(
  homeDir: string,
  overrides: Partial<EnsureDaemonRunningDeps> = {},
): EnsureDaemonRunningDeps {
  return createEnsureDaemonRunningDeps({
    homeDir,
    version: "0.1.0-test",
    logger: noopLogger(),
    now: () => 1_700_000_000_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    spawnStartSync: vi.fn(),
    killPid: vi.fn(),
    isProcessAlive: () => false,
    fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
    registerShutdownSignals: () => () => {},
    readyTimeoutMs: 300,
    stopWaitTimeoutMs: 200,
    env: {},
    ...overrides,
  });
}

describe("ensureDaemonRunning", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-ensure-daemon-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("spawns a daemon when none is running", async () => {
    const spawnStartSync = vi.fn(() => {
      setTimeout(() => {
        void writeDaemonState(homeDir, {
          pid: process.pid,
          port: 5050,
          version: "0.1.0-test",
          startedAt: 1,
        });
      }, 10);
    });
    const deps = buildDeps(homeDir, { spawnStartSync, isProcessAlive: () => true });

    const result = await ensureDaemonRunning(deps);

    expect(result).toEqual({
      ok: true,
      state: { pid: process.pid, port: 5050, version: "0.1.0-test", startedAt: 1 },
    });
    expect(spawnStartSync).toHaveBeenCalledOnce();
  });

  it("treats a state file naming a dead pid as not running and respawns", async () => {
    await writeDaemonState(homeDir, { pid: 999_999, port: 1234, version: "stale", startedAt: 1 });
    const spawnStartSync = vi.fn(() => {
      setTimeout(() => {
        void writeDaemonState(homeDir, {
          pid: process.pid,
          port: 6060,
          version: "0.1.0-test",
          startedAt: 2,
        });
      }, 10);
    });
    // Only the freshly-spawned pid (this test process) is alive — the pid
    // named by the pre-existing state file is not, mirroring the stale-lock
    // scenario `lock.ts` reclaims.
    const deps = buildDeps(homeDir, {
      spawnStartSync,
      isProcessAlive: (pid) => pid === process.pid,
    });

    const result = await ensureDaemonRunning(deps);

    expect(spawnStartSync).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      state: { pid: process.pid, port: 6060, version: "0.1.0-test", startedAt: 2 },
    });
  });

  it("no-ops when a healthy daemon is already running", async () => {
    await writeDaemonState(homeDir, {
      pid: process.pid,
      port: 4242,
      version: "0.1.0-test",
      startedAt: 1,
    });
    const spawnStartSync = vi.fn();
    const deps = buildDeps(homeDir, { spawnStartSync, isProcessAlive: () => true });

    const result = await ensureDaemonRunning(deps);

    expect(result).toEqual({
      ok: true,
      state: { pid: process.pid, port: 4242, version: "0.1.0-test", startedAt: 1 },
    });
    expect(spawnStartSync).not.toHaveBeenCalled();
  });

  it("reports start-failed when the spawned daemon never becomes ready", async () => {
    const deps = buildDeps(homeDir, {
      spawnStartSync: vi.fn(),
      isProcessAlive: () => false,
      readyTimeoutMs: 60,
    });

    const result = await ensureDaemonRunning(deps);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "start-failed" });
    if (!result.ok && result.reason === "start-failed") {
      expect(result.message).toContain("timed out");
    }
  });

  it("returns disabled without touching the filesystem when KVY_NO_SERVICE=1", async () => {
    const spawnStartSync = vi.fn();
    const deps = buildDeps(homeDir, { spawnStartSync, env: { KVY_NO_SERVICE: "1" } });

    const result = await ensureDaemonRunning(deps);

    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(spawnStartSync).not.toHaveBeenCalled();
  });
});
