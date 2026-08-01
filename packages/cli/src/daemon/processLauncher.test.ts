import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { launchProviderProcess, type SpawnFn } from "./processLauncher.js";

/** Minimal fake `ChildProcess` — an EventEmitter with `stdout`/`stderr` streams and a `pid`. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined;

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  unref(): void {}
}

function baseOpts() {
  return {
    sessionLabel: "abc123",
    command: "kvy",
    args: ["claude", "--starting-mode", "remote"],
    cwd: "/tmp/proj",
    env: { PATH: "/usr/bin" },
  };
}

describe("launchProviderProcess", () => {
  it("prefers tmux: spawns new-session, then queries the pane pid", async () => {
    const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];

    const spawnImpl: SpawnFn = vi.fn((command, args, options) => {
      calls.push({ command, args, options });
      const child = new FakeChild();
      if (command === "tmux" && args[0] === "new-session") {
        queueMicrotask(() => child.emit("close", 0));
      } else if (command === "tmux" && args[0] === "list-panes") {
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("54321\n"));
          child.emit("close", 0);
        });
      }
      return child as unknown as ChildProcess;
    });

    const result = await launchProviderProcess(baseOpts(), { spawnImpl });

    expect(result).toMatchObject({ method: "tmux", pid: 54321, tmuxSessionName: "kvy-abc123" });
    expect(result.watchExit).toEqual(expect.any(Function));
    expect(calls[0]).toMatchObject({
      command: "tmux",
      args: [
        "new-session",
        "-d",
        "-s",
        "kvy-abc123",
        "--",
        "kvy",
        "claude",
        "--starting-mode",
        "remote",
      ],
    });
    expect(calls[1]).toMatchObject({
      command: "tmux",
      args: ["list-panes", "-t", "kvy-abc123", "-F", "#{pane_pid}"],
    });
  });

  it("falls back to a detached process when tmux is not installed (ENOENT)", async () => {
    const spawnImpl: SpawnFn = vi.fn((command) => {
      const child = new FakeChild(9999);
      if (command === "tmux") {
        queueMicrotask(() => {
          const error = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
          child.emit("error", error);
        });
      }
      return child as unknown as ChildProcess;
    });

    const result = await launchProviderProcess(baseOpts(), { spawnImpl });
    expect(result).toMatchObject({ method: "detached", pid: 9999 });
    expect(result.watchExit).toEqual(expect.any(Function));
  });

  it("throws when tmux exists but new-session fails for a real reason", async () => {
    const spawnImpl: SpawnFn = vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("duplicate session: kvy-abc123"));
        child.emit("close", 1);
      });
      return child as unknown as ChildProcess;
    });

    await expect(launchProviderProcess(baseOpts(), { spawnImpl })).rejects.toThrow(
      /tmux new-session exited 1/,
    );
  });

  it("throws when the detached fallback's command itself fails to spawn", async () => {
    const spawnImpl: SpawnFn = vi.fn((command) => {
      const child = new FakeChild();
      if (command === "tmux") {
        queueMicrotask(() => {
          const error = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
          child.emit("error", error);
        });
      } else {
        queueMicrotask(() => {
          const error = Object.assign(new Error("spawn kvy ENOENT"), { code: "ENOENT" });
          child.emit("error", error);
        });
      }
      return child as unknown as ChildProcess;
    });

    await expect(launchProviderProcess(baseOpts(), { spawnImpl })).rejects.toThrow(
      /failed to spawn "kvy"/,
    );
  });

  // A3/A4 (docs/known-issues.md — "generic 15s timeout masks the real
  // failure reason"): `spawnAwaiter.ts` needs a way to learn a launched
  // process died so it can reject fast instead of always waiting out the
  // full timeout. These prove the two `watchExit` implementations actually
  // observe an exit.
  describe("watchExit", () => {
    it("detached mode: fires with the real child exit code/signal via the actual Node 'exit' event", async () => {
      let capturedChild: FakeChild | undefined;
      const spawnImpl: SpawnFn = vi.fn((command) => {
        const child = new FakeChild(command === "tmux" ? undefined : 4242);
        if (command === "tmux") {
          queueMicrotask(() => {
            const error = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
            child.emit("error", error);
          });
        } else {
          capturedChild = child;
        }
        return child as unknown as ChildProcess;
      });

      const result = await launchProviderProcess(baseOpts(), { spawnImpl });
      expect(result.method).toBe("detached");

      const seen: unknown[] = [];
      result.watchExit((info) => seen.push(info));
      expect(seen).toEqual([]); // no exit observed yet

      capturedChild?.emit("exit", 1, null);
      expect(seen).toEqual([{ code: 1, signal: null }]);
    });

    it("detached mode: a late subscriber (after the child already exited) still gets notified", async () => {
      let capturedChild: FakeChild | undefined;
      const spawnImpl: SpawnFn = vi.fn((command) => {
        const child = new FakeChild(command === "tmux" ? undefined : 4242);
        if (command === "tmux") {
          queueMicrotask(() => {
            const error = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
            child.emit("error", error);
          });
        } else {
          capturedChild = child;
        }
        return child as unknown as ChildProcess;
      });

      const result = await launchProviderProcess(baseOpts(), { spawnImpl });
      capturedChild?.emit("exit", null, "SIGKILL");

      const seen = await new Promise((resolve) => {
        result.watchExit((info) => resolve(info));
      });
      expect(seen).toEqual({ code: null, signal: "SIGKILL" });
    });

    it("tmux mode: polls pid liveness and fires (code/signal both null — polling can only observe 'gone') once the pane process disappears", async () => {
      const spawnImpl: SpawnFn = vi.fn((command, args) => {
        const child = new FakeChild();
        if (command === "tmux" && args[0] === "new-session") {
          queueMicrotask(() => child.emit("close", 0));
        } else if (command === "tmux" && args[0] === "list-panes") {
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from("54321\n"));
            child.emit("close", 0);
          });
        }
        return child as unknown as ChildProcess;
      });

      let aliveCalls = 0;
      const isProcessAlive = vi.fn((pid: number) => {
        expect(pid).toBe(54321);
        aliveCalls += 1;
        return aliveCalls <= 2; // alive for the first two polls, gone on the third
      });

      const result = await launchProviderProcess(baseOpts(), {
        spawnImpl,
        isProcessAlive,
        tmuxExitPollIntervalMs: 5,
      });
      expect(result.method).toBe("tmux");

      const seen = await new Promise((resolve) => {
        result.watchExit((info) => resolve(info));
      });
      expect(seen).toEqual({ code: null, signal: null });
      expect(isProcessAlive).toHaveBeenCalledTimes(3);
    });
  });
});
