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

/** Fake adapter/provider deps — every `runDoctor()` call below injects these so tests never touch a real `~/.falcon/adapters` install or shell out to a real `claude`/`codex`/`cloudflared` on PATH. */
const FAKE_HEALTH_DEPS = {
  checkAdapters: async () => [],
  detectClaudeProvider: async () => ({
    installed: false,
    authenticated: false,
    error: "not installed",
  }),
  detectCodexProvider: async () => ({
    installed: false,
    authenticated: false,
    error: "not installed",
  }),
  detectCloudflaredBinary: async () => ({ installed: false }),
};

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
      ...FAKE_HEALTH_DEPS,
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
      ...FAKE_HEALTH_DEPS,
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
      ...FAKE_HEALTH_DEPS,
    });

    expect(report.daemon).toEqual({ running: false });
  });

  it("includes adapter health and provider CLI detection in the report", async () => {
    const report = await runDoctor({
      homeDir,
      listProcesses: async () => [],
      isProcessAlive: () => false,
      currentPid: 999,
      checkAdapters: async () => [
        {
          id: "claude-code",
          label: "Claude Code",
          packageName: "@agentclientprotocol/claude-agent-acp",
          pinnedVersion: "0.59.0",
          status: "ok",
        },
      ],
      detectClaudeProvider: async () => ({
        installed: true,
        authenticated: true,
        version: "2.1.0",
      }),
      detectCodexProvider: async () => ({
        installed: false,
        authenticated: false,
        error: "not installed",
      }),
      detectCloudflaredBinary: async () => ({ installed: true, version: "2024.6.1" }),
    });

    expect(report.adapters).toEqual([
      {
        id: "claude-code",
        label: "Claude Code",
        packageName: "@agentclientprotocol/claude-agent-acp",
        pinnedVersion: "0.59.0",
        status: "ok",
      },
    ]);
    expect(report.providers.claude).toEqual({
      installed: true,
      authenticated: true,
      version: "2.1.0",
    });
    expect(report.providers.codex.installed).toBe(false);
    expect(report.preview.cloudflared).toEqual({ installed: true, version: "2024.6.1" });
    expect(report.preview.tunnels).toEqual([]);
  });

  it("includes journaled tunnels annotated with a fresh alive/dead check", async () => {
    const { appendJournalEntry } = await import("./tunnelRegistry.js");
    await appendJournalEntry(homeDir, { pid: 7001, port: 3000, startedAt: 1000 });
    await appendJournalEntry(homeDir, { pid: 7002, port: 3001, startedAt: 2000 });

    const report = await runDoctor({
      homeDir,
      listProcesses: async () => [],
      isProcessAlive: (pid) => pid === 7001,
      currentPid: 999,
      ...FAKE_HEALTH_DEPS,
    });

    expect(report.preview.tunnels).toEqual([
      { pid: 7001, port: 3000, startedAt: 1000, alive: true },
      { pid: 7002, port: 3001, startedAt: 2000, alive: false },
    ]);
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
      adapters: [
        {
          id: "claude-code",
          label: "Claude Code",
          packageName: "@agentclientprotocol/claude-agent-acp",
          pinnedVersion: "0.59.0",
          status: "ok",
        },
        {
          id: "codex",
          label: "Codex",
          packageName: "@agentclientprotocol/codex-acp",
          pinnedVersion: "1.1.4",
          status: "not-installed",
        },
      ],
      providers: {
        claude: { installed: true, authenticated: true, version: "2.1.0" },
        codex: { installed: false, authenticated: false, error: "not installed" },
      },
      preview: {
        cloudflared: { installed: true, version: "2024.6.1" },
        tunnels: [{ pid: 5000, port: 3000, startedAt: 0, alive: true }],
      },
    });

    expect(text).toContain("daemon: running (pid 100, port 4242, version 0.1.0)");
    expect(text).toContain("resumable sessions (sessions.json): 2");
    expect(text).toContain("pid 200 [session] [daemon-spawned] — falcon claude");
    expect(text).toContain("claude-code — @agentclientprotocol/claude-agent-acp@0.59.0: ok");
    expect(text).toContain("codex — @agentclientprotocol/codex-acp@1.1.4: not-installed");
    expect(text).toContain("claude: installed (version 2.1.0)");
    expect(text).toContain("codex: not installed");
    expect(text).toContain("cloudflared: installed (version 2024.6.1)");
    expect(text).toContain("pid 5000 port 3000 [alive]");
  });

  it("renders a friendly message when no processes/tunnels are found", () => {
    const text = describeDoctorReport({
      daemon: { running: false },
      resumableSessionCount: 0,
      processes: [],
      adapters: [],
      providers: {
        claude: { installed: false, authenticated: false, error: "not installed" },
        codex: { installed: false, authenticated: false, error: "not installed" },
      },
      preview: { cloudflared: { installed: false }, tunnels: [] },
    });

    expect(text).toContain("daemon: not running");
    expect(text).toContain("no falcon-owned processes found");
    expect(text).toContain("cloudflared: not installed");
    expect(text).toContain("no journaled tunnels");
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
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-doctor-clean-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("targets only daemon processes and daemon-spawned sessions, not plain terminal sessions", async () => {
    const killPid = vi.fn();
    const summary = await runDoctorClean(makeKillDeps({ killPid }), 50, homeDir);

    expect(summary.targeted.map((p) => p.pid).sort()).toEqual([100, 200]);
    expect(killPid).toHaveBeenCalledWith(100, "SIGTERM");
    expect(killPid).toHaveBeenCalledWith(200, "SIGTERM");
    expect(killPid).not.toHaveBeenCalledWith(300, expect.anything());
  });

  it("reports no runaway processes found when there's nothing to target", async () => {
    const summary = await runDoctorClean(
      makeKillDeps({ listProcesses: async () => [] }),
      50,
      homeDir,
    );
    expect(summary.targeted).toEqual([]);
    expect(describeDoctorCleanSummary(summary)).toBe(
      "falcon doctor clean: no runaway processes found\n",
    );
  });

  it("also reaps a live journaled cloudflared tunnel (docs/features/dev-server-preview.md)", async () => {
    const { appendJournalEntry, readTunnelJournal } = await import("./tunnelRegistry.js");
    await appendJournalEntry(homeDir, { pid: 8000, port: 3000, startedAt: 1000 });

    const killPid = vi.fn();
    // pid 8000 (the tunnel): alive at reapOrphanedTunnels' pre-kill check,
    // then reports dead once its own waitForExit polls it after SIGTERM —
    // same pattern as tunnelRegistry.test.ts's own reap tests. Every other
    // pid (100/200, the daemon/session runaway-kill targets) stays `false`
    // throughout, matching this suite's original always-false convention.
    const aliveCallCounts = new Map<number, number>();
    const isAlive = vi.fn((pid: number) => {
      if (pid !== 8000) return false;
      const count = (aliveCallCounts.get(pid) ?? 0) + 1;
      aliveCallCounts.set(pid, count);
      return count === 1;
    });
    const summary = await runDoctorClean(
      makeKillDeps({
        killPid,
        isAlive,
        listProcesses: async () => [
          ...FIXTURE_PROCESSES,
          { pid: 8000, ppid: 1, command: "cloudflared tunnel --url http://localhost:3000" },
        ],
      }),
      50,
      homeDir,
    );

    // The runaway-process kill (daemon/daemon-spawned-session targets)
    // stays exactly as before — cloudflared reaping is an ADDITIONAL sweep,
    // not a replacement.
    expect(summary.targeted.map((p) => p.pid).sort()).toEqual([100, 200]);
    expect(killPid).toHaveBeenCalledWith(8000, "SIGTERM");
    expect(await readTunnelJournal(homeDir)).toEqual([]);
  });
});

describe("describeDoctorCleanSummary", () => {
  it("summarizes success/failure counts per pid", () => {
    const text = describeDoctorCleanSummary({
      targeted: [
        {
          pid: 100,
          ppid: 1,
          command: "falcon daemon start-sync",
          kind: "daemon",
          spawnedByDaemon: false,
        },
      ],
      outcomes: [
        { pid: 100, command: "falcon daemon start-sync", kind: "daemon", signal: "SIGTERM" },
      ],
    });

    expect(text).toContain("falcon doctor clean: 1/1 runaway process(es) terminated");
    expect(text).toContain("pid 100 [daemon] SIGTERM — falcon daemon start-sync");
  });
});
