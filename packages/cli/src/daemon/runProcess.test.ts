import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspace } from "../workspace/registry.js";
import { setWorkspaceGitConfig } from "../workspaceConfig.js";
import type { LaunchedProcess } from "./processLauncher.js";
import {
  handleRunSetup,
  handleRunStart,
  handleRunStatus,
  handleRunStop,
  type RunProcessDeps,
  RunProcessError,
  resolveRunContext,
} from "./runProcess.js";
import { readDirectoryRunState, updateDirectoryRunState } from "./runStateStore.js";

let homeDir: string;
let workspaceRoot: string;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-run-process-test-home-"));
  workspaceRoot = await realpath(mkdtempSync(path.join(tmpdir(), "falcon-run-process-test-repo-")));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<RunProcessDeps> = {}): RunProcessDeps {
  return { homeDir, ...overrides };
}

describe("resolveRunContext", () => {
  it("throws RunProcessError for a worktree outside every registered workspace", async () => {
    await expect(resolveRunContext(workspaceRoot, { homeDir })).rejects.toThrow(RunProcessError);
  });

  it("resolves the registered root as workspaceRoot and the real path as directoryKey", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const context = await resolveRunContext(workspaceRoot, { homeDir });
    expect(context.workspaceRoot).toBe(workspaceRoot);
    expect(context.directoryKey).toBe(workspaceRoot);
  });

  it("resolves a nested worktree directory to the containing workspace root", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const worktreeDir = path.join(workspaceRoot, ".worktrees", "task-1");
    await mkdir(worktreeDir, { recursive: true });

    const context = await resolveRunContext(worktreeDir, { homeDir });
    expect(context.workspaceRoot).toBe(workspaceRoot);
    expect(context.directoryKey).toBe(worktreeDir);
  });
});

describe("handleRunStart", () => {
  it("throws RunProcessError for an unregistered worktree", async () => {
    await expect(
      handleRunStart({ idempotencyKey: "k1", worktree: workspaceRoot }, baseDeps()),
    ).rejects.toThrow(RunProcessError);
  });

  it("throws RunProcessError when no runScript is configured", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await expect(
      handleRunStart({ idempotencyKey: "k1", worktree: workspaceRoot }, baseDeps()),
    ).rejects.toThrow(/no run script configured/);
  });

  it("launches via launchProcess and persists the run entry", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await setWorkspaceGitConfig(workspaceRoot, { runScript: "npm run dev" }, { homeDir });

    const launched: LaunchedProcess = {
      method: "tmux",
      pid: 555,
      tmuxSessionName: "falcon-run-x",
      watchExit: () => () => {},
    };
    const launchProcess = vi.fn(async () => launched);

    const result = await handleRunStart(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ launchProcess }),
    );

    expect(result).toEqual({
      started: true,
      method: "tmux",
      pid: 555,
      tmuxSessionName: "falcon-run-x",
    });
    expect(launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cwd: workspaceRoot }),
      undefined,
    );

    const state = await readDirectoryRunState(homeDir, workspaceRoot);
    expect(state?.run).toMatchObject({ pid: 555, method: "tmux", tmuxSessionName: "falcon-run-x" });
  });

  it("wraps the script with a log-redirect and builds it through /bin/sh -c on POSIX", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await setWorkspaceGitConfig(workspaceRoot, { runScript: "npm run dev" }, { homeDir });

    const launchProcess = vi.fn(async () => ({
      method: "detached" as const,
      pid: 1,
      watchExit: () => () => {},
    }));
    await handleRunStart(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ launchProcess, platform: "linux" }),
    );

    expect(launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: "/bin/sh",
        args: ["-c", expect.stringMatching(/^npm run dev >> '.*\.log' 2>&1$/)],
      }),
      undefined,
    );
  });

  it("returns alreadyRunning:true (and does not relaunch) when a live run entry already exists", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await setWorkspaceGitConfig(workspaceRoot, { runScript: "npm run dev" }, { homeDir });
    await updateDirectoryRunState(homeDir, workspaceRoot, {
      run: {
        pid: 999,
        method: "detached",
        startedAt: 1,
        logFile: path.join(homeDir, "logs", "run-x.log"),
        script: "npm run dev",
      },
    });

    const launchProcess = vi.fn(async () => ({
      method: "detached" as const,
      pid: 1234,
      watchExit: () => () => {},
    }));
    const isAlive = vi.fn(() => true);

    const result = await handleRunStart(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ launchProcess, isAlive }),
    );

    expect(result).toEqual({
      started: false,
      alreadyRunning: true,
      method: "detached",
      pid: 999,
      tmuxSessionName: undefined,
    });
    expect(launchProcess).not.toHaveBeenCalled();
  });

  it("relaunches when the persisted run entry's pid is no longer alive (stale entry)", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await setWorkspaceGitConfig(workspaceRoot, { runScript: "npm run dev" }, { homeDir });
    await updateDirectoryRunState(homeDir, workspaceRoot, {
      run: {
        pid: 999,
        method: "detached",
        startedAt: 1,
        logFile: path.join(homeDir, "logs", "run-x.log"),
        script: "npm run dev",
      },
    });

    const launchProcess = vi.fn(async () => ({
      method: "detached" as const,
      pid: 2222,
      watchExit: () => () => {},
    }));
    const isAlive = vi.fn(() => false);

    const result = await handleRunStart(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ launchProcess, isAlive }),
    );

    expect(result).toEqual({
      started: true,
      method: "detached",
      pid: 2222,
      tmuxSessionName: undefined,
    });
    expect(launchProcess).toHaveBeenCalledOnce();
  });
});

describe("handleRunStop", () => {
  it("throws RunProcessError for an unregistered worktree", async () => {
    await expect(
      handleRunStop({ idempotencyKey: "k1", worktree: workspaceRoot }, baseDeps()),
    ).rejects.toThrow(RunProcessError);
  });

  it("returns stopped:false wasRunning:false when nothing is tracked", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const result = await handleRunStop(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps(),
    );
    expect(result).toEqual({ stopped: false, wasRunning: false });
  });

  it("kills a live entry via killRunEntry and clears the persisted state", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await updateDirectoryRunState(homeDir, workspaceRoot, {
      run: {
        pid: 555,
        method: "tmux",
        tmuxSessionName: "falcon-run-x",
        startedAt: 1,
        logFile: path.join(homeDir, "logs", "run-x.log"),
        script: "npm run dev",
      },
    });

    const killRunEntry = vi.fn(async () => {});
    const isAlive = vi.fn(() => true);
    const probeTmuxSession = vi.fn(async () => true);

    const result = await handleRunStop(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ killRunEntry, isAlive, probeTmuxSession }),
    );

    expect(result).toEqual({ stopped: true, wasRunning: true });
    expect(killRunEntry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pid: 555, tmuxSessionName: "falcon-run-x" }),
    );
    expect((await readDirectoryRunState(homeDir, workspaceRoot))?.run).toBeUndefined();
  });

  it("clears a stale (dead) entry without invoking killRunEntry, and reports wasRunning:false", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await updateDirectoryRunState(homeDir, workspaceRoot, {
      run: {
        pid: 555,
        method: "detached",
        startedAt: 1,
        logFile: path.join(homeDir, "logs", "run-x.log"),
        script: "npm run dev",
      },
    });

    const killRunEntry = vi.fn(async () => {});
    const isAlive = vi.fn(() => false);

    const result = await handleRunStop(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ killRunEntry, isAlive }),
    );

    expect(result).toEqual({ stopped: false, wasRunning: false });
    expect(killRunEntry).not.toHaveBeenCalled();
    expect((await readDirectoryRunState(homeDir, workspaceRoot))?.run).toBeUndefined();
  });
});

describe("handleRunStatus", () => {
  it("throws RunProcessError for an unregistered worktree", async () => {
    await expect(
      handleRunStatus({ idempotencyKey: "k1", worktree: workspaceRoot }, baseDeps()),
    ).rejects.toThrow(RunProcessError);
  });

  it("reports run:none / setup:not-run when nothing has ever run", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const result = await handleRunStatus(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps(),
    );
    expect(result).toEqual({ run: { state: "none" }, setup: { state: "not-run" } });
  });

  it("reports run:running with pid/method/startedAt/logTail when the entry is live", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const logFile = path.join(homeDir, "logs", "run-x.log");
    await mkdir(path.dirname(logFile), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(logFile, "server listening on :3000\n", "utf8");

    await updateDirectoryRunState(homeDir, workspaceRoot, {
      run: { pid: 555, method: "detached", startedAt: 42, logFile, script: "npm run dev" },
    });

    const isAlive = vi.fn(() => true);
    const result = await handleRunStatus(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ isAlive }),
    );

    expect(result.run).toEqual({
      state: "running",
      pid: 555,
      method: "detached",
      startedAt: 42,
      logTail: "server listening on :3000\n",
    });
  });

  it("reports run:stopped (with a logTail, but no pid) when the persisted entry is dead", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const logFile = path.join(homeDir, "logs", "run-x.log");
    await mkdir(path.dirname(logFile), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(logFile, "crashed\n", "utf8");

    await updateDirectoryRunState(homeDir, workspaceRoot, {
      run: { pid: 555, method: "detached", startedAt: 42, logFile, script: "npm run dev" },
    });

    const isAlive = vi.fn(() => false);
    const result = await handleRunStatus(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ isAlive }),
    );

    expect(result.run.state).toBe("stopped");
    expect(result.run.logTail).toBe("crashed\n");
    expect(result.run.pid).toBeUndefined();
  });

  it("reports the persisted setup entry's state/exitCode/logTail", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const logFile = path.join(homeDir, "logs", "setup-x.log");
    await mkdir(path.dirname(logFile), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(logFile, "installed 42 packages\n", "utf8");

    await updateDirectoryRunState(homeDir, workspaceRoot, {
      setup: { state: "succeeded", exitCode: 0, startedAt: 1, finishedAt: 2, logFile },
    });

    const result = await handleRunStatus(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps(),
    );

    expect(result.setup).toEqual({
      state: "succeeded",
      exitCode: 0,
      startedAt: 1,
      finishedAt: 2,
      logTail: "installed 42 packages\n",
    });
  });

  it("tolerates a missing log file (logTail undefined, no throw)", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await updateDirectoryRunState(homeDir, workspaceRoot, {
      run: {
        pid: 1,
        method: "detached",
        startedAt: 1,
        logFile: path.join(homeDir, "logs", "does-not-exist.log"),
        script: "x",
      },
    });
    const isAlive = vi.fn(() => true);

    const result = await handleRunStatus(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ isAlive }),
    );
    expect(result.run.logTail).toBeUndefined();
  });
});

describe("handleRunSetup", () => {
  it("throws RunProcessError for an unregistered worktree", async () => {
    await expect(
      handleRunSetup({ idempotencyKey: "k1", worktree: workspaceRoot }, baseDeps()),
    ).rejects.toThrow(RunProcessError);
  });

  it("delegates to setupScript.ts's runner, keyed on the resolved worktree", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await setWorkspaceGitConfig(workspaceRoot, { setupScript: "npm install" }, { homeDir });

    class FakeChild extends EventEmitter {
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      pid = 777;
    }
    const child = new FakeChild();
    const setupSpawnImpl = vi.fn(() => child as never);

    const result = await handleRunSetup(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ setupSpawnImpl }),
    );

    expect(result).toEqual({ started: true });
    expect(setupSpawnImpl).toHaveBeenCalledExactlyOnceWith(
      "/bin/sh",
      ["-c", "npm install"],
      expect.objectContaining({ cwd: workspaceRoot }),
    );
    const state = await readDirectoryRunState(homeDir, workspaceRoot);
    expect(state?.setup?.state).toBe("running");
  });

  it("returns {started:false} when no setupScript is configured (not an error)", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const result = await handleRunSetup(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps(),
    );
    expect(result).toEqual({ started: false });
  });
});

describe("daemon-restart durability (a fresh runStateStore read over the same homeDir)", () => {
  it("run.status after a simulated restart still sees and can act on the persisted run entry", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const launchProcess = vi.fn(async () => ({
      method: "tmux" as const,
      pid: 321,
      tmuxSessionName: "falcon-run-y",
      watchExit: () => () => {},
    }));
    await setWorkspaceGitConfig(workspaceRoot, { runScript: "npm run dev" }, { homeDir });
    await handleRunStart(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      baseDeps({ launchProcess }),
    );

    // "Restart": nothing but a fresh call against the same on-disk state —
    // this module holds no other in-memory registry to lose.
    const probeTmuxSession = vi.fn(async () => true);
    const status = await handleRunStatus(
      { idempotencyKey: "k2", worktree: workspaceRoot },
      baseDeps({ probeTmuxSession }),
    );
    expect(status.run).toMatchObject({ state: "running", pid: 321, method: "tmux" });

    const killRunEntry = vi.fn(async () => {});
    const stopResult = await handleRunStop(
      { idempotencyKey: "k3", worktree: workspaceRoot },
      baseDeps({ killRunEntry, probeTmuxSession }),
    );
    expect(stopResult).toEqual({ stopped: true, wasRunning: true });
  });
});
