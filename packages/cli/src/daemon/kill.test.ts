import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKillDeps,
  describeKillSummary,
  killAll,
  killAllForce,
  killDaemon,
  killSessions,
  type KillDeps,
} from "./kill.js";
import type { ProcessEntry } from "./processScan.js";

const FIXTURE_PROCESSES: ProcessEntry[] = [
  { pid: 1, ppid: 0, command: "/sbin/launchd" },
  { pid: 100, ppid: 1, command: "falcon daemon start-sync" },
  { pid: 200, ppid: 100, command: "falcon claude --starting-mode remote --started-by daemon" },
  { pid: 300, ppid: 1, command: "falcon claude --resume abc" },
  { pid: 999, ppid: 1, command: "falcon kill all" }, // the invoking process
];

/** Builds a fake clock + no-op sleep pair: `sleep(ms)` advances the fake clock instead of waiting for real time. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function makeDeps(overrides: Partial<KillDeps> = {}): KillDeps {
  const clock = fakeClock();
  return {
    listProcesses: async () => FIXTURE_PROCESSES,
    killPid: vi.fn(),
    isAlive: () => false, // default: everything dies immediately on SIGTERM
    sleep: clock.sleep,
    now: clock.now,
    currentPid: 999,
    ...overrides,
  };
}

describe("killDaemon", () => {
  it("targets only the daemon process and sends SIGTERM", async () => {
    const deps = makeDeps();
    const summary = await killDaemon(deps);

    expect(summary.targeted.map((t) => t.pid)).toEqual([100]);
    expect(deps.killPid).toHaveBeenCalledTimes(1);
    expect(deps.killPid).toHaveBeenCalledWith(100, "SIGTERM");
    expect(summary.outcomes).toEqual([
      { pid: 100, command: "falcon daemon start-sync", kind: "daemon", signal: "SIGTERM" },
    ]);
  });

  it("escalates to SIGKILL when the daemon ignores SIGTERM past the timeout", async () => {
    const deps = makeDeps({ isAlive: () => true }); // never dies on its own
    const summary = await killDaemon(deps, 500);

    expect(deps.killPid).toHaveBeenNthCalledWith(1, 100, "SIGTERM");
    expect(deps.killPid).toHaveBeenNthCalledWith(2, 100, "SIGKILL");
    expect(summary.outcomes).toEqual([
      { pid: 100, command: "falcon daemon start-sync", kind: "daemon", signal: "SIGKILL" },
    ]);
  });
});

describe("killSessions", () => {
  it("targets only session processes, excluding the daemon and the current process", async () => {
    const deps = makeDeps();
    const summary = await killSessions(deps);

    expect(summary.targeted.map((t) => t.pid).sort()).toEqual([200, 300]);
    expect(deps.killPid).toHaveBeenCalledWith(200, "SIGTERM");
    expect(deps.killPid).toHaveBeenCalledWith(300, "SIGTERM");
    expect(deps.killPid).not.toHaveBeenCalledWith(100, expect.anything());
  });

  it("reports no matching processes without erroring when nothing is found", async () => {
    const deps = makeDeps({ listProcesses: async () => [] });
    const summary = await killSessions(deps);
    expect(summary.targeted).toEqual([]);
    expect(summary.outcomes).toEqual([]);
  });
});

describe("killAll", () => {
  it("targets both the daemon and session processes", async () => {
    const deps = makeDeps();
    const summary = await killAll(deps);
    expect(summary.targeted.map((t) => t.pid).sort()).toEqual([100, 200, 300]);
  });

  it("records a failure outcome instead of throwing when killPid errors", async () => {
    const deps = makeDeps({
      killPid: vi.fn((pid: number, signal) => {
        if (pid === 100 && signal === "SIGTERM") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }),
    });
    const summary = await killAll(deps);
    const daemonOutcome = summary.outcomes.find((o) => o.pid === 100);
    expect(daemonOutcome).toEqual({
      pid: 100,
      command: "falcon daemon start-sync",
      kind: "daemon",
      signal: "none",
      error: "EPERM",
    });
  });
});

describe("killAllForce", () => {
  it("sends SIGKILL immediately without waiting, even to processes that are still alive", async () => {
    const deps = makeDeps({ isAlive: () => true });
    const summary = await killAllForce(deps);

    expect(summary.targeted.map((t) => t.pid).sort()).toEqual([100, 200, 300]);
    for (const call of (deps.killPid as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toBe("SIGKILL");
    }
    expect(summary.outcomes.every((o) => o.signal === "SIGKILL")).toBe(true);
  });
});

describe("killAll outcome ordering", () => {
  it("preserves target order in outcomes even when some SIGTERMs fail and others succeed", async () => {
    // pid 200 is the *middle* target (targeted order is [100, 200, 300]);
    // making its SIGTERM fail while 100 and 300 succeed proves outcomes stay
    // index-aligned with `targeted` rather than being grouped by which pass
    // (immediate SIGTERM failure vs. post-graceful-wait resolution) produced
    // them.
    const deps = makeDeps({
      killPid: vi.fn((pid: number, signal) => {
        if (pid === 200 && signal === "SIGTERM") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }),
    });
    const summary = await killAll(deps);

    expect(summary.targeted.map((t) => t.pid)).toEqual([100, 200, 300]);
    // outcomes[i] corresponds to targeted[i], regardless of which target's
    // SIGTERM failed.
    expect(summary.outcomes.map((o) => o.pid)).toEqual([100, 200, 300]);
    expect(summary.outcomes[1]).toMatchObject({ pid: 200, signal: "none", error: "EPERM" });
  });
});

describe("createKillDeps default isAlive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats ESRCH as dead", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(createKillDeps().isAlive(12345)).toBe(false);
  });

  it("treats EPERM (permission denied on the liveness probe) as alive, not dead", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    expect(createKillDeps().isAlive(12345)).toBe(true);
  });

  it("treats an unrecognized error as alive (fail safe, don't skip SIGKILL escalation)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("something unexpected");
    });
    expect(createKillDeps().isAlive(12345)).toBe(true);
  });
});

describe("describeKillSummary", () => {
  it("reports 'no matching processes' when nothing was targeted", () => {
    expect(describeKillSummary("sessions", { targeted: [], outcomes: [] })).toBe(
      "falcon kill sessions: no matching processes found\n",
    );
  });

  it("summarizes success and failure counts with per-pid detail", () => {
    const text = describeKillSummary("daemon", {
      targeted: [{ pid: 100, ppid: 1, command: "falcon daemon start-sync", kind: "daemon", spawnedByDaemon: false }],
      outcomes: [
        { pid: 100, command: "falcon daemon start-sync", kind: "daemon", signal: "SIGTERM" },
      ],
    });
    expect(text).toContain("falcon kill daemon: 1/1 process(es) terminated");
    expect(text).toContain("pid 100 [daemon] SIGTERM — falcon daemon start-sync");
  });
});
