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
    command: "falcon",
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

    expect(result).toEqual({ method: "tmux", pid: 54321, tmuxSessionName: "falcon-abc123" });
    expect(calls[0]).toMatchObject({
      command: "tmux",
      args: [
        "new-session",
        "-d",
        "-s",
        "falcon-abc123",
        "--",
        "falcon",
        "claude",
        "--starting-mode",
        "remote",
      ],
    });
    expect(calls[1]).toMatchObject({
      command: "tmux",
      args: ["list-panes", "-t", "falcon-abc123", "-F", "#{pane_pid}"],
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
    expect(result).toEqual({ method: "detached", pid: 9999 });
  });

  it("throws when tmux exists but new-session fails for a real reason", async () => {
    const spawnImpl: SpawnFn = vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("duplicate session: falcon-abc123"));
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
          const error = Object.assign(new Error("spawn falcon ENOENT"), { code: "ENOENT" });
          child.emit("error", error);
        });
      }
      return child as unknown as ChildProcess;
    });

    await expect(launchProviderProcess(baseOpts(), { spawnImpl })).rejects.toThrow(
      /failed to spawn "falcon"/,
    );
  });
});
