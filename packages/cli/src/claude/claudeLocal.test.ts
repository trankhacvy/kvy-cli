import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  claudeLocal,
  type ClaudeLocalDeps,
  type ClaudeLocalOptions,
  ExitCodeError,
  FALCON_SYSTEM_PROMPT,
} from "./claudeLocal.js";

interface FakeChild {
  child: ChildProcess;
  fd3: PassThrough;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  emitError: (error: Error) => void;
}

/** Minimal EventEmitter-based stand-in for a `cross-spawn` `ChildProcess`. */
function createFakeChild(withFd3 = true): FakeChild {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  const fd3 = new PassThrough();
  (emitter as unknown as { stdio: unknown[] }).stdio = [
    null,
    null,
    null,
    withFd3 ? fd3 : null,
  ];
  return {
    child: emitter,
    fd3,
    emitExit: (code, signal) => emitter.emit("exit", code, signal),
    emitError: (error) => emitter.emit("error", error),
  };
}

function noopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function baseOptions(overrides: Partial<ClaudeLocalOptions> = {}): ClaudeLocalOptions {
  return {
    abort: new AbortController().signal,
    sessionId: null,
    workingDirectory: "/tmp/some-project",
    claudeArgs: [],
    onSessionFound: vi.fn(),
    ...overrides,
  };
}

function buildDeps(
  spawnImpl: (command: string, args: string[], options: SpawnOptions) => ChildProcess,
  overrides: Partial<ClaudeLocalDeps> = {},
): ClaudeLocalDeps {
  return {
    launcherPath: "/fake/pkg/scripts/falcon_claude_launcher.cjs",
    spawnImpl,
    findLastSession: () => null,
    logger: noopLogger(),
    env: {},
    ...overrides,
  };
}

describe("claudeLocal", () => {
  let stdinHandle: { setBlocking: ReturnType<typeof vi.fn> };
  let originalHandle: unknown;
  let pauseSpy: ReturnType<typeof vi.spyOn>;
  let resumeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalHandle = (process.stdin as unknown as { _handle?: unknown })._handle;
    stdinHandle = { setBlocking: vi.fn() };
    (process.stdin as unknown as { _handle?: unknown })._handle = stdinHandle;
    pauseSpy = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    resumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
  });

  afterEach(() => {
    (process.stdin as unknown as { _handle?: unknown })._handle = originalHandle;
    pauseSpy.mockRestore();
    resumeSpy.mockRestore();
    vi.useRealTimers();
  });

  describe("stdin blocking fix", () => {
    it("pauses stdin, forces the handle to blocking mode before spawn, and resumes after", async () => {
      const { child, emitExit } = createFakeChild(false);
      const spawnImpl = vi.fn(() => {
        // Assert blocking was already forced by the time spawn is called.
        expect(stdinHandle.setBlocking).toHaveBeenCalledWith(true);
        expect(pauseSpy).toHaveBeenCalled();
        return child;
      });

      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      emitExit(0, null);
      await promise;

      expect(resumeSpy).toHaveBeenCalled();
    });

    it("does not throw when the stdin handle has no setBlocking method", async () => {
      (process.stdin as unknown as { _handle?: unknown })._handle = {};
      const { child, emitExit } = createFakeChild(false);
      const spawnImpl = vi.fn(() => child);

      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      emitExit(0, null);
      await expect(promise).resolves.toBeDefined();
    });
  });

  describe("spawn shape", () => {
    it("spawns node with the launcher path and inherit/inherit/inherit/pipe stdio, cwd/env/signal wired through", async () => {
      const { child, emitExit } = createFakeChild(false);
      const abort = new AbortController();
      let capturedArgs: string[] = [];
      let capturedOptions: SpawnOptions = {};
      const spawnImpl = vi.fn((_command, args, options) => {
        capturedArgs = args;
        capturedOptions = options;
        return child;
      });

      const promise = claudeLocal(
        baseOptions({ workingDirectory: "/work/dir", abort: abort.signal, claudeEnvVars: { FOO: "bar" } }),
        buildDeps(spawnImpl, { env: { BASE: "1" } }),
      );
      emitExit(0, null);
      await promise;

      expect(spawnImpl).toHaveBeenCalledWith(
        "node",
        expect.arrayContaining(["/fake/pkg/scripts/falcon_claude_launcher.cjs"]),
        expect.any(Object),
      );
      expect(capturedArgs[0]).toBe("/fake/pkg/scripts/falcon_claude_launcher.cjs");
      expect(capturedOptions.stdio).toEqual(["inherit", "inherit", "inherit", "pipe"]);
      expect(capturedOptions.cwd).toBe("/work/dir");
      expect(capturedOptions.signal).toBe(abort.signal);
      expect(capturedOptions.env).toMatchObject({ BASE: "1", FOO: "bar" });
    });

    it("injects --append-system-prompt with the default Falcon prompt", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });

      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      emitExit(0, null);
      await promise;

      const idx = capturedArgs.indexOf("--append-system-prompt");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(capturedArgs[idx + 1]).toBe(FALCON_SYSTEM_PROMPT);
    });
  });

  describe("session-flag interception", () => {
    it("extracts --session-id and re-injects it, calling onSessionFound synchronously (offline mode)", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });
      const onSessionFound = vi.fn();

      const promise = claudeLocal(
        baseOptions({ claudeArgs: ["--session-id", "11111111-1111-1111-1111-111111111111"], onSessionFound }),
        buildDeps(spawnImpl),
      );
      emitExit(0, null);
      const result = await promise;

      expect(onSessionFound).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
      expect(result).toBe("11111111-1111-1111-1111-111111111111");
      const idx = capturedArgs.indexOf("--session-id");
      expect(capturedArgs[idx + 1]).toBe("11111111-1111-1111-1111-111111111111");
      // The original flag/value pair must not appear twice.
      expect(capturedArgs.filter((a) => a === "--session-id")).toHaveLength(1);
    });

    it("extracts --resume <id> and re-injects it as --resume <id>", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });

      const promise = claudeLocal(
        baseOptions({ claudeArgs: ["--resume", "session-abc", "--verbose"] }),
        buildDeps(spawnImpl),
      );
      emitExit(0, null);
      await promise;

      const idx = capturedArgs.indexOf("--resume");
      expect(capturedArgs[idx + 1]).toBe("session-abc");
      expect(capturedArgs).toContain("--verbose");
      expect(capturedArgs.filter((a) => a === "--resume")).toHaveLength(1);
    });

    it("-r <id> (short alias) is extracted and re-injected as --resume <id>, without calling findLastSession", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });
      const findLastSession = vi.fn(() => "unused");

      const promise = claudeLocal(
        baseOptions({ claudeArgs: ["-r", "short-alias-session"] }),
        buildDeps(spawnImpl, { findLastSession }),
      );
      emitExit(0, null);
      await promise;

      expect(findLastSession).not.toHaveBeenCalled();
      expect(capturedArgs).not.toContain("-r");
      const idx = capturedArgs.indexOf("--resume");
      expect(capturedArgs[idx + 1]).toBe("short-alias-session");
    });

    it("bare --resume (no id, nothing follows) never calls findLastSession — left for Claude Code's own picker", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });
      const findLastSession = vi.fn(() => "should-not-be-used");

      const promise = claudeLocal(
        baseOptions({ claudeArgs: ["--resume"] }),
        buildDeps(spawnImpl, { findLastSession }),
      );
      emitExit(0, null);
      await promise;

      expect(findLastSession).not.toHaveBeenCalled();
      expect(capturedArgs.filter((a) => a === "--resume")).toHaveLength(1);
      expect(capturedArgs).not.toContain("--session-id");
    });

    it("bare --resume with no last session leaves the flag for Claude Code to handle itself", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });

      const promise = claudeLocal(
        baseOptions({ claudeArgs: ["--resume"] }),
        buildDeps(spawnImpl, { findLastSession: () => null }),
      );
      emitExit(0, null);
      await promise;

      // --resume (bare, no value) must still be present exactly once, and
      // --session-id must NOT have been synthesized since Claude Code will
      // handle the bare --resume itself (e.g. its interactive picker).
      expect(capturedArgs.filter((a) => a === "--resume")).toHaveLength(1);
      expect(capturedArgs).not.toContain("--session-id");
    });

    it("--continue resolves against findLastSession and re-injects --resume <id>", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });

      const promise = claudeLocal(
        baseOptions({ claudeArgs: ["--continue"] }),
        buildDeps(spawnImpl, { findLastSession: () => "continued-session" }),
      );
      emitExit(0, null);
      await promise;

      expect(capturedArgs).not.toContain("--continue");
      const idx = capturedArgs.indexOf("--resume");
      expect(capturedArgs[idx + 1]).toBe("continued-session");
    });

    it("with no session flags and no prior sessionId, mints a new UUID and passes --session-id (offline mode)", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });
      const onSessionFound = vi.fn();

      const promise = claudeLocal(baseOptions({ onSessionFound }), buildDeps(spawnImpl));
      emitExit(0, null);
      const result = await promise;

      expect(onSessionFound).toHaveBeenCalledTimes(1);
      const mintedId = onSessionFound.mock.calls[0]?.[0] as string;
      expect(mintedId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result).toBe(mintedId);
      const idx = capturedArgs.indexOf("--session-id");
      expect(capturedArgs[idx + 1]).toBe(mintedId);
    });

    it("uses opts.sessionId as startFrom when no flags override it, without minting a new id", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });
      const onSessionFound = vi.fn();

      const promise = claudeLocal(
        baseOptions({ sessionId: "prior-session", onSessionFound }),
        buildDeps(spawnImpl),
      );
      emitExit(0, null);
      const result = await promise;

      expect(onSessionFound).toHaveBeenCalledWith("prior-session");
      expect(result).toBe("prior-session");
      const idx = capturedArgs.indexOf("--resume");
      expect(capturedArgs[idx + 1]).toBe("prior-session");
    });
  });

  describe("hook mode (--settings)", () => {
    it("adds --settings <path>, adds --resume when startFrom is known, and never calls onSessionFound itself", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });
      const onSessionFound = vi.fn();

      const promise = claudeLocal(
        baseOptions({ sessionId: "resume-me", hookSettingsPath: "/tmp/hooks/settings.json", onSessionFound }),
        buildDeps(spawnImpl),
      );
      emitExit(0, null);
      const result = await promise;

      expect(onSessionFound).not.toHaveBeenCalled();
      const settingsIdx = capturedArgs.indexOf("--settings");
      expect(capturedArgs[settingsIdx + 1]).toBe("/tmp/hooks/settings.json");
      const resumeIdx = capturedArgs.indexOf("--resume");
      expect(capturedArgs[resumeIdx + 1]).toBe("resume-me");
      expect(capturedArgs).not.toContain("--session-id");
      expect(result).toBe("resume-me");
    });

    it("fresh start in hook mode: no --resume/--session-id injected, result is null", async () => {
      const { child, emitExit } = createFakeChild(false);
      let capturedArgs: string[] = [];
      const spawnImpl = vi.fn((_c, args) => {
        capturedArgs = args;
        return child;
      });

      const promise = claudeLocal(
        baseOptions({ hookSettingsPath: "/tmp/hooks/settings.json" }),
        buildDeps(spawnImpl),
      );
      emitExit(0, null);
      const result = await promise;

      expect(capturedArgs).not.toContain("--resume");
      expect(capturedArgs).not.toContain("--session-id");
      expect(result).toBeNull();
    });
  });

  describe("exit-code and abort-signal handling", () => {
    it("resolves cleanly on exit code 0", async () => {
      const { child, emitExit } = createFakeChild(false);
      const spawnImpl = vi.fn(() => child);
      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      emitExit(0, null);
      await expect(promise).resolves.not.toThrow();
    });

    it("rejects with ExitCodeError on a non-zero exit code", async () => {
      const { child, emitExit } = createFakeChild(false);
      const spawnImpl = vi.fn(() => child);
      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      emitExit(3, null);
      await expect(promise).rejects.toBeInstanceOf(ExitCodeError);
      await expect(promise).rejects.toMatchObject({ exitCode: 3 });
    });

    it("resolves cleanly on SIGTERM when the abort signal is aborted (clean shutdown)", async () => {
      const { child, emitExit } = createFakeChild(false);
      const spawnImpl = vi.fn(() => child);
      const abort = new AbortController();
      const promise = claudeLocal(baseOptions({ abort: abort.signal }), buildDeps(spawnImpl));
      abort.abort();
      emitExit(null, "SIGTERM");
      await expect(promise).resolves.not.toThrow();
    });

    it("rejects on SIGTERM when the abort signal was NOT aborted (unexpected termination)", async () => {
      const { child, emitExit } = createFakeChild(false);
      const spawnImpl = vi.fn(() => child);
      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      emitExit(null, "SIGTERM");
      await expect(promise).rejects.toThrow(/SIGTERM/);
    });

    it("rejects on other signals", async () => {
      const { child, emitExit } = createFakeChild(false);
      const spawnImpl = vi.fn(() => child);
      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      emitExit(null, "SIGINT");
      await expect(promise).rejects.toThrow(/SIGINT/);
    });

    it("rejects with the spawn error when the child emits 'error' and never exits (e.g. ENOENT)", async () => {
      const { child, emitError } = createFakeChild(false);
      const spawnImpl = vi.fn(() => child);
      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      const spawnError = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
      emitError(spawnError);
      await expect(promise).rejects.toBe(spawnError);
    });

    it("does not double-settle when both 'error' and 'exit' fire", async () => {
      const { child, emitError, emitExit } = createFakeChild(false);
      const spawnImpl = vi.fn(() => child);
      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));
      const spawnError = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
      emitError(spawnError);
      emitExit(null, null);
      await expect(promise).rejects.toBe(spawnError);
    });
  });

  describe("thinking state machine (fd 3)", () => {
    it("turns thinking on immediately on fetch-start and off after the 500ms debounce once all fetches end", async () => {
      vi.useFakeTimers();
      const { child, fd3, emitExit } = createFakeChild(true);
      const spawnImpl = vi.fn(() => child);
      const onThinkingChange = vi.fn();

      const promise = claudeLocal(baseOptions({ onThinkingChange }), buildDeps(spawnImpl));

      fd3.write(`${JSON.stringify({ type: "fetch-start", id: 1, hostname: "x", path: "/y", timestamp: 1 })}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(onThinkingChange).toHaveBeenCalledWith(true);

      fd3.write(`${JSON.stringify({ type: "fetch-end", id: 1, timestamp: 2 })}\n`);
      await vi.advanceTimersByTimeAsync(0);
      // Not yet flipped off — debounce still pending.
      expect(onThinkingChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(onThinkingChange).toHaveBeenCalledWith(false);
      expect(onThinkingChange).toHaveBeenCalledTimes(2);

      emitExit(0, null);
      await promise;
    });

    it("does not flip thinking off if a new fetch starts during the debounce window", async () => {
      vi.useFakeTimers();
      const { child, fd3, emitExit } = createFakeChild(true);
      const spawnImpl = vi.fn(() => child);
      const onThinkingChange = vi.fn();

      const promise = claudeLocal(baseOptions({ onThinkingChange }), buildDeps(spawnImpl));

      fd3.write(`${JSON.stringify({ type: "fetch-start", id: 1, hostname: "x", path: "/y", timestamp: 1 })}\n`);
      await vi.advanceTimersByTimeAsync(0);
      fd3.write(`${JSON.stringify({ type: "fetch-end", id: 1, timestamp: 2 })}\n`);
      await vi.advanceTimersByTimeAsync(200);
      // New fetch arrives before the 500ms debounce elapses.
      fd3.write(`${JSON.stringify({ type: "fetch-start", id: 2, hostname: "x", path: "/z", timestamp: 3 })}\n`);
      await vi.advanceTimersByTimeAsync(400);

      expect(onThinkingChange).toHaveBeenCalledTimes(1);
      expect(onThinkingChange).toHaveBeenCalledWith(true);

      fd3.write(`${JSON.stringify({ type: "fetch-end", id: 2, timestamp: 4 })}\n`);
      await vi.advanceTimersByTimeAsync(500);
      expect(onThinkingChange).toHaveBeenCalledTimes(2);
      expect(onThinkingChange).toHaveBeenLastCalledWith(false);

      emitExit(0, null);
      await promise;
    });

    it("forces thinking off on child exit even mid-debounce", async () => {
      vi.useFakeTimers();
      const { child, fd3, emitExit } = createFakeChild(true);
      const spawnImpl = vi.fn(() => child);
      const onThinkingChange = vi.fn();

      const promise = claudeLocal(baseOptions({ onThinkingChange }), buildDeps(spawnImpl));

      fd3.write(`${JSON.stringify({ type: "fetch-start", id: 1, hostname: "x", path: "/y", timestamp: 1 })}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(onThinkingChange).toHaveBeenLastCalledWith(true);

      emitExit(0, null);
      await promise;

      expect(onThinkingChange).toHaveBeenLastCalledWith(false);
    });

    it("ignores non-JSON lines on fd3 without throwing", async () => {
      const { child, fd3, emitExit } = createFakeChild(true);
      const spawnImpl = vi.fn(() => child);
      const promise = claudeLocal(baseOptions(), buildDeps(spawnImpl));

      fd3.write("not json at all\n");
      await new Promise((r) => setTimeout(r, 10));

      emitExit(0, null);
      await expect(promise).resolves.not.toThrow();
    });
  });
});
