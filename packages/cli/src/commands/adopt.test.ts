import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectPath } from "../claude/scanner.js";
import type { SpawnFn } from "../daemon/processLauncher.js";
import { readSettings } from "../persistence.js";
import { type AdoptCommandDeps, runAdoptCommand } from "./adopt.js";

/** Minimal fake `ChildProcess` — an EventEmitter with a `pid` (mirrors processLauncher.test.ts's FakeChild). */
class FakeChild extends EventEmitter {
  pid: number | undefined;
  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

function userLine(text: string, timestamp = "2026-01-01T00:00:00.000Z"): string {
  return `${JSON.stringify({ type: "user", uuid: "u1", timestamp, message: { role: "user", content: text } })}\n`;
}

describe("runAdoptCommand", () => {
  let baseDir: string;
  let claudeConfigDir: string;
  let workspacePath: string;
  let projectDir: string;
  let homeDir: string;
  let env: NodeJS.ProcessEnv;
  let written: string[];

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `adopt-cmd-test-${unique}`);
    claudeConfigDir = join(baseDir, "claude-home");
    workspacePath = join(baseDir, "project");
    homeDir = mkdtempSync(path.join(tmpdir(), "kvy-adopt-cmd-home-"));
    env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    projectDir = getProjectPath(workspacePath, env);
    await mkdir(projectDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    written = [];
  });

  afterEach(async () => {
    if (existsSync(baseDir)) await rm(baseDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<AdoptCommandDeps> = {}): AdoptCommandDeps {
    return {
      workingDirectory: workspacePath,
      env,
      persistenceOptions: { homeDir },
      write: (text: string) => {
        written.push(text);
      },
      ...overrides,
    };
  }

  it("reports no sessions and exits 0 when the project dir has nothing to adopt", async () => {
    const code = await runAdoptCommand({ list: false, remote: false }, baseDeps());
    expect(code).toBe(0);
    expect(written.join("")).toContain("no plain Claude Code sessions found");
  });

  it("--list prints every session, most recent first, without spawning anything", async () => {
    await writeFile(
      join(projectDir, "sess-old.jsonl"),
      userLine("old", "2026-01-01T00:00:00.000Z"),
    );
    await writeFile(
      join(projectDir, "sess-new.jsonl"),
      userLine("new", "2026-01-02T00:00:00.000Z"),
    );

    const spawnImpl = vi.fn();
    const code = await runAdoptCommand({ list: true, remote: false }, baseDeps({ spawnImpl }));

    expect(code).toBe(0);
    expect(spawnImpl).not.toHaveBeenCalled();
    const output = written.join("");
    expect(output.indexOf("sess-new")).toBeLessThan(output.indexOf("sess-old"));
  });

  describe("local (default) resume", () => {
    it("spawns `claude --resume <id>` with inherited stdio for the most recent session", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));

      const spawnImpl: SpawnFn = vi.fn((command, args, options) => {
        expect(command).toBe("claude");
        expect(args).toEqual(["--resume", "sess-a"]);
        expect(options).toMatchObject({ cwd: workspacePath, stdio: "inherit" });
        const child = new FakeChild(123);
        queueMicrotask(() => child.emit("close", 0));
        return child as unknown as ChildProcess;
      });

      const code = await runAdoptCommand({ list: false, remote: false }, baseDeps({ spawnImpl }));

      expect(code).toBe(0);
      expect(spawnImpl).toHaveBeenCalledOnce();
    });

    it("propagates the child's non-zero exit code", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));
      const spawnImpl: SpawnFn = vi.fn(() => {
        const child = new FakeChild(123);
        queueMicrotask(() => child.emit("close", 7));
        return child as unknown as ChildProcess;
      });

      const code = await runAdoptCommand({ list: false, remote: false }, baseDeps({ spawnImpl }));
      expect(code).toBe(7);
    });

    it("returns 1 when the spawn itself fails to launch", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));
      const spawnImpl: SpawnFn = vi.fn(() => {
        const child = new FakeChild();
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child as unknown as ChildProcess;
      });

      const code = await runAdoptCommand({ list: false, remote: false }, baseDeps({ spawnImpl }));
      expect(code).toBe(1);
    });

    it("detects the new session id minted by --resume and records old→new lineage", async () => {
      await writeFile(join(projectDir, "sess-old.jsonl"), userLine("hi"));

      const spawnImpl: SpawnFn = vi.fn(() => {
        const child = new FakeChild(123);
        queueMicrotask(async () => {
          // Simulate Claude Code minting a brand-new session file mid-run.
          await writeFile(join(projectDir, "sess-brand-new.jsonl"), userLine("continued"));
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      });

      const code = await runAdoptCommand({ list: false, remote: false }, baseDeps({ spawnImpl }));

      expect(code).toBe(0);
      expect(written.join("")).toContain("recorded lineage sess-old -> sess-brand-new");
      const settings = await readSettings({ homeDir });
      expect(settings.adoptedSessions?.["sess-old"]).toEqual(["sess-old", "sess-brand-new"]);
    });

    it("does not record lineage when no new session id appears (resume reused the same id)", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));
      const spawnImpl: SpawnFn = vi.fn(() => {
        const child = new FakeChild(123);
        queueMicrotask(() => child.emit("close", 0));
        return child as unknown as ChildProcess;
      });

      await runAdoptCommand({ list: false, remote: false }, baseDeps({ spawnImpl }));

      expect(written.join("")).not.toContain("recorded lineage");
      const settings = await readSettings({ homeDir });
      expect(settings.adoptedSessions ?? {}).toEqual({});
    });
  });

  describe("--remote", () => {
    it("launches a detached continuation via the process launcher instead of blocking on stdio", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));

      const launchProcess = vi.fn(async () => ({
        method: "tmux" as const,
        pid: 999,
        tmuxSessionName: "x",
        watchExit: () => () => {},
      }));
      const code = await runAdoptCommand(
        { list: false, remote: true },
        baseDeps({
          launchProcess,
          kvyEntrypoint: () => ["/usr/bin/node", "/opt/kvy/dist/index.mjs"],
        }),
      );

      expect(code).toBe(0);
      expect(launchProcess).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          command: "/usr/bin/node",
          args: expect.arrayContaining([
            "/opt/kvy/dist/index.mjs",
            "claude",
            "--starting-mode",
            "remote",
            "--started-by",
            "adopt",
            "--continue-from",
            "sess-a",
          ]),
          cwd: workspacePath,
        }),
        undefined,
      );
      expect(written.join("")).toContain("launched detached session (pid 999, tmux)");
    });

    it("returns 1 and reports the failure when the detached launch throws", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));
      const launchProcess = vi.fn(async () => {
        throw new Error("tmux exploded");
      });

      const code = await runAdoptCommand(
        { list: false, remote: true },
        baseDeps({
          launchProcess,
          kvyEntrypoint: () => ["/usr/bin/node", "/opt/kvy/dist/index.mjs"],
        }),
      );

      expect(code).toBe(1);
      expect(written.join("")).toContain("failed to launch");
    });
  });
});
