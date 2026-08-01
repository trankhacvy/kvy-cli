import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProcesses, resolveProcessCwd } from "./processScan.js";
import { findLiveOrphanedSessions, type ReadoptProbeDeps } from "./readoptSessions.js";
import type { PersistedSession } from "./sessionsStore.js";

const ENCRYPTION = {
  encryptionKey: "wrapped-dek",
  seq: 1,
  metadataVersion: 1,
  agentStateVersion: 1,
};

function fixture(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    sessionId: "sess_1",
    encryption: ENCRYPTION,
    savedAt: Date.now(),
    directory: "/Users/vy/projects/kvy",
    pid: 4242,
    ...overrides,
  };
}

const identityRealpath = (p: string) => Promise.resolve(p);

function baseDeps(overrides: Partial<ReadoptProbeDeps> = {}): ReadoptProbeDeps {
  return {
    listProcesses: async () => [
      { pid: 4242, ppid: 1, command: "kvy claude --starting-mode remote --started-by daemon" },
    ],
    resolveCwd: async () => "/Users/vy/projects/kvy",
    realpath: identityRealpath,
    ...overrides,
  };
}

describe("findLiveOrphanedSessions", () => {
  it("returns [] immediately (without listing processes) when no persisted record has both a pid and a directory", async () => {
    const listProcesses = vi.fn(async () => {
      throw new Error("should never be called");
    });
    const result = await findLiveOrphanedSessions(
      { sess_1: fixture({ pid: undefined }) },
      baseDeps({ listProcesses }),
    );
    expect(result).toEqual([]);
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("skips a record with pid 0 (falsy/never-a-real-pid sentinel) without listing processes", async () => {
    const listProcesses = vi.fn(async () => {
      throw new Error("should never be called");
    });
    const result = await findLiveOrphanedSessions(
      { sess_1: fixture({ pid: 0 }) },
      baseDeps({ listProcesses }),
    );
    expect(result).toEqual([]);
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("skips a record with a live pid but no persisted directory, without listing processes", async () => {
    const listProcesses = vi.fn(async () => {
      throw new Error("should never be called");
    });
    const result = await findLiveOrphanedSessions(
      { sess_1: fixture({ directory: undefined }) },
      baseDeps({ listProcesses }),
    );
    expect(result).toEqual([]);
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("re-adopts a session whose pid is alive, classifies as a kvy session, and whose cwd matches the persisted directory", async () => {
    const session = fixture();
    const result = await findLiveOrphanedSessions({ sess_1: session }, baseDeps());
    expect(result).toEqual([{ sessionId: "sess_1", session, pid: 4242 }]);
  });

  it("skips a session whose pid is no longer alive (not present in the process scan)", async () => {
    const result = await findLiveOrphanedSessions(
      { sess_1: fixture() },
      baseDeps({ listProcesses: async () => [] }),
    );
    expect(result).toEqual([]);
  });

  it("skips a recycled pid now occupied by a non-kvy process", async () => {
    const result = await findLiveOrphanedSessions(
      { sess_1: fixture() },
      baseDeps({
        listProcesses: async () => [{ pid: 4242, ppid: 1, command: "/usr/bin/some-other-tool" }],
      }),
    );
    expect(result).toEqual([]);
  });

  it("skips a recycled pid now occupied by a kvy process that isn't a session (e.g. the daemon itself)", async () => {
    const result = await findLiveOrphanedSessions(
      { sess_1: fixture() },
      baseDeps({
        listProcesses: async () => [{ pid: 4242, ppid: 1, command: "kvy daemon start-sync" }],
      }),
    );
    expect(result).toEqual([]);
  });

  it("skips when the live pid's cwd can't be resolved at all", async () => {
    const result = await findLiveOrphanedSessions(
      { sess_1: fixture() },
      baseDeps({ resolveCwd: async () => null }),
    );
    expect(result).toEqual([]);
  });

  it("skips when the live pid's cwd resolves to a different directory than persisted", async () => {
    const result = await findLiveOrphanedSessions(
      { sess_1: fixture() },
      baseDeps({ resolveCwd: async () => "/Users/vy/projects/some-other-repo" }),
    );
    expect(result).toEqual([]);
  });

  it("canonicalizes both directories via realpath before comparing (symlink-transparent match)", async () => {
    const session = fixture({ directory: "/Users/vy/link-to-kvy" });
    const realpath = async (p: string) =>
      p === "/Users/vy/link-to-kvy" || p === "/Users/vy/projects/kvy"
        ? "/Users/vy/projects/kvy"
        : p;
    const result = await findLiveOrphanedSessions(
      { sess_1: session },
      baseDeps({ realpath, resolveCwd: async () => "/Users/vy/projects/kvy" }),
    );
    expect(result).toEqual([{ sessionId: "sess_1", session, pid: 4242 }]);
  });

  it("skips a session whose persisted directory no longer resolves (deleted/unmounted) rather than throwing", async () => {
    const realpath = async (p: string) => {
      if (p === "/Users/vy/projects/kvy") throw new Error("ENOENT");
      return p;
    };
    const result = await findLiveOrphanedSessions({ sess_1: fixture() }, baseDeps({ realpath }));
    expect(result).toEqual([]);
  });

  it("evaluates multiple candidates independently, re-adopting only the ones that verify", async () => {
    const persisted = {
      sess_alive: fixture({ sessionId: "sess_alive", pid: 100, directory: "/Users/vy/repo-a" }),
      sess_dead: fixture({ sessionId: "sess_dead", pid: 200, directory: "/Users/vy/repo-b" }),
      sess_no_pid: fixture({ sessionId: "sess_no_pid", pid: undefined }),
    };
    const result = await findLiveOrphanedSessions(
      persisted,
      baseDeps({
        listProcesses: async () => [
          {
            pid: 100,
            ppid: 1,
            command: "kvy claude --starting-mode remote --started-by daemon",
          },
        ],
        resolveCwd: async (pid) => (pid === 100 ? "/Users/vy/repo-a" : null),
      }),
    );
    expect(result).toEqual([{ sessionId: "sess_alive", session: persisted.sess_alive, pid: 100 }]);
  });
});

/**
 * Real-process black-box coverage (not a fake `listProcesses`/`resolveCwd`):
 * a fake probe proves the wiring but not real `ps`/`lsof` discovery — exactly
 * the gap that let an earlier, in-memory-only version of Flow 3's fix pass
 * unit tests while still failing against a genuinely orphaned live process.
 * This spawns a real child whose argv classifies as a kvy `session`
 * (`kvy claude --starting-mode remote --started-by daemon`) in a real
 * directory, then runs `findLiveOrphanedSessions` against the actual
 * `processScan.ts` implementations.
 */
describe("findLiveOrphanedSessions (real process discovery)", () => {
  let dir: string;
  let child: ReturnType<typeof spawn>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kvy-readopt-"));
    child = spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => {}, 60000)",
        "kvy",
        "claude",
        "--starting-mode",
        "remote",
        "--started-by",
        "daemon",
      ],
      { cwd: dir, stdio: "ignore" },
    );
    await new Promise((resolve) => setTimeout(resolve, 100)); // let it actually start running
  });

  afterEach(async () => {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.on("exit", () => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("re-adopts a genuinely live orphaned session process discovered via real ps/lsof", async () => {
    const pid = child.pid;
    if (pid === undefined) throw new Error("failed to spawn helper process");

    const result = await findLiveOrphanedSessions(
      {
        sess_1: {
          sessionId: "sess_1",
          encryption: ENCRYPTION,
          savedAt: Date.now(),
          directory: dir,
          pid,
        },
      },
      { listProcesses, resolveCwd: resolveProcessCwd },
    );

    expect(result).toEqual([
      {
        sessionId: "sess_1",
        session: expect.objectContaining({ sessionId: "sess_1", pid }),
        pid,
      },
    ]);
  });

  it("does not re-adopt once the real process has actually exited", async () => {
    const pid = child.pid;
    if (pid === undefined) throw new Error("failed to spawn helper process");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const result = await findLiveOrphanedSessions(
      {
        sess_1: {
          sessionId: "sess_1",
          encryption: ENCRYPTION,
          savedAt: Date.now(),
          directory: dir,
          pid,
        },
      },
      { listProcesses, resolveCwd: resolveProcessCwd },
    );

    expect(result).toEqual([]);
  });
});
