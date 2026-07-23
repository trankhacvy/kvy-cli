import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDirectoryRunState } from "./runStateStore.js";
import { runSetupScript, type SpawnFn } from "./setupScript.js";

let homeDir: string;
let workspaceRoot: string;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-setup-script-test-home-"));
  workspaceRoot = await realpath(
    mkdtempSync(path.join(tmpdir(), "falcon-setup-script-test-repo-")),
  );
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/** A minimal fake ChildProcess: an EventEmitter with stdout/stderr sub-emitters and a pid, driven manually by the test. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
}

async function setRunScriptConfig(setupScript: string | undefined): Promise<void> {
  const { setWorkspaceGitConfig } = await import("../workspaceConfig.js");
  if (setupScript !== undefined) {
    await setWorkspaceGitConfig(workspaceRoot, { setupScript }, { homeDir });
  }
}

describe("runSetupScript", () => {
  it("is a no-op when no setupScript is configured", async () => {
    const spawnImpl = vi.fn<SpawnFn>();
    const result = await runSetupScript(
      { workspaceRoot, directory: workspaceRoot },
      { homeDir, spawnImpl },
    );
    expect(result).toEqual({ started: false });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("spawns the configured script via a shell and records success on exit code 0", async () => {
    await setRunScriptConfig("npm install");
    const child = new FakeChild();
    const spawnImpl = vi.fn<SpawnFn>(() => child as never);

    const result = await runSetupScript(
      { workspaceRoot, directory: workspaceRoot },
      { homeDir, spawnImpl },
    );

    expect(result).toEqual({ started: true });
    expect(spawnImpl).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "npm install"],
      expect.objectContaining({ cwd: workspaceRoot }),
    );

    const runningState = await readDirectoryRunState(homeDir, workspaceRoot);
    expect(runningState?.setup?.state).toBe("running");
    expect(runningState?.setup?.pid).toBe(4242);

    child.stdout.emit("data", Buffer.from("installing...\n"));
    child.emit("close", 0);
    await vi.waitFor(async () => {
      const state = await readDirectoryRunState(homeDir, workspaceRoot);
      expect(state?.setup?.state).toBe("succeeded");
    });

    const finalState = await readDirectoryRunState(homeDir, workspaceRoot);
    expect(finalState?.setup?.exitCode).toBe(0);
    expect(finalState?.setup?.finishedAt).toBeDefined();

    expect(finalState?.setup?.logFile).toBeDefined();
    const logContents = readFileSync(finalState?.setup?.logFile as string, "utf8");
    expect(logContents).toContain("installing...");
  });

  it("records failed with the exit code on a non-zero exit", async () => {
    await setRunScriptConfig("npm run build");
    const child = new FakeChild();
    const spawnImpl = vi.fn<SpawnFn>(() => child as never);

    await runSetupScript({ workspaceRoot, directory: workspaceRoot }, { homeDir, spawnImpl });

    child.stderr.emit("data", Buffer.from("build failed\n"));
    child.emit("close", 1);

    await vi.waitFor(async () => {
      const state = await readDirectoryRunState(homeDir, workspaceRoot);
      expect(state?.setup?.state).toBe("failed");
    });
    const finalState = await readDirectoryRunState(homeDir, workspaceRoot);
    expect(finalState?.setup?.exitCode).toBe(1);
  });

  it("refuses to double-start while a setup is already running with a live pid", async () => {
    await setRunScriptConfig("npm install");
    const firstChild = new FakeChild();
    const spawnImpl = vi.fn<SpawnFn>(() => firstChild as never);
    const isAlive = vi.fn(() => true);

    const first = await runSetupScript(
      { workspaceRoot, directory: workspaceRoot },
      { homeDir, spawnImpl, isAlive },
    );
    expect(first).toEqual({ started: true });

    const second = await runSetupScript(
      { workspaceRoot, directory: workspaceRoot },
      { homeDir, spawnImpl, isAlive },
    );
    expect(second).toEqual({ started: false, alreadyRunning: true });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("allows a re-run once the previous run's pid is no longer alive (stale 'running' state)", async () => {
    await setRunScriptConfig("npm install");
    const firstChild = new FakeChild();
    const spawnImpl = vi.fn<SpawnFn>(() => firstChild as never);
    const isAlive = vi.fn(() => false);

    await runSetupScript(
      { workspaceRoot, directory: workspaceRoot },
      { homeDir, spawnImpl, isAlive },
    );
    // Simulate the daemon crashing before "close" ever fired — state stays
    // "running" in run-state.json with a pid that's no longer alive.
    const second = await runSetupScript(
      { workspaceRoot, directory: workspaceRoot },
      { homeDir, spawnImpl, isAlive },
    );

    expect(second).toEqual({ started: true });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it("never throws when spawnImpl itself throws synchronously, and records a failed state", async () => {
    await setRunScriptConfig("npm install");
    const spawnImpl = vi.fn<SpawnFn>(() => {
      throw new Error("ENOENT: sh not found");
    });

    const result = await runSetupScript(
      { workspaceRoot, directory: workspaceRoot },
      { homeDir, spawnImpl },
    );

    expect(result).toEqual({ started: false });
    const state = await readDirectoryRunState(homeDir, workspaceRoot);
    expect(state?.setup?.state).toBe("failed");
  });

  it("truncates a previous run's log file rather than appending to it", async () => {
    await setRunScriptConfig("npm install");
    const firstChild = new FakeChild();
    const spawnImpl = vi.fn<SpawnFn>(() => firstChild as never);

    await runSetupScript({ workspaceRoot, directory: workspaceRoot }, { homeDir, spawnImpl });
    firstChild.stdout.emit("data", Buffer.from("first run output\n"));
    firstChild.emit("close", 0);
    await vi.waitFor(async () => {
      const state = await readDirectoryRunState(homeDir, workspaceRoot);
      expect(state?.setup?.state).toBe("succeeded");
    });

    const secondChild = new FakeChild();
    spawnImpl.mockReturnValue(secondChild as never);
    await runSetupScript({ workspaceRoot, directory: workspaceRoot }, { homeDir, spawnImpl });

    const state = await readDirectoryRunState(homeDir, workspaceRoot);
    expect(state?.setup?.logFile).toBeDefined();
    const logContents = readFileSync(state?.setup?.logFile as string, "utf8");
    expect(logContents).not.toContain("first run output");
  });

  it("resolves setupScript from workspaceRoot's config even when directory is a different (worktree) path", async () => {
    await setRunScriptConfig("npm install");
    const worktreeDir = path.join(workspaceRoot, ".worktrees", "task-1");
    await mkdir(worktreeDir, { recursive: true });
    const child = new FakeChild();
    const spawnImpl = vi.fn<SpawnFn>(() => child as never);

    const result = await runSetupScript(
      { workspaceRoot, directory: worktreeDir },
      { homeDir, spawnImpl },
    );

    expect(result).toEqual({ started: true });
    expect(spawnImpl).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "npm install"],
      expect.objectContaining({ cwd: worktreeDir }),
    );
    // Keyed on `directory` (the worktree), not `workspaceRoot`.
    expect((await readDirectoryRunState(homeDir, workspaceRoot))?.setup).toBeUndefined();
    expect((await readDirectoryRunState(homeDir, worktreeDir))?.setup?.state).toBe("running");
  });
});
