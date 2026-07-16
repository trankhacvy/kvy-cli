import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeDoctorCleanSummary,
  describeDoctorReport,
  runDoctor,
  runDoctorClean,
} from "./doctor.js";
import type { KillDeps } from "./kill.js";
import type { ProcessEntry } from "./processScan.js";
import { persistSession } from "./sessionsStore.js";
import { writeDaemonState } from "./state.js";

const FIXTURE_PROCESSES: ProcessEntry[] = [
  { pid: 1, ppid: 0, command: "/sbin/launchd" },
  { pid: 100, ppid: 1, command: "falcon daemon start-sync" },
  { pid: 200, ppid: 100, command: "falcon claude --starting-mode remote --started-by daemon" },
  { pid: 300, ppid: 1, command: "falcon claude --resume abc" },
  { pid: 999, ppid: 1, command: "falcon doctor" }, // the invoking process
];

describe("runDoctor", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-doctor-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("reports daemon not running and zero resumable sessions when nothing is present", async () => {
    const report = await runDoctor({
      homeDir,
      listProcesses: async () => [],
      isProcessAlive: () => false,
      currentPid: 999,
    });

    expect(report.daemon).toEqual({ running: false });
    expect(report.resumableSessionCount).toBe(0);
    expect(report.processes).toEqual([]);
  });

  it("reports a running daemon and classifies every Falcon-owned process, excluding the current pid", async () => {
    await writeDaemonState(homeDir, { pid: 100, port: 4242, version: "0.1.0", startedAt: 1 });
    await persistSession(homeDir, {
      sessionId: "sess_1",
      encryption: { encryptionKey: "k", seq: 1, metadataVersion: 1, agentStateVersion: 1 },
      savedAt: Date.now(),
    });

    const report = await runDoctor({
      homeDir,
      listProcesses: async () => FIXTURE_PROCESSES,
      isProcessAlive: (pid) => pid === 100,
      currentPid: 999,
    });

    expect(report.daemon).toEqual({ running: true, pid: 100, port: 4242, version: "0.1.0" });
    expect(report.resumableSessionCount).toBe(1);
    expect(report.processes.map((p) => p.pid)).toEqual([100, 200, 300]);
  });

  it("treats a stale daemon.state.json (dead pid) as not running", async () => {
    await writeDaemonState(homeDir, { pid: 100, port: 4242, version: "0.1.0", startedAt: 1 });

    const report = await runDoctor({
      homeDir,
      listProcesses: async () => [],
      isProcessAlive: () => false,
      currentPid: 999,
    });

    expect(report.daemon).toEqual({ running: false });
  });
});

describe("describeDoctorReport", () => {
  it("renders a running daemon, resumable count, and every process line", () => {
    const text = describeDoctorReport({
      daemon: { running: true, pid: 100, port: 4242, version: "0.1.0" },
      resumableSessionCount: 2,
      processes: [
        { pid: 200, ppid: 100, command: "falcon claude", kind: "session", spawnedByDaemon: true },
      ],
    });

    expect(text).toContain("daemon: running (pid 100, port 4242, version 0.1.0)");
    expect(text).toContain("resumable sessions (sessions.json): 2");
    expect(text).toContain("pid 200 [session] [daemon-spawned] — falcon claude");
  });

  it("renders a friendly message when no processes are found", () => {
    const text = describeDoctorReport({
      daemon: { running: false },
      resumableSessionCount: 0,
      processes: [],
    });

    expect(text).toContain("daemon: not running");
    expect(text).toContain("no falcon-owned processes found");
  });
});

function makeKillDeps(overrides: Partial<KillDeps> = {}): KillDeps {
  return {
    listProcesses: async () => FIXTURE_PROCESSES,
    killPid: vi.fn(),
    isAlive: () => false,
    sleep: async () => {},
    now: () => 0,
    currentPid: 999,
    ...overrides,
  };
}

describe("runDoctorClean", () => {
  it("targets only daemon processes and daemon-spawned sessions, not plain terminal sessions", async () => {
    const killPid = vi.fn();
    const summary = await runDoctorClean(makeKillDeps({ killPid }), 50);

    expect(summary.targeted.map((p) => p.pid).sort()).toEqual([100, 200]);
    expect(killPid).toHaveBeenCalledWith(100, "SIGTERM");
    expect(killPid).toHaveBeenCalledWith(200, "SIGTERM");
    expect(killPid).not.toHaveBeenCalledWith(300, expect.anything());
  });

  it("reports no runaway processes found when there's nothing to target", async () => {
    const summary = await runDoctorClean(makeKillDeps({ listProcesses: async () => [] }), 50);
    expect(summary.targeted).toEqual([]);
    expect(describeDoctorCleanSummary(summary)).toBe(
      "falcon doctor clean: no runaway processes found\n",
    );
  });
});

describe("describeDoctorCleanSummary", () => {
  it("summarizes success/failure counts per pid", () => {
    const text = describeDoctorCleanSummary({
      targeted: [
        { pid: 100, ppid: 1, command: "falcon daemon start-sync", kind: "daemon", spawnedByDaemon: false },
      ],
      outcomes: [
        { pid: 100, command: "falcon daemon start-sync", kind: "daemon", signal: "SIGTERM" },
      ],
    });

    expect(text).toContain("falcon doctor clean: 1/1 runaway process(es) terminated");
    expect(text).toContain("pid 100 [daemon] SIGTERM — falcon daemon start-sync");
  });
});
