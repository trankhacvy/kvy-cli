import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdoptTakeParams, SpawnResult } from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivenessDeps } from "../adopt/liveness.js";
import { getProjectPath } from "../claude/scanner.js";
import { type AdoptTakeDeps, handleAdoptTake } from "./adoptTake.js";
import type { ResolvedProviderSession } from "./providerSessionResolver.js";

/** Fake clock: `sleep(ms)` advances the fake clock instead of waiting for real time (mirrors kill.test.ts). */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function baseParams(overrides: Partial<AdoptTakeParams> = {}): AdoptTakeParams {
  return {
    idempotencyKey: "idem_1",
    providerSessionId: "prov_1",
    mode: "takeover",
    ...overrides,
  };
}

describe("handleAdoptTake", () => {
  let baseDir: string;
  let claudeConfigDir: string;
  let workspacePath: string;
  let projectDir: string;
  let env: NodeJS.ProcessEnv;
  let resolved: ResolvedProviderSession;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `adopt-take-test-${unique}`);
    claudeConfigDir = join(baseDir, "claude-home");
    workspacePath = join(baseDir, "project");
    env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    projectDir = getProjectPath(workspacePath, env);
    await mkdir(projectDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    resolved = { workspaceId: "ws_1", directory: workspacePath };
    // Every test's target transcript exists so findOwningClaudeProcess's
    // "which file is newest" step has something to find.
    await writeFile(join(projectDir, "prov_1.jsonl"), "{}");
  });

  afterEach(async () => {
    if (existsSync(baseDir)) await rm(baseDir, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<AdoptTakeDeps> = {}): AdoptTakeDeps {
    const clock = fakeClock();
    return {
      resolveProviderSession: async () => resolved,
      spawnSession: vi.fn(async (): Promise<SpawnResult> => ({ sessionId: "sess_new" })),
      liveness: {
        listProcesses: async () => [],
        resolveProcessCwd: async () => null,
      } as LivenessDeps,
      killPid: vi.fn(),
      isAlive: () => false,
      sleep: clock.sleep,
      now: clock.now,
      gracefulTimeoutMs: 5000,
      env,
      ...overrides,
    };
  }

  it("throws when the provider session can't be resolved to a registered workspace", async () => {
    const deps = baseDeps({ resolveProviderSession: async () => null });
    await expect(handleAdoptTake(baseParams(), deps)).rejects.toThrow(/could not resolve/);
  });

  it("fork mode never signals a process, and spawns a continuation", async () => {
    const killPid = vi.fn();
    const deps = baseDeps({
      killPid,
      liveness: {
        listProcesses: async () => [{ pid: 5, ppid: 1, command: "claude" }],
        resolveProcessCwd: async () => workspacePath,
      },
    });

    const result = await handleAdoptTake(baseParams({ mode: "fork" }), deps);

    expect(killPid).not.toHaveBeenCalled();
    expect(result).toEqual({ sessionId: "sess_new" });
  });

  it("takeover mode is a no-op kill when no live process owns the transcript", async () => {
    const killPid = vi.fn();
    const deps = baseDeps({ killPid }); // default liveness: no processes at all

    const result = await handleAdoptTake(baseParams({ mode: "takeover" }), deps);

    expect(killPid).not.toHaveBeenCalled();
    expect(result).toEqual({ sessionId: "sess_new" });
  });

  it("takeover mode SIGTERMs the owning pid and reports a mid-turn warning when the transcript is live", async () => {
    const killPid = vi.fn();
    const deps = baseDeps({
      killPid,
      isAlive: () => false, // dies immediately on SIGTERM
      liveness: {
        listProcesses: async () => [{ pid: 77, ppid: 1, command: "claude" }],
        resolveProcessCwd: async () => workspacePath,
      },
    });

    const result = await handleAdoptTake(baseParams({ mode: "takeover" }), deps);

    expect(killPid).toHaveBeenCalledExactlyOnceWith(77, "SIGTERM");
    expect(result).toEqual({ sessionId: "sess_new", warning: expect.stringContaining("mid-turn") });
  });

  it("escalates to SIGKILL when the owning process ignores SIGTERM past the graceful timeout", async () => {
    const killPid = vi.fn();
    const deps = baseDeps({
      killPid,
      isAlive: () => true, // never dies on its own
      gracefulTimeoutMs: 500,
      liveness: {
        listProcesses: async () => [{ pid: 77, ppid: 1, command: "claude" }],
        resolveProcessCwd: async () => workspacePath,
      },
    });

    await handleAdoptTake(baseParams({ mode: "takeover" }), deps);

    expect(killPid).toHaveBeenCalledWith(77, "SIGTERM");
    expect(killPid).toHaveBeenCalledWith(77, "SIGKILL");
  });

  it("passes providerSessionId as continueFrom and the same idempotencyKey to spawnSession", async () => {
    const spawnSession = vi.fn(async (): Promise<SpawnResult> => ({ sessionId: "sess_new" }));
    const deps = baseDeps({ spawnSession });

    await handleAdoptTake(baseParams({ idempotencyKey: "idem_xyz" }), deps);

    expect(spawnSession).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: "idem_xyz",
      workspaceId: resolved.workspaceId,
      directory: resolved.directory,
      provider: "claude-code",
      permissionMode: "default",
      continueFrom: { providerSessionId: "prov_1" },
    });
  });

  it("propagates a spawnSession failure", async () => {
    const deps = baseDeps({
      spawnSession: vi.fn(async () => {
        throw new Error("workspace path rejected");
      }),
    });
    await expect(handleAdoptTake(baseParams(), deps)).rejects.toThrow("workspace path rejected");
  });
});
