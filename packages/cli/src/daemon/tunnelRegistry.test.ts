import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessEntry } from "./processScan.js";
import {
  appendJournalEntry,
  clearTunnelJournal,
  createTunnelRegistry,
  readTunnelJournal,
  reapOrphanedTunnels,
  removeJournalEntry,
  tunnelsJournalPath,
} from "./tunnelRegistry.js";

class FakeChild extends EventEmitter {
  pid = 12345;
}

describe("createTunnelRegistry", () => {
  it("supports add/get/getByPort/list/remove", () => {
    const registry = createTunnelRegistry();
    const child = new FakeChild() as unknown as import("node:child_process").ChildProcess;
    registry.add({
      tunnelId: "t1",
      port: 3000,
      url: "https://abc.trycloudflare.com",
      pid: 12345,
      startedAt: 1000,
      status: "starting",
      child,
    });

    expect(registry.get("t1")?.port).toBe(3000);
    expect(registry.getByPort(3000)?.tunnelId).toBe("t1");
    expect(registry.getByPort(9999)).toBeUndefined();
    expect(registry.list()).toHaveLength(1);

    registry.setStatus("t1", "active");
    expect(registry.get("t1")?.status).toBe("active");

    registry.remove("t1");
    expect(registry.get("t1")).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });
});

describe("tunnel journal", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-tunnels-test-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("round-trips append/read", async () => {
    await appendJournalEntry(homeDir, { pid: 111, port: 3000, startedAt: 1000 });
    await appendJournalEntry(homeDir, { pid: 222, port: 4000, startedAt: 2000 });

    const entries = await readTunnelJournal(homeDir);
    expect(entries).toEqual([
      { pid: 111, port: 3000, startedAt: 1000 },
      { pid: 222, port: 4000, startedAt: 2000 },
    ]);
  });

  it("writes via tmp-file + atomic rename", async () => {
    await appendJournalEntry(homeDir, { pid: 111, port: 3000, startedAt: 1000 });
    const raw = await readFile(tunnelsJournalPath(homeDir), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.entries).toEqual([{ pid: 111, port: 3000, startedAt: 1000 }]);
  });

  it("removes a single entry, leaving the rest", async () => {
    await appendJournalEntry(homeDir, { pid: 111, port: 3000, startedAt: 1000 });
    await appendJournalEntry(homeDir, { pid: 222, port: 4000, startedAt: 2000 });
    await removeJournalEntry(homeDir, 111);

    expect(await readTunnelJournal(homeDir)).toEqual([{ pid: 222, port: 4000, startedAt: 2000 }]);
  });

  it("removeJournalEntry is a no-op for an unknown pid", async () => {
    await appendJournalEntry(homeDir, { pid: 111, port: 3000, startedAt: 1000 });
    await removeJournalEntry(homeDir, 999);
    expect(await readTunnelJournal(homeDir)).toEqual([{ pid: 111, port: 3000, startedAt: 1000 }]);
  });

  it("clearTunnelJournal truncates and is a no-op when already absent", async () => {
    await appendJournalEntry(homeDir, { pid: 111, port: 3000, startedAt: 1000 });
    await clearTunnelJournal(homeDir);
    expect(await readTunnelJournal(homeDir)).toEqual([]);
    // Calling again with no file present must not throw.
    await expect(clearTunnelJournal(homeDir)).resolves.toBeUndefined();
  });

  it("readTunnelJournal resolves [] for a missing/corrupt file", async () => {
    expect(await readTunnelJournal(path.join(homeDir, "does-not-exist"))).toEqual([]);
  });
});

describe("reapOrphanedTunnels", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-tunnels-reap-test-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function fakeDeps(overrides: {
    processes: ProcessEntry[];
    aliveByPid?: Record<number, boolean>;
  }) {
    const killPid = vi.fn();
    const isAlive = vi.fn((pid: number) => overrides.aliveByPid?.[pid] ?? true);
    return {
      listProcesses: vi.fn().mockResolvedValue(overrides.processes),
      killPid,
      isAlive,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn().mockReturnValue(0),
      gracefulTimeoutMs: 5000,
    };
  }

  it("is a no-op when the journal is empty", async () => {
    const deps = fakeDeps({ processes: [] });
    await reapOrphanedTunnels(homeDir, deps);
    expect(deps.listProcesses).not.toHaveBeenCalled();
  });

  it("kills a live journaled pid whose scanned command matches cloudflared", async () => {
    await appendJournalEntry(homeDir, { pid: 500, port: 3000, startedAt: 1000 });
    // Alive at the pre-kill liveness check, then reports dead once
    // `waitForExit` polls it after SIGTERM was sent.
    let aliveCallCount = 0;
    const deps = {
      listProcesses: vi
        .fn()
        .mockResolvedValue([
          { pid: 500, ppid: 1, command: "cloudflared tunnel --url http://localhost:3000" },
        ]),
      killPid: vi.fn(),
      isAlive: vi.fn(() => {
        aliveCallCount += 1;
        return aliveCallCount === 1;
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn().mockReturnValue(0),
      gracefulTimeoutMs: 5000,
    };

    await reapOrphanedTunnels(homeDir, deps);

    expect(deps.killPid).toHaveBeenCalledWith(500, "SIGTERM");
    expect(deps.killPid).not.toHaveBeenCalledWith(500, "SIGKILL");
    expect(await readTunnelJournal(homeDir)).toEqual([]);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM past the deadline", async () => {
    await appendJournalEntry(homeDir, { pid: 501, port: 3001, startedAt: 1000 });
    let calls = 0;
    const now = vi.fn(() => {
      calls += 1;
      return calls * 10_000; // jump straight past the 5s deadline on the second read
    });
    const deps = {
      listProcesses: vi
        .fn()
        .mockResolvedValue([{ pid: 501, ppid: 1, command: "cloudflared tunnel --url ..." }]),
      killPid: vi.fn(),
      isAlive: vi.fn().mockReturnValue(true), // always alive -> stubborn child
      sleep: vi.fn().mockResolvedValue(undefined),
      now,
      gracefulTimeoutMs: 5000,
    };

    await reapOrphanedTunnels(homeDir, deps);

    expect(deps.killPid).toHaveBeenCalledWith(501, "SIGTERM");
    expect(deps.killPid).toHaveBeenCalledWith(501, "SIGKILL");
  });

  it("skips a recycled pid running something else entirely, and drops it from the journal", async () => {
    await appendJournalEntry(homeDir, { pid: 502, port: 3002, startedAt: 1000 });
    const deps = fakeDeps({
      processes: [{ pid: 502, ppid: 1, command: "some-other-unrelated-process" }],
    });

    await reapOrphanedTunnels(homeDir, deps);

    expect(deps.killPid).not.toHaveBeenCalled();
    expect(await readTunnelJournal(homeDir)).toEqual([]);
  });

  it("skips an already-dead pid without touching listProcesses' result for it", async () => {
    await appendJournalEntry(homeDir, { pid: 503, port: 3003, startedAt: 1000 });
    const deps = fakeDeps({ processes: [], aliveByPid: { 503: false } });

    await reapOrphanedTunnels(homeDir, deps);

    expect(deps.killPid).not.toHaveBeenCalled();
    expect(await readTunnelJournal(homeDir)).toEqual([]);
  });

  it("truncates the journal even when multiple entries are handled differently", async () => {
    await appendJournalEntry(homeDir, { pid: 601, port: 3000, startedAt: 1000 });
    await appendJournalEntry(homeDir, { pid: 602, port: 3001, startedAt: 1000 });
    const deps = fakeDeps({
      processes: [{ pid: 601, ppid: 1, command: "cloudflared tunnel --url ..." }],
      aliveByPid: { 601: false, 602: false },
    });

    await reapOrphanedTunnels(homeDir, deps);

    expect(await readTunnelJournal(homeDir)).toEqual([]);
  });
});
