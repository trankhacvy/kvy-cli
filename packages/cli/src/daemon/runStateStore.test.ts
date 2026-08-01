import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRunEntry,
  clearRunStateFile,
  readDirectoryRunState,
  readRunState,
  runStateFilePath,
  updateDirectoryRunState,
} from "./runStateStore.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-run-state-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("readRunState", () => {
  it("returns {} when the file doesn't exist", async () => {
    expect(await readRunState(homeDir)).toEqual({});
  });

  it("returns {} for a corrupt (non-JSON) file, never throwing", async () => {
    writeFileSync(runStateFilePath(homeDir), "not json{{{");
    expect(await readRunState(homeDir)).toEqual({});
  });

  it("drops a malformed entry but keeps well-formed siblings", async () => {
    writeFileSync(
      runStateFilePath(homeDir),
      JSON.stringify({
        schemaVersion: 1,
        directories: {
          "/repo/good": {
            run: {
              pid: 123,
              method: "tmux",
              tmuxSessionName: "kvy-run-abc",
              startedAt: 1,
              logFile: "/logs/run-abc.log",
              script: "npm run dev",
            },
          },
          "/repo/bad": { run: { pid: "not-a-number" } },
        },
      }),
    );

    const result = await readRunState(homeDir);
    expect(Object.keys(result)).toEqual(["/repo/good"]);
  });
});

describe("updateDirectoryRunState / readDirectoryRunState", () => {
  it("persists a run entry and reads it back", async () => {
    const merged = await updateDirectoryRunState(homeDir, "/repo/a", {
      run: {
        pid: 111,
        method: "detached",
        startedAt: 1000,
        logFile: "/logs/run-a.log",
        script: "npm run dev",
      },
    });

    expect(merged.run?.pid).toBe(111);
    expect(await readDirectoryRunState(homeDir, "/repo/a")).toEqual(merged);
  });

  it("merges run and setup independently — updating one leaves the other intact", async () => {
    await updateDirectoryRunState(homeDir, "/repo/a", {
      setup: { state: "running", startedAt: 1, logFile: "/logs/setup-a.log" },
    });
    const merged = await updateDirectoryRunState(homeDir, "/repo/a", {
      run: { pid: 222, method: "tmux", startedAt: 2, logFile: "/logs/run-a.log", script: "x" },
    });

    expect(merged.setup?.state).toBe("running");
    expect(merged.run?.pid).toBe(222);
  });

  it("keeps two directories' entries independent", async () => {
    await updateDirectoryRunState(homeDir, "/repo/a", {
      run: { pid: 1, method: "tmux", startedAt: 1, logFile: "/logs/a.log", script: "a" },
    });
    await updateDirectoryRunState(homeDir, "/repo/b", {
      run: { pid: 2, method: "tmux", startedAt: 2, logFile: "/logs/b.log", script: "b" },
    });

    expect((await readDirectoryRunState(homeDir, "/repo/a"))?.run?.pid).toBe(1);
    expect((await readDirectoryRunState(homeDir, "/repo/b"))?.run?.pid).toBe(2);
  });

  it("readDirectoryRunState returns undefined for an unknown directory", async () => {
    expect(await readDirectoryRunState(homeDir, "/repo/unknown")).toBeUndefined();
  });

  it("survives a fresh read after a simulated daemon restart (new calls, same homeDir)", async () => {
    await updateDirectoryRunState(homeDir, "/repo/a", {
      run: {
        pid: 999,
        method: "tmux",
        tmuxSessionName: "kvy-run-x",
        startedAt: 1,
        logFile: "/logs/a.log",
        script: "npm run dev",
      },
    });

    // A "restart" here is just a fresh call against the same on-disk file —
    // this module holds no other in-memory state to reset.
    const reread = await readDirectoryRunState(homeDir, "/repo/a");
    expect(reread?.run?.pid).toBe(999);
    expect(reread?.run?.tmuxSessionName).toBe("kvy-run-x");
  });
});

describe("clearRunEntry", () => {
  it("removes only the run entry, leaving setup intact", async () => {
    await updateDirectoryRunState(homeDir, "/repo/a", {
      run: { pid: 1, method: "tmux", startedAt: 1, logFile: "/logs/a.log", script: "x" },
      setup: {
        state: "succeeded",
        exitCode: 0,
        startedAt: 1,
        finishedAt: 2,
        logFile: "/logs/s.log",
      },
    });

    await clearRunEntry(homeDir, "/repo/a");

    const result = await readDirectoryRunState(homeDir, "/repo/a");
    expect(result?.run).toBeUndefined();
    expect(result?.setup?.state).toBe("succeeded");
  });

  it("is a no-op when there's nothing to clear", async () => {
    await expect(clearRunEntry(homeDir, "/repo/never-touched")).resolves.toBeUndefined();
  });
});

describe("clearRunStateFile", () => {
  it("deletes the file; a no-op if it doesn't exist", async () => {
    await updateDirectoryRunState(homeDir, "/repo/a", {
      run: { pid: 1, method: "tmux", startedAt: 1, logFile: "/logs/a.log", script: "x" },
    });
    await clearRunStateFile(homeDir);
    expect(await readRunState(homeDir)).toEqual({});
    await expect(clearRunStateFile(homeDir)).resolves.toBeUndefined();
  });
});

describe("concurrent writes to the same homeDir", () => {
  it("two overlapping updates for different directories both land (serialized, not lost)", async () => {
    await Promise.all([
      updateDirectoryRunState(homeDir, "/repo/a", {
        run: { pid: 1, method: "tmux", startedAt: 1, logFile: "/logs/a.log", script: "a" },
      }),
      updateDirectoryRunState(homeDir, "/repo/b", {
        run: { pid: 2, method: "tmux", startedAt: 2, logFile: "/logs/b.log", script: "b" },
      }),
    ]);

    const all = await readRunState(homeDir);
    expect(all["/repo/a"]?.run?.pid).toBe(1);
    expect(all["/repo/b"]?.run?.pid).toBe(2);
  });
});
