import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectPath } from "../claude/scanner.js";
import type { SpawnFn } from "../daemon/processLauncher.js";
import { ResumeSessionError } from "../daemon/resumeSession.js";
import { writeDaemonState } from "../daemon/state.js";
import type { ResumeCommandDeps } from "./resume.js";
import { runResumeCommand } from "./resume.js";

/** Minimal fake `ChildProcess` — an EventEmitter with a `pid` (mirrors adopt.test.ts's FakeChild). */
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

function fakeRegistry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    findResumable: vi.fn(() => null),
    stopSession: vi.fn(() => false),
    getLivePid: vi.fn(() => null),
    trackSpawned: vi.fn(),
    ...overrides,
  };
}

describe("runResumeCommand", () => {
  let baseDir: string;
  let claudeConfigDir: string;
  let workspacePath: string;
  let projectDir: string;
  let homeDir: string;
  let env: NodeJS.ProcessEnv;
  let written: string[];

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `resume-cmd-test-${unique}`);
    claudeConfigDir = join(baseDir, "claude-home");
    workspacePath = join(baseDir, "project");
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-resume-cmd-home-"));
    env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    projectDir = getProjectPath(workspacePath, env);
    await mkdir(projectDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    written = [];
  });

  afterEach(async () => {
    if (existsSync(baseDir)) await rm(baseDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<ResumeCommandDeps> = {}): ResumeCommandDeps {
    return {
      homeDir,
      workingDirectory: workspacePath,
      env,
      write: (text: string) => {
        written.push(text);
      },
      ...overrides,
    };
  }

  describe("local resume", () => {
    it("spawns `claude --resume <id>` with inherited stdio when the id matches a local transcript", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));

      const spawnImpl: SpawnFn = vi.fn((command, args, options) => {
        expect(command).toBe("claude");
        expect(args).toEqual(["--resume", "sess-a"]);
        expect(options).toMatchObject({ cwd: workspacePath, stdio: "inherit" });
        const child = new FakeChild(123);
        queueMicrotask(() => child.emit("close", 0));
        return child as unknown as ChildProcess;
      });

      const code = await runResumeCommand("sess-a", baseDeps({ spawnImpl }));

      expect(code).toBe(0);
      expect(spawnImpl).toHaveBeenCalledOnce();
      expect(written.join("")).toContain("reattaching to local session sess-a");
    });

    it("propagates the child's non-zero exit code", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));
      const spawnImpl: SpawnFn = vi.fn(() => {
        const child = new FakeChild(123);
        queueMicrotask(() => child.emit("close", 7));
        return child as unknown as ChildProcess;
      });

      const code = await runResumeCommand("sess-a", baseDeps({ spawnImpl }));
      expect(code).toBe(7);
    });

    it("returns 1 and reports the failure when the spawn itself fails to launch", async () => {
      await writeFile(join(projectDir, "sess-a.jsonl"), userLine("hi"));
      const spawnImpl: SpawnFn = vi.fn(() => {
        const child = new FakeChild();
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child as unknown as ChildProcess;
      });

      const code = await runResumeCommand("sess-a", baseDeps({ spawnImpl }));
      expect(code).toBe(1);
      expect(written.join("")).toContain("failed to launch claude");
    });
  });

  describe("daemon-managed resume", () => {
    it("returns 1 with an honest message when the id is unknown locally and to the daemon", async () => {
      const code = await runResumeCommand("unknown-id", baseDeps());
      expect(code).toBe(1);
      expect(written.join("")).toContain("not tracked by this daemon");
    });

    it("calls resumeSession() and reports success for a persisted daemon-managed session", async () => {
      const launchProcess = vi.fn(async () => ({
        method: "detached" as const,
        pid: 555,
        watchExit: () => () => {},
      }));
      const registry = fakeRegistry({
        findResumable: vi.fn(() => ({
          sessionId: "sess_1",
          provider: "claude-code" as const,
          encryption: { encryptionKey: "k", seq: 1, metadataVersion: 1, agentStateVersion: 1 },
          savedAt: Date.now(),
          directory: workspacePath,
        })),
      });

      const code = await runResumeCommand(
        "sess_1",
        baseDeps({
          resumeSessionOverrides: {
            registry,
            awaiter: {
              waitFor: vi.fn(async (pid) => ({ sessionId: "sess_1", pid })),
              resolve: vi.fn(),
              reject: vi.fn(),
            },
            launchProcess,
            kvyEntrypoint: () => ["/usr/bin/node", "/opt/kvy/dist/index.mjs"],
          },
        }),
      );

      expect(code).toBe(0);
      expect(launchProcess).toHaveBeenCalledOnce();
      expect(written.join("")).toContain("resumed session sess_1");
    });

    it("relaunches into the session's own persisted directory, not the CLI invocation's cwd (known-issues.md: `kvy resume` ignores the persisted session directory)", async () => {
      // A directory distinct from `workspacePath` (the CLI's own cwd, per `baseDeps()` below) —
      // proves resume uses the SESSION's directory, not wherever `kvy resume` was run from.
      const sessionOwnDir = join(baseDir, "session-own-dir");
      await mkdir(sessionOwnDir, { recursive: true });
      const expectedCwd = await realpath(sessionOwnDir);

      const launchProcess = vi.fn(async () => ({
        method: "detached" as const,
        pid: 555,
        watchExit: () => () => {},
      }));
      const registry = fakeRegistry({
        findResumable: vi.fn(() => ({
          sessionId: "sess_1",
          provider: "claude-code" as const,
          encryption: { encryptionKey: "k", seq: 1, metadataVersion: 1, agentStateVersion: 1 },
          savedAt: Date.now(),
          directory: sessionOwnDir,
        })),
      });

      const code = await runResumeCommand(
        "sess_1",
        baseDeps({
          // workingDirectory (the CLI's own cwd) is `workspacePath` — deliberately
          // different from `sessionOwnDir` above.
          resumeSessionOverrides: {
            registry,
            awaiter: {
              waitFor: vi.fn(async (pid) => ({ sessionId: "sess_1", pid })),
              resolve: vi.fn(),
              reject: vi.fn(),
            },
            launchProcess,
            kvyEntrypoint: () => ["/usr/bin/node", "/opt/kvy/dist/index.mjs"],
          },
        }),
      );

      expect(code).toBe(0);
      expect(launchProcess).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: expectedCwd }),
        undefined,
      );
    });

    it("fails cleanly (does not fall back to the CLI's cwd) when the persisted session has no directory recorded", async () => {
      const launchProcess = vi.fn(async () => ({
        method: "detached" as const,
        pid: 555,
        watchExit: () => () => {},
      }));
      const registry = fakeRegistry({
        findResumable: vi.fn(() => ({
          sessionId: "sess_1",
          provider: "claude-code" as const,
          encryption: { encryptionKey: "k", seq: 1, metadataVersion: 1, agentStateVersion: 1 },
          savedAt: Date.now(),
          // no `directory` — an old, pre-persistence-fix sessions.json record.
        })),
      });

      const code = await runResumeCommand(
        "sess_1",
        baseDeps({
          resumeSessionOverrides: {
            registry,
            awaiter: { waitFor: vi.fn(), resolve: vi.fn(), reject: vi.fn() },
            launchProcess,
            kvyEntrypoint: () => ["/usr/bin/node", "/opt/kvy/dist/index.mjs"],
          },
        }),
      );

      expect(code).toBe(1);
      expect(launchProcess).not.toHaveBeenCalled();
      expect(written.join("")).toContain("could not resolve a working directory");
    });

    it("reports a ResumeSessionError's message and returns 1 on failure", async () => {
      const registry = fakeRegistry({
        findResumable: vi.fn(() => {
          throw new ResumeSessionError("boom");
        }),
      });

      const code = await runResumeCommand(
        "sess_1",
        baseDeps({ resumeSessionOverrides: { registry } }),
      );

      expect(code).toBe(1);
      expect(written.join("")).toContain("boom");
    });

    it("refuses (exit 1) without attempting resumeSession() when the running daemon already tracks the session live", async () => {
      await writeDaemonState(homeDir, { pid: 999999, port: 4242, version: "0.1.0", startedAt: 1 });

      const registry = fakeRegistry();
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sessions: [{ sessionId: "sess_1", pid: 999999, startedBy: "daemon" }],
            }),
            {
              status: 200,
            },
          ),
      );

      const code = await runResumeCommand(
        "sess_1",
        baseDeps({
          isProcessAlive: () => true,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          resumeSessionOverrides: { registry },
        }),
      );

      expect(code).toBe(1);
      expect(written.join("")).toContain("currently live-managed by the running daemon");
      expect(registry.findResumable).not.toHaveBeenCalled();
    });

    it("proceeds normally when a running daemon exists but does not track the session", async () => {
      await writeDaemonState(homeDir, { pid: 999999, port: 4242, version: "0.1.0", startedAt: 1 });

      const registry = fakeRegistry({
        findResumable: vi.fn(() => ({
          sessionId: "sess_1",
          provider: "claude-code" as const,
          encryption: { encryptionKey: "k", seq: 1, metadataVersion: 1, agentStateVersion: 1 },
          savedAt: Date.now(),
          directory: workspacePath,
        })),
      });
      const launchProcess = vi.fn(async () => ({
        method: "detached" as const,
        pid: 555,
        watchExit: () => () => {},
      }));
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
      );

      const code = await runResumeCommand(
        "sess_1",
        baseDeps({
          isProcessAlive: () => true,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          resumeSessionOverrides: {
            registry,
            awaiter: {
              waitFor: vi.fn(async (pid) => ({ sessionId: "sess_1", pid })),
              resolve: vi.fn(),
              reject: vi.fn(),
            },
            launchProcess,
            kvyEntrypoint: () => ["/usr/bin/node", "/opt/kvy/dist/index.mjs"],
          },
        }),
      );

      expect(code).toBe(0);
      expect(launchProcess).toHaveBeenCalledOnce();
    });
  });
});
