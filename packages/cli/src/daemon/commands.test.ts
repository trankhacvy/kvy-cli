import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SleepInhibitMode, SleepInhibitState } from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { readSettings, updateSettings } from "../persistence.js";
import {
  createDaemonCommandDeps,
  type DaemonCommandDeps,
  runDaemonStart,
  runDaemonStartSync,
  runDaemonStatus,
  runDaemonStop,
} from "./commands.js";
import { acquireDaemonLock, lockFilePath } from "./lock.js";
import { persistSession } from "./sessionsStore.js";
import type { SleepInhibitManager } from "./sleepInhibit.js";
import { readDaemonState, writeDaemonState } from "./state.js";

function noopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function buildDeps(homeDir: string, overrides: Partial<DaemonCommandDeps> = {}): DaemonCommandDeps {
  return createDaemonCommandDeps({
    homeDir,
    version: "0.1.0-test",
    logger: noopLogger(),
    now: () => 1_700_000_000_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    spawnStartSync: vi.fn(),
    killPid: vi.fn(),
    isProcessAlive: () => true,
    fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
    registerShutdownSignals: () => () => {},
    readyTimeoutMs: 300,
    stopWaitTimeoutMs: 200,
    ...overrides,
  });
}

/** Fake sleep-inhibit manager (docs/features/sleep-inhibit.md) recording every `applyMode`/`stop` call into a shared, cross-call-site-ordered `events` array — never spawns anything real. */
function fakeSleepInhibitManager(events: string[]): SleepInhibitManager {
  let mode: SleepInhibitMode = "off";
  return {
    applyMode: (nextMode: SleepInhibitMode): SleepInhibitState => {
      events.push(`applyMode:${nextMode}`);
      mode = nextMode;
      return { supported: true, platform: "darwin", mode, active: mode !== "off" };
    },
    getState: (): SleepInhibitState => ({
      supported: true,
      platform: "darwin",
      mode,
      active: mode !== "off",
    }),
    stop: () => {
      events.push("stop");
    },
  };
}

describe("daemon commands", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-daemon-commands-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  describe("runDaemonStart", () => {
    it("reports already running (without spawning) when state.json names a live pid", async () => {
      await writeDaemonState(homeDir, {
        pid: process.pid,
        port: 4242,
        version: "0.1.0-test",
        startedAt: 1,
      });
      const spawnStartSync = vi.fn();
      const deps = buildDeps(homeDir, { spawnStartSync, isProcessAlive: () => true });

      const result = await runDaemonStart(deps, { noWait: false });

      expect(result).toEqual({
        code: 0,
        message: "falcon daemon: already running (pid " + process.pid + ", port 4242)\n",
      });
      expect(spawnStartSync).not.toHaveBeenCalled();
    });

    it("spawns start-sync and returns immediately with --no-wait", async () => {
      const spawnStartSync = vi.fn();
      const deps = buildDeps(homeDir, { spawnStartSync, isProcessAlive: () => false });

      const result = await runDaemonStart(deps, { noWait: true });

      expect(result.code).toBe(0);
      expect(result.message).toContain("background");
      expect(spawnStartSync).toHaveBeenCalledOnce();
    });

    it("spawns start-sync and waits for daemon.state.json to appear", async () => {
      const spawnStartSync = vi.fn(() => {
        setTimeout(() => {
          void writeDaemonState(homeDir, {
            pid: process.pid,
            port: 5000,
            version: "0.1.0-test",
            startedAt: 1,
          });
        }, 20);
      });
      const deps = buildDeps(homeDir, { spawnStartSync, isProcessAlive: () => true });

      const result = await runDaemonStart(deps, { noWait: false });

      expect(result).toEqual({
        code: 0,
        message: `falcon daemon: started (pid ${process.pid}, port 5000)\n`,
      });
    });

    it("times out when the daemon never becomes ready", async () => {
      const deps = buildDeps(homeDir, { spawnStartSync: vi.fn(), readyTimeoutMs: 60 });

      const result = await runDaemonStart(deps, { noWait: false });

      expect(result.code).toBe(1);
      expect(result.message).toContain("timed out");
    });
  });

  describe("runDaemonStartSync", () => {
    it("acquires the lock, writes state, and cleans up once shutdown is requested", async () => {
      let triggerShutdown: (() => void) | undefined;
      const deps = buildDeps(homeDir, {
        registerShutdownSignals: (onShutdown) => {
          triggerShutdown = onShutdown;
          // Fire shortly after registering, simulating an external stop
          // request without actually touching real OS signals in the test
          // process.
          setTimeout(() => triggerShutdown?.(), 10);
          return () => {
            triggerShutdown = undefined;
          };
        },
      });

      const code = await runDaemonStartSync(deps);

      expect(code).toBe(0);
      expect(await readDaemonState(homeDir)).toBeNull();
      await expect(readFile(lockFilePath(homeDir), "utf8")).rejects.toThrow();
    });

    it("writes a state file naming this process and an OS-assigned port before shutdown", async () => {
      const seenStates: Array<{ pid: number; port: number } | null> = [];
      const deps = buildDeps(homeDir, {
        registerShutdownSignals: (onShutdown) => {
          setTimeout(async () => {
            seenStates.push(await readDaemonState(homeDir));
            onShutdown();
          }, 10);
          return () => {};
        },
      });

      await runDaemonStartSync(deps);

      expect(seenStates).toHaveLength(1);
      expect(seenStates[0]?.pid).toBe(process.pid);
      expect(seenStates[0]?.port).toBeGreaterThan(0);
    });

    it("returns 1 without writing state when another live process already holds the lock", async () => {
      const held = await acquireDaemonLock(homeDir, {
        pid: process.pid,
        port: 9999,
        version: "0.0.1",
        startedAt: 1,
      });
      expect(held.ok).toBe(true);

      const warn = vi.fn();
      const deps = buildDeps(homeDir, { logger: { ...noopLogger(), warn } });

      const code = await runDaemonStartSync(deps);

      expect(code).toBe(1);
      expect(await readDaemonState(homeDir)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("already running"),
        expect.objectContaining({ pid: process.pid }),
      );

      if (held.ok) await held.handle.release();
    });
  });

  describe("runDaemonStartSync — durability (§3.2)", () => {
    it("restores persisted sessions.json before serving any request", async () => {
      await persistSession(homeDir, {
        sessionId: "sess_1",
        provider: "claude-code",
        encryption: {
          encryptionKey: "wrapped-dek",
          seq: 3,
          metadataVersion: 1,
          agentStateVersion: 1,
        },
        savedAt: Date.now(),
      });

      const info = vi.fn();
      const deps = buildDeps(homeDir, {
        logger: { ...noopLogger(), info },
        registerShutdownSignals: (onShutdown) => {
          setTimeout(() => onShutdown(), 10);
          return () => {};
        },
      });

      const code = await runDaemonStartSync(deps);

      expect(code).toBe(0);
      expect(info).toHaveBeenCalledWith(
        "daemon start-sync: restored persisted sessions",
        expect.objectContaining({ count: 1 }),
      );
    });

    it("hands off to a fresh daemon once the bundle is replaced and no sessions are live", async () => {
      const spawnStartSync = vi.fn();
      const deps = buildDeps(homeDir, {
        spawnStartSync,
        heartbeatIntervalMs: 5,
        captureBundleMtimeMs: () => 111,
        hasBundleBeenReplaced: () => true, // pretend the bundle was replaced on the very first tick
        registerShutdownSignals: () => () => {},
      });

      const code = await runDaemonStartSync(deps);

      expect(code).toBe(0);
      expect(spawnStartSync).toHaveBeenCalledOnce();
      expect(await readDaemonState(homeDir)).toBeNull();
    });
  });

  describe("runDaemonStartSync — sleep-inhibit boot re-apply (docs/features/sleep-inhibit.md)", () => {
    it("boots and applies the persisted sleepInhibit mode via the injected fake manager, unconditionally (even with no stored credentials)", async () => {
      await updateSettings((current) => ({ ...current, sleepInhibit: "always" }), { homeDir });
      const events: string[] = [];
      const deps = buildDeps(homeDir, {
        createSleepInhibitManager: () => fakeSleepInhibitManager(events),
        registerShutdownSignals: (onShutdown) => {
          setTimeout(() => onShutdown(), 10);
          return () => {};
        },
      });

      const code = await runDaemonStartSync(deps);

      expect(code).toBe(0);
      expect(events.filter((e) => e.startsWith("applyMode:"))).toEqual(["applyMode:always"]);
    });

    it("defaults to 'off' when settings.json has no sleepInhibit field", async () => {
      const events: string[] = [];
      const deps = buildDeps(homeDir, {
        createSleepInhibitManager: () => fakeSleepInhibitManager(events),
        registerShutdownSignals: (onShutdown) => {
          setTimeout(() => onShutdown(), 10);
          return () => {};
        },
      });

      await runDaemonStartSync(deps);

      expect(events).toContain("applyMode:off");
    });

    it("stops the sleep-inhibit manager BEFORE spawning the replacement daemon in the self-update handoff", async () => {
      const events: string[] = [];
      const deps = buildDeps(homeDir, {
        createSleepInhibitManager: () => fakeSleepInhibitManager(events),
        spawnStartSync: vi.fn(() => events.push("spawnStartSync")),
        heartbeatIntervalMs: 5,
        captureBundleMtimeMs: () => 111,
        hasBundleBeenReplaced: () => true,
        registerShutdownSignals: () => () => {},
      });

      const code = await runDaemonStartSync(deps);

      expect(code).toBe(0);
      const stopIndex = events.indexOf("stop");
      const spawnIndex = events.indexOf("spawnStartSync");
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(spawnIndex).toBeGreaterThan(stopIndex);
    });

    it("the setSleepInhibit persist-only-when-supported invariant round-trips through settings.json", async () => {
      // Mirrors (in isolation) the exact `setSleepInhibit` closure
      // `runDaemonStartSync` wires into `MachineIntegrationDeps` — the real
      // closure, reached over a real sealed socket RPC round trip, is
      // proven end-to-end in commands.machineWiring.integration.test.ts's
      // "sleepInhibit.set persists to settings.json" case.
      const manager = fakeSleepInhibitManager([]);
      const setSleepInhibit = async ({ mode }: { mode: SleepInhibitMode }) => {
        const state = manager.applyMode(mode);
        if (state.supported) {
          await updateSettings((current) => ({ ...current, sleepInhibit: mode }), { homeDir });
        }
        return state;
      };

      const result = await setSleepInhibit({ mode: "onPower" });

      expect(result).toEqual({
        supported: true,
        platform: "darwin",
        mode: "onPower",
        active: true,
      });
      expect((await readSettings({ homeDir })).sleepInhibit).toBe("onPower");
    });
  });

  describe("runDaemonStop", () => {
    it("reports not running when no state file exists", async () => {
      const deps = buildDeps(homeDir);

      const result = await runDaemonStop(deps);

      expect(result).toEqual({ code: 0, message: "falcon daemon: not running\n" });
    });

    it("clears stale state when the pid is already dead", async () => {
      await writeDaemonState(homeDir, { pid: 999_999, port: 1234, version: "x", startedAt: 1 });
      const deps = buildDeps(homeDir, { isProcessAlive: () => false });

      const result = await runDaemonStop(deps);

      expect(result).toEqual({
        code: 0,
        message: "falcon daemon: not running (stale state cleared)\n",
      });
      expect(await readDaemonState(homeDir)).toBeNull();
    });

    it("stops gracefully via HTTP /stop without ever sending a signal", async () => {
      await writeDaemonState(homeDir, { pid: process.pid, port: 4242, version: "x", startedAt: 1 });
      let alive = true;
      const fetchImpl = vi.fn(async () => {
        alive = false; // simulate the daemon shutting itself down promptly
        return new Response(null, { status: 200 });
      });
      const killPid = vi.fn();
      const deps = buildDeps(homeDir, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        killPid,
        isProcessAlive: () => alive,
      });

      const result = await runDaemonStop(deps);

      expect(result).toEqual({ code: 0, message: `falcon daemon: stopped (pid ${process.pid})\n` });
      expect(fetchImpl).toHaveBeenCalledWith(
        "http://127.0.0.1:4242/stop",
        expect.objectContaining({ method: "POST" }),
      );
      expect(killPid).not.toHaveBeenCalled();
      expect(await readDaemonState(homeDir)).toBeNull();
    });

    it("falls back to SIGTERM when the control server is unreachable", async () => {
      await writeDaemonState(homeDir, { pid: process.pid, port: 4242, version: "x", startedAt: 1 });
      let alive = true;
      const killPid = vi.fn((_pid: number, signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") alive = false;
      });
      const deps = buildDeps(homeDir, {
        fetchImpl: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
        killPid,
        isProcessAlive: () => alive,
      });

      const result = await runDaemonStop(deps);

      expect(result.code).toBe(0);
      expect(killPid).toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(killPid).not.toHaveBeenCalledWith(process.pid, "SIGKILL");
      expect(await readDaemonState(homeDir)).toBeNull();
    });

    it("escalates to SIGKILL when SIGTERM doesn't take effect in time", async () => {
      await writeDaemonState(homeDir, { pid: process.pid, port: 4242, version: "x", startedAt: 1 });
      const killPid = vi.fn();
      const deps = buildDeps(homeDir, {
        fetchImpl: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
        killPid,
        isProcessAlive: () => true, // never dies on its own
        stopWaitTimeoutMs: 20,
      });

      const result = await runDaemonStop(deps);

      expect(result.code).toBe(0);
      expect(killPid).toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(killPid).toHaveBeenCalledWith(process.pid, "SIGKILL");
      expect(await readDaemonState(homeDir)).toBeNull();
    });
  });

  describe("runDaemonStatus", () => {
    it("reports not running when no state file exists", async () => {
      const deps = buildDeps(homeDir);

      const result = await runDaemonStatus(deps);

      expect(result).toEqual({ code: 1, message: "falcon daemon: not running\n" });
    });

    it("clears and reports not running when the pid is dead", async () => {
      await writeDaemonState(homeDir, { pid: 999_999, port: 1234, version: "x", startedAt: 1 });
      const deps = buildDeps(homeDir, { isProcessAlive: () => false });

      const result = await runDaemonStatus(deps);

      expect(result).toEqual({
        code: 1,
        message: "falcon daemon: not running (stale state cleared)\n",
      });
      expect(await readDaemonState(homeDir)).toBeNull();
    });

    it("reports not running when the pid is alive but the control server is unreachable", async () => {
      await writeDaemonState(homeDir, { pid: process.pid, port: 4242, version: "x", startedAt: 1 });
      const deps = buildDeps(homeDir, {
        isProcessAlive: () => true,
        fetchImpl: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      });

      const result = await runDaemonStatus(deps);

      expect(result.code).toBe(1);
      expect(result.message).toContain("unreachable");
    });

    it("reports running with pid/port/version when the control server responds", async () => {
      await writeDaemonState(homeDir, {
        pid: process.pid,
        port: 4242,
        version: "0.9.9",
        startedAt: 1,
      });
      const deps = buildDeps(homeDir, { isProcessAlive: () => true });

      const result = await runDaemonStatus(deps);

      expect(result).toEqual({
        code: 0,
        message: `falcon daemon: running (pid ${process.pid}, port 4242, version 0.9.9)\n`,
      });
    });
  });
});
